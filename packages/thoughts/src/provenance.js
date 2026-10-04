/**
 * The poisoning guard (T-297): every persistent node says which session and which model produced
 * it, so a bad run can be traced and revoked as a whole. A model that persists its own wrong
 * conclusion reads it back as fact each later session (docs/10-THOUGHT-GRAPH.md, "The failure mode").
 *
 * The model is read from the session log: the last `request/header` (`data.header.config`
 * `{provider, model}`) before the `tool/result` that carries the node. Unknown stays 'unknown', so a
 * revoke by model still finds it. Operator-written nodes (`/think add`) carry no model.
 *
 * Revocation removes the matching nodes (edges to them too, via `forget`) and every pending
 * conflict they took part in; the caller appends the full removed entries to an audit file, so a
 * revoke is recoverable by hand.
 * @module @finess/thoughts/provenance
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { recordOf } from './fold.js'
import { pendingConflicts } from './conflicts.js'
import { forget } from './store.js'

/** @typedef {import('./store.js').ProjectRecord} ProjectRecord */
/** @typedef {import('./envelope.js').StoredNode} StoredNode */
/** @typedef {import('./envelope.js').Origin} Origin */

/** Shortest session prefix a revoke accepts: one letter must not wipe the store. */
export const MIN_SESSION_PREFIX = 4
export const UNKNOWN_MODEL = 'unknown'

/**
 * Which model produced each ephemeral node in a log.
 * @param {Iterable<unknown>} events - session events, in append order.
 * @returns {Map<string, string>} node id -> `provider/model` (or 'unknown'); a later task's
 *   reused id overwrites an earlier one, as the fold does.
 */
export function nodeModels(events) {
  const out = new Map()
  let current = UNKNOWN_MODEL
  for (const e of events) {
    if (e?.type === 'request/header') {
      const c = e.data?.header?.config
      if (typeof c?.model === 'string' && c.model !== '') current = typeof c.provider === 'string' && c.provider !== '' ? `${c.provider}/${c.model}` : c.model
      continue
    }
    const node = recordOf(e)
    if (node !== undefined) out.set(node.id, current)
  }
  return out
}

/** @param {string} s @returns {string} a session id without the substrate's `session-` prefix. */
const bare = s => String(s).replace(/^session-/, '')

/**
 * One line of provenance.
 * @param {StoredNode} s - a stored entry.
 * @returns {string} e.g. `origin: model deepseek/v3, session 1a2b3c4d, from n-2, stored 2026-...`.
 */
export function originLine(s) {
  const o = s.origin
  return [
    `  origin: ${o.by === 'model' ? `model ${o.model ?? UNKNOWN_MODEL}` : 'operator'}`,
    ...(o.session === undefined ? [] : [`session ${bare(o.session).slice(0, 12)}`]),
    ...(o.from === undefined ? [] : [`from ${o.from}`]),
    `stored ${s.storedAt}`,
  ].join(', ')
}

/**
 * What a revoke token matches, in order: an exact `p-<k>` id; else, among model-written nodes, a
 * session prefix (at least MIN_SESSION_PREFIX characters, `session-` ignored on both sides) or a
 * model (exact `provider/model` or bare model name). A token matching both a session and a model is
 * refused as ambiguous.
 * @param {ProjectRecord} r - the project.
 * @param {string} token - `<id|session-prefix|model>`.
 * @returns {{match: 'id'|'session'|'model', test: (s: StoredNode) => boolean}} the matcher, or throws.
 */
export function revokeMatcher(r, token) {
  const t = String(token ?? '').trim()
  if (t === '') throw new Error('revoke what? an id (p-3), a session prefix or a model')
  if (/^p-[1-9][0-9]*$/.test(t)) return { match: 'id', test: s => s.node.id === t }
  const bySession = s => {
    const b = bare(t)
    return s.origin.by === 'model' && b.length >= MIN_SESSION_PREFIX && s.origin.session !== undefined && bare(s.origin.session).startsWith(b)
  }
  const byModel = s => {
    const m = s.origin.model ?? UNKNOWN_MODEL
    return s.origin.by === 'model' && (m === t || (m.includes('/') && m.slice(m.indexOf('/') + 1) === t))
  }
  const all = [...r.nodes, ...pendingConflicts(r).map(c => c.entry)]
  const ses = all.some(bySession)
  const mod = all.some(byModel)
  if (ses && mod) throw new Error(`"${t}" matches both a session and a model; use a longer session prefix or provider/model`)
  if (ses) return { match: 'session', test: bySession }
  if (mod) return { match: 'model', test: byModel }
  if (bare(t).length < MIN_SESSION_PREFIX) throw new Error(`"${t}" matches nothing (a session prefix needs at least ${MIN_SESSION_PREFIX} characters)`)
  throw new Error(`"${t}" matches no model-written persistent node or pending conflict`)
}

/**
 * Revoke: remove every matching node (and edges to it) and every pending conflict whose incoming
 * node matches or whose target is removed.
 * @param {ProjectRecord} r - the project.
 * @param {string} token - see {@link revokeMatcher}.
 * @returns {{record: ProjectRecord, match: string, removed: StoredNode[], dropped: import('./envelope.js').Conflict[]}} the result.
 */
export function revoke(r, token) {
  const { match, test } = revokeMatcher(r, token)
  const removed = r.nodes.filter(test)
  let record = r
  for (const s of removed) record = forget(record, s.node.id)
  const gone = new Set(removed.map(s => s.node.id))
  const dropped = pendingConflicts(r).filter(c => test(c.entry) || gone.has(c.against))
  if (dropped.length > 0) record = { ...record, conflicts: pendingConflicts(r).filter(c => !dropped.includes(c)) }
  if (removed.length === 0 && dropped.length === 0) throw new Error(`"${token}" matches nothing`)
  return { record, match, removed, dropped }
}

/**
 * The audit log of destructive thought-store operations. Outside `$DSH_HOME/storages/`, which
 * belongs to storage-json.
 * @param {string} dshHome - `$DSH_HOME`.
 * @returns {string} the JSONL file.
 */
export const auditFile = dshHome => join(dshHome, 'finess', 'thoughts-audit.jsonl')

/**
 * Append one audit line.
 * @param {string} file - the audit file.
 * @param {object} entry - what happened; `at` is set by the caller.
 * @returns {void}
 */
export function appendAudit(file, entry) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
}
