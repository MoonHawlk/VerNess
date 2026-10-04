/**
 * `/think` - the operator's hand on the thought graph (T-282), zero tokens. Ephemeral nodes are read
 * from the current session log with the plugin's own fold; persistent ones live in the plugin's
 * store, which this command reads and writes directly as the same unit file
 * (`$DSH_HOME/storages/finess_thoughts.json`, see packages/thoughts/src/adapters.js). The plugin
 * opens that file per operation, so a write here is seen by the next tool call.
 *
 *   /think [list]                      this task's nodes, then the project's persistent ones
 *   /think show <id>                   one node in full, with what it derives from and its provenance
 *   /think add <kind> <claim> [:: <evidence>; <evidence>] [--verified] [--contradicts <p-id>]
 *                                      write a persistent node directly
 *   /think link <a> <b>                persistent <a> was derived from persistent <b>
 *   /think promote <n-id> [--contradicts <p-id>]
 *                                      copy an ephemeral node into the persistent store (re-read to verify)
 *   /think forget <p-id>               remove a persistent node and the edges to it
 *   /think revoke <p-id|session-prefix|model>
 *                                      remove what one node, one session or one model wrote (audited, T-297)
 *   /think conflicts                   writes held back because they contradict a stored node (T-296)
 *   /think resolve <c-id> keep|replace|both
 *                                      settle one: drop the incoming, replace the stored, or keep both
 * @module scripts/commands/think
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { fileStore, storeFile } from '../../packages/thoughts/src/adapters.js'
import { guardedWrite, pendingConflicts, resolveConflict } from '../../packages/thoughts/src/conflicts.js'
import { foldEvents } from '../../packages/thoughts/src/fold.js'
import { UNKNOWN_MODEL, appendAudit, auditFile, nodeModels, originLine, revoke } from '../../packages/thoughts/src/provenance.js'
import { THOUGHT_KINDS } from '../../packages/thoughts/src/schema.js'
import { nodeDetail, nodeLine, subgraph } from '../../packages/thoughts/src/search.js'
import { DEFAULT_CAP_BYTES, addPersistent, findStored, forget, link, projectKey, promote, recordBytes, storedNodes } from '../../packages/thoughts/src/store.js'
import { listSessions, readSessionEvents } from '../lib/sessions.mjs'
import { head, info, ok, warn } from '../lib/util.mjs'
import { activeWorkspace } from '../lib/workspace.mjs'

const USAGE = '/think [list | show <id> | add <kind> <claim> [:: <evidence>; ...] [--verified] [--contradicts <p-id>] | link <a> <b> | promote <n-id> [--contradicts <p-id>] | forget <p-id> | revoke <p-id|session-prefix|model> | conflicts | resolve <c-id> keep|replace|both]'

/**
 * Parse `/think add` arguments.
 * @param {string[]} args - the words after `add`.
 * @returns {{input: object}|{error: string}} the node input, or why not.
 */
export function parseAdd(args) {
  const verified = args.includes('--verified')
  const words = args.filter(a => a !== '--verified')
  const [kind, ...rest] = words
  if (!THOUGHT_KINDS.includes(kind)) return { error: `the first word is the kind: ${THOUGHT_KINDS.join(' | ')}` }
  const text = rest.join(' ')
  const cut = text.indexOf('::')
  const claim = (cut < 0 ? text : text.slice(0, cut)).trim()
  const evidence = cut < 0 ? [] : text.slice(cut + 2).split(';').map(s => s.trim()).filter(s => s !== '')
  if (claim === '') return { error: 'the claim is missing' }
  return { input: { kind, claim, evidence, confidence: verified ? 'verified' : 'asserted' } }
}

/**
 * Take `--contradicts <p-id>` out of an argument list.
 * @param {string[]} args - the words.
 * @returns {{rest: string[], contradicts?: string}|{error: string}} the remaining words and the target.
 */
export function takeContradicts(args) {
  const i = args.indexOf('--contradicts')
  if (i < 0) return { rest: args }
  const id = args[i + 1]
  if (id === undefined || !/^p-[1-9][0-9]*$/.test(id)) return { error: '--contradicts needs a persistent id, e.g. --contradicts p-3' }
  return { rest: [...args.slice(0, i), ...args.slice(i + 2)], contradicts: id }
}

/**
 * Report a guarded write: stored and verified, or held back as a contradiction.
 * @param {{node?: object, conflict?: object}} res - the write's result.
 * @param {string} what - e.g. "stored" or "promoted n-2 as".
 * @returns {number} exit code: 0 stored, 2 held.
 */
function reportWrite(res, what) {
  if (res.conflict !== undefined) {
    const c = res.conflict
    warn(`not stored: it contradicts ${c.against} (${c.reason}) - held as ${c.id}`)
    info(`settle it: /think resolve ${c.id} keep|replace|both  (/think conflicts lists every pending one)`)
    return 2
  }
  ok(`${what} ${nodeLine(res.node)} (verified on re-read)`)
  return 0
}

/**
 * The command body, with every effect injected so tests run against temp files.
 * @param {string[]} args - the words after `/think`.
 * @param {{store: {read: Function, mutate: Function}, project: string, session?: string,
 *   events: () => object[]|undefined, now?: () => Date, cap?: number, audit?: string}} deps - the store
 *   adapter, the project key, the current session id, its decoded log (undefined when there is
 *   none), and the audit file for revokes and replacements (absent: no audit file is written).
 * @returns {number} exit code (2: the write was held back as a contradiction).
 */
export function runThink(args, { store, project, session, events, now = () => new Date(), cap = DEFAULT_CAP_BYTES, audit }) {
  const [sub = 'list', ...rest] = args
  const log = () => events() ?? []
  const eph = () => foldEvents(log()).nodes
  const operator = { by: 'operator', ...(session === undefined ? {} : { session }) }
  const at = () => now().toISOString()
  const audited = entry => { if (audit !== undefined) appendAudit(audit, { at: at(), project, ...entry }) }
  try {
    if (sub === 'list' && rest.length === 0) {
      const e = eph()
      const rec = store.read(project)
      head(`thoughts - this task (${e.length})`)
      if (e.length === 0) info('none recorded (the model writes them with think_add)')
      for (const n of e) info(nodeLine(n))
      head(`persistent - this project (${rec.nodes.length}, ${recordBytes(rec)}/${cap} bytes)`)
      if (rec.nodes.length === 0) info('none - /think promote <n-id> or /think add')
      for (const n of storedNodes(rec)) info(nodeLine(n))
      const pending = pendingConflicts(rec).length
      if (pending > 0) warn(`${pending} contradiction(s) pending - /think conflicts`)
      return 0
    }
    if (sub === 'show' && rest.length === 1) {
      const rec = store.read(project)
      const g = subgraph([...eph(), ...storedNodes(rec)], rest[0], 1)
      if (g.root === undefined) { warn(`no node ${rest[0]} - /think lists them (ephemeral ids reset each task)`); return 1 }
      for (const n of [g.root, ...g.related]) {
        for (const l of nodeDetail(n)) info(l)
        const s = findStored(rec, n.id)
        if (s !== undefined) info(originLine(s))
      }
      if (g.missing.length > 0) info(`not available: ${g.missing.join(', ')}`)
      return 0
    }
    if (sub === 'add' && rest.length > 0) {
      const c = takeContradicts(rest)
      if ('error' in c) { warn(c.error); return 1 }
      const p = parseAdd(c.rest)
      if ('error' in p) { warn(`${p.error} - ${USAGE}`); return 1 }
      const res = store.mutate(project, r => guardedWrite(r, x => addPersistent(x, p.input, { at: at(), origin: operator, cap }), { at: at(), contradicts: c.contradicts, cap }))
      return reportWrite(res, 'stored')
    }
    if (sub === 'link' && rest.length === 2) {
      store.mutate(project, r => ({ record: link(r, rest[0], rest[1], { cap }) }))
      ok(`${rest[0]} now derives from ${rest[1]}`)
      return 0
    }
    if (sub === 'promote' && rest.length >= 1) {
      const c = takeContradicts(rest)
      if ('error' in c) { warn(c.error); return 1 }
      if (c.rest.length !== 1) { warn(`usage: ${USAGE}`); return 1 }
      const ev = log()
      const n = foldEvents(ev).nodes.find(x => x.id === c.rest[0])
      if (n === undefined) { warn(`no ephemeral node ${c.rest[0]} in this task - /think lists them`); return 1 }
      // The claim is the model's, so the origin says so: which session, which model (T-297).
      const origin = { by: 'model', ...(session === undefined ? {} : { session }), model: nodeModels(ev).get(n.id) ?? UNKNOWN_MODEL }
      const res = store.mutate(project, r => guardedWrite(r, x => promote(x, n, { at: at(), origin, cap }), { at: at(), contradicts: c.contradicts, cap }))
      return reportWrite(res, `promoted ${n.id} as`)
    }
    if (sub === 'forget' && rest.length === 1) {
      store.mutate(project, r => ({ record: forget(r, rest[0]) }))
      ok(`forgot ${rest[0]}`)
      return 0
    }
    if (sub === 'revoke' && rest.length === 1) {
      const res = store.mutate(project, r => revoke(r, rest[0]))
      audited({ action: 'revoke', token: rest[0], match: res.match, removed: res.removed, dropped: res.dropped })
      ok(`revoked by ${res.match}: ${res.removed.length} node(s), ${res.dropped.length} pending conflict(s)${audit === undefined ? '' : ` - audit: ${audit}`}`)
      for (const s of res.removed) info(`- ${nodeLine(s.node)}`)
      for (const x of res.dropped) info(`- ${x.id} (incoming ${x.entry.node.id} vs ${x.against})`)
      return 0
    }
    if (sub === 'conflicts' && rest.length === 0) {
      const rec = store.read(project)
      const list = pendingConflicts(rec)
      head(`contradictions pending - this project (${list.length})`)
      if (list.length === 0) info('none')
      for (const x of list) {
        const old = findStored(rec, x.against)
        info(`${x.id}: ${x.reason}`)
        info(`  incoming ${nodeLine(x.entry.node)}`)
        info(`  ${originLine(x.entry).trim()}`)
        info(`  stored   ${old === undefined ? `${x.against} (no longer stored)` : nodeLine(old.node)}`)
      }
      if (list.length > 0) info('/think resolve <c-id> keep (drop incoming) | replace (forget stored, store incoming) | both')
      return 0
    }
    if (sub === 'resolve' && rest.length === 2) {
      const res = store.mutate(project, r => resolveConflict(r, rest[0], rest[1], { cap }))
      if (res.removed !== undefined) audited({ action: 'resolve-replace', conflict: res.conflict.id, removed: [res.removed] })
      ok(`${res.conflict.id} resolved: ${rest[1]}${res.node === undefined ? '' : ` - stored ${res.node.id} (verified on re-read)`}`)
      return 0
    }
  } catch (e) {
    warn(e.message)
    return 1
  }
  warn(`usage: ${USAGE}`)
  return 1
}

export default {
  name: 'think',
  group: 'core',
  summary: 'the thought graph: list | show <id> | add | link | promote <n-id> | forget | revoke | conflicts | resolve',
  usage: USAGE,
  details: [
    'ephemeral nodes are what the model recorded this task (think_add); they reset on the next task',
    'persistent nodes outlive sessions, per project, capped in bytes; a full store refuses writes',
    'promote and add re-read the store to verify; link <a> <b> means a was derived from b',
    'a write that contradicts a stored node is held as a conflict, never written over it: /think conflicts, /think resolve',
    'every persistent node records its session and model; /think revoke <id|session-prefix|model> removes a bad run, with an audit line',
  ],
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - subcommand and its words.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const cur = ctx.conversation?.id()
    const events = () => {
      if (cur === undefined) return undefined
      const s = listSessions({ workspace: ctx.workspaceKey, limit: 50 }).find(x => x.id === String(cur).replace(/^session-/, ''))
      return s === undefined ? undefined : readSessionEvents(join(s.dir, 'session.v4.jsonl.zstd'))
    }
    return runThink(args, {
      store: fileStore(storeFile(home)),
      project: projectKey(activeWorkspace().dir),
      ...(cur === undefined ? {} : { session: String(cur) }),
      events,
      audit: auditFile(home),
    })
  },
}
