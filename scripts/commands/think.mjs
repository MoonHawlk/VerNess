/**
 * `/think` - the operator's hand on the thought graph (T-282), zero tokens. Ephemeral nodes are read
 * from the current session log with the plugin's own fold; persistent ones live in the plugin's
 * store, which this command reads and writes directly as the same unit file
 * (`$DSH_HOME/storages/finess_thoughts.json`, see packages/thoughts/src/adapters.js). The plugin
 * opens that file per operation, so a write here is seen by the next tool call.
 *
 *   /think [list]                      this task's nodes, then the project's persistent ones
 *   /think show <id>                   one node in full, with what it derives from
 *   /think add <kind> <claim> [:: <evidence>; <evidence>] [--verified]
 *                                      write a persistent node directly
 *   /think link <a> <b>                persistent <a> was derived from persistent <b>
 *   /think promote <n-id>              copy an ephemeral node into the persistent store (re-read to verify)
 *   /think forget <p-id>               remove a persistent node and the edges to it
 * @module scripts/commands/think
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { fileStore, storeFile } from '../../packages/thoughts/src/adapters.js'
import { foldEvents } from '../../packages/thoughts/src/fold.js'
import { THOUGHT_KINDS } from '../../packages/thoughts/src/schema.js'
import { nodeDetail, nodeLine, subgraph } from '../../packages/thoughts/src/search.js'
import { DEFAULT_CAP_BYTES, addPersistent, forget, link, projectKey, promote, recordBytes, storedNodes } from '../../packages/thoughts/src/store.js'
import { listSessions, readSessionEvents } from '../lib/sessions.mjs'
import { head, info, ok, warn } from '../lib/util.mjs'
import { activeWorkspace } from '../lib/workspace.mjs'

const USAGE = '/think [list | show <id> | add <kind> <claim> [:: <evidence>; ...] [--verified] | link <a> <b> | promote <n-id> | forget <p-id>]'

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
 * The command body, with every effect injected so tests run against temp files.
 * @param {string[]} args - the words after `/think`.
 * @param {{store: {read: Function, mutate: Function}, project: string, session?: string,
 *   events: () => object[]|undefined, now?: () => Date, cap?: number}} deps - the store adapter,
 *   the project key, the current session id, its decoded log (undefined when there is none).
 * @returns {number} exit code.
 */
export function runThink(args, { store, project, session, events, now = () => new Date(), cap = DEFAULT_CAP_BYTES }) {
  const [sub = 'list', ...rest] = args
  const eph = () => { const ev = events(); return ev === undefined ? [] : foldEvents(ev).nodes }
  const origin = { by: 'operator', ...(session === undefined ? {} : { session }) }
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
      return 0
    }
    if (sub === 'show' && rest.length === 1) {
      const g = subgraph([...eph(), ...storedNodes(store.read(project))], rest[0], 1)
      if (g.root === undefined) { warn(`no node ${rest[0]} - /think lists them (ephemeral ids reset each task)`); return 1 }
      for (const l of [...nodeDetail(g.root), ...g.related.flatMap(nodeDetail)]) info(l)
      if (g.missing.length > 0) info(`not available: ${g.missing.join(', ')}`)
      return 0
    }
    if (sub === 'add' && rest.length > 0) {
      const p = parseAdd(rest)
      if ('error' in p) { warn(`${p.error} - ${USAGE}`); return 1 }
      const { node } = store.mutate(project, r => addPersistent(r, p.input, { at: now().toISOString(), origin, cap }))
      ok(`stored and verified ${nodeLine(node)}`)
      return 0
    }
    if (sub === 'link' && rest.length === 2) {
      store.mutate(project, r => ({ record: link(r, rest[0], rest[1], { cap }) }))
      ok(`${rest[0]} now derives from ${rest[1]}`)
      return 0
    }
    if (sub === 'promote' && rest.length === 1) {
      const n = eph().find(x => x.id === rest[0])
      if (n === undefined) { warn(`no ephemeral node ${rest[0]} in this task - /think lists them`); return 1 }
      const { node } = store.mutate(project, r => promote(r, n, { at: now().toISOString(), origin, cap }))
      ok(`promoted ${n.id} as ${node.id} (verified on re-read)`)
      return 0
    }
    if (sub === 'forget' && rest.length === 1) {
      store.mutate(project, r => ({ record: forget(r, rest[0]) }))
      ok(`forgot ${rest[0]}`)
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
  summary: 'the thought graph: list | show <id> | add | link <a> <b> | promote <n-id> | forget <p-id>',
  usage: USAGE,
  details: [
    'ephemeral nodes are what the model recorded this task (think_add); they reset on the next task',
    'persistent nodes outlive sessions, per project, capped in bytes; a full store refuses writes',
    'promote and add re-read the store to verify; link <a> <b> means a was derived from b',
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
    })
  },
}
