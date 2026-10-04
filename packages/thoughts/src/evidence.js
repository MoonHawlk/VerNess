/**
 * The evidence rule (T-287): `confidence: "verified"` holds only when the node's evidence names
 * something the model READ IN THE SAME TURN - a non-error `tool/result` of `read`, `grep` or
 * `web_fetch`, paired with its `tool/call` by `message.toolCallId`. Structural, from the log: the
 * model's word is never enough. A node that fails is downgraded to `asserted` with a reason (never
 * silently, never refused: the claim may still be worth keeping).
 *
 * What "names" means, per evidence token (an entry is split on whitespace; `:42`, `:3-9`, `#L5`
 * suffixes are dropped):
 * - read      the token is the file read: equal after normalising, or a cwd-relative / trailing
 *             path of it (`src/a.ts` names `C:/proj/src/a.ts`).
 * - grep      the token names the searched path the same way, or appears in the grep's output.
 * - web_fetch the token is the fetched URL (fragment and trailing slash ignored).
 * A path token must contain `/` or `.`, so plain words never match.
 *
 * Seams (upstream deepseek-harness): `tool/call {turn, callId, name, arguments}` and
 * `tool/result {turn, message: {toolCallId, isError, content}}`, packages/core/session/src/types.ts:361,375;
 * `toolCallId`, packages/llm/llm/src/message.ts:177. Tool parameter names: read `file_path`
 * (fs/tool-fs/src/read.ts:81), grep `path` (fs/tool-fs-search/src/grep.ts:290), web_fetch `url`
 * (web/tool-web/src/fetch.ts:457).
 * @module @finess/thoughts/evidence
 */

import { isForkCut, isTaskStart } from './fold.js'

/** The tools whose results count as reading, and the argument that names what was read. */
export const READ_TOOLS = Object.freeze({ read: 'file_path', grep: 'path', web_fetch: 'url' })

/**
 * @typedef {import('./schema.js').ThoughtNode} ThoughtNode
 * @typedef {{tool: string, target: string, text: string}} Read one successful read in a turn.
 */

/** @param {unknown} s @returns {object} parsed JSON arguments, or {} when they are not an object. */
function args(s) {
  try { const v = JSON.parse(String(s)); return typeof v === 'object' && v !== null ? v : {} } catch { return {} }
}

/** @param {unknown} content @returns {string} the text blocks joined. */
const textOf = content => (Array.isArray(content) ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '')

/**
 * The events of the current task segment: after the last direct human prompt or fork cut.
 * @param {unknown[]} events - the session log.
 * @returns {unknown[]} the tail.
 */
export function taskSegment(events) {
  let from = 0
  events.forEach((e, i) => { if (isTaskStart(e) || isForkCut(e)) from = i })
  return events.slice(from)
}

/**
 * Every successful read of `turn` in the current task segment, in log order. A call whose result
 * is not yet logged (a parallel call in the same step) did not happen yet.
 * @param {unknown[]} events - the session log (live snapshot or decoded JSONL).
 * @param {number|null} turn - the turn.
 * @returns {Read[]} the reads.
 */
export function turnReads(events, turn) {
  if (!Number.isSafeInteger(turn)) return []
  const calls = new Map()
  const out = []
  for (const e of taskSegment(events)) {
    if (e?.data?.turn !== turn) continue
    if (e.type === 'tool/call' && Object.hasOwn(READ_TOOLS, e.data.name)) calls.set(e.data.callId, { tool: e.data.name, target: String(args(e.data.arguments)[READ_TOOLS[e.data.name]] ?? '') })
    if (e.type === 'tool/result') {
      const m = e.data.message
      const c = calls.get(m?.toolCallId)
      if (c === undefined || m.isError === true) continue
      calls.delete(m.toolCallId)
      out.push({ ...c, text: textOf(m.content) })
    }
  }
  return out
}

/** @param {string} p @returns {string} forward slashes, no `./` or trailing slash; drive paths lower-cased. */
export function normPath(p) {
  let s = String(p).trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  if (/^[A-Za-z]:\//.test(s)) s = s.toLowerCase()
  return s
}

const isAbs = s => s.startsWith('/') || /^[a-z]:\//i.test(s)
const isUrl = s => /^https?:\/\//i.test(s)
const normUrl = u => String(u).trim().replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase()

/** @param {string} token @returns {string} the token without quotes, trailing punctuation or a line suffix. */
export function pointerOf(token) {
  let t = token.replace(/^[`'"(<[]+|[`'")>\],;]+$/g, '')
  if (isUrl(t)) return t
  return t.replace(/#L\d+(-L?\d+)?$/, '').replace(/(:\d+){1,2}(-\d+)?$/, '')
}

/**
 * Whether path `p` names `target` (both as written; `cwd` resolves relative ones).
 * @param {string} p - the evidence pointer.
 * @param {string} target - the read path.
 * @param {string} cwd - the session working directory.
 * @returns {boolean} a match.
 */
function samePath(p, target, cwd) {
  const abs = s => normPath(isAbs(normPath(s)) ? s : `${cwd}/${s}`)
  const t = abs(target)
  const ci = /^[a-z]:\//.test(t)
  const q = ci ? normPath(p).toLowerCase() : normPath(p)
  if (q === '') return false
  return abs(p) === t || (!isAbs(q) && t.endsWith(`/${q}`))
}

/**
 * Whether one evidence entry names one read.
 * @param {string} entry - an evidence string.
 * @param {Read} r - the read.
 * @param {string} cwd - the session working directory.
 * @returns {boolean} a match.
 */
export function namesRead(entry, r, cwd) {
  for (const raw of String(entry).split(/\s+/)) {
    const p = pointerOf(raw)
    if (p === '') continue
    if (r.tool === 'web_fetch') { if (isUrl(p) && r.target !== '' && normUrl(p) === normUrl(r.target)) return true; continue }
    if (isUrl(p) || !/[./]/.test(p)) continue
    if (r.target !== '' && samePath(p, r.target, cwd)) return true
    if (r.tool === 'grep' && r.text.replace(/\\/g, '/').toLowerCase().includes(normPath(p).toLowerCase())) return true
  }
  return false
}

/**
 * Apply the rule to a node about to be recorded or promoted.
 * @param {ThoughtNode} node - the candidate.
 * @param {Read[]} reads - the reads of the node's turn.
 * @param {string} cwd - the session working directory.
 * @returns {{node: ThoughtNode, note?: string}} the node (downgraded to `asserted` when unproven) and why.
 */
export function gateVerified(node, reads, cwd) {
  if (node.confidence !== 'verified') return { node }
  if (node.evidence.some(e => reads.some(r => namesRead(e, r, cwd)))) return { node }
  const seen = reads.length === 0 ? 'nothing was read with read, grep or web_fetch in that turn' : `that turn read only ${[...new Set(reads.map(r => r.target || r.tool))].slice(0, 5).join(', ')}`
  return {
    node: { ...node, confidence: 'asserted' },
    note: `recorded as asserted, not verified: no evidence entry names a file, grep hit or URL read in turn ${node.turn} (${seen})`,
  }
}

/**
 * The promotion gate: re-check a verified ephemeral node against the log of its own turn.
 * @param {ThoughtNode} eph - the node.
 * @param {unknown[]} events - its session log.
 * @param {string} cwd - the session working directory.
 * @returns {{node: ThoughtNode, note?: string}} the node to promote, and why it was downgraded.
 */
export const gatePromotion = (eph, events, cwd) => gateVerified(eph, turnReads(events, eph.turn), cwd)
