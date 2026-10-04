/**
 * The ephemeral tier (T-280): `thought/node` records and the `thoughts` projection fold.
 *
 * Where a record lives. A first-class `thought/node` SessionEvent is what the design asked for, but
 * this substrate cannot carry one safely: `Session.append` has no way to set the envelope's
 * `ignorable` marker (upstream packages/core/session/src/index.ts:722), and the persistence read
 * path refuses any event type outside the generated KNOWN_SESSION_EVENT_TYPES that is not marked
 * ignorable (packages/session/session-persistence/src/storage-contract.ts:75, called from the JSONL
 * loader). The first node would make every later `--session-id` adoption refuse the session.
 * So a record rides on the `think_add` call's own `tool/result` event, in its tool-private,
 * persisted `meta` (packages/core/session/src/types.ts:375-385), produced by the tool's
 * `output.presentationMeta` (packages/core/tools/src/schema.ts:496, set only for top-level calls,
 * packages/core/tools/src/index.ts:1844). The record is tagged `kind: 'thought/node'` so the design's
 * vocabulary holds and a future first-class event can carry the same payload unchanged.
 *
 * Compaction: the fold reads the durable log, not the model-visible surface. Compaction shadows
 * surface nodes but deletes nothing (docs/research/dsh-state-and-memory-seams.md section 5), and
 * projections re-fold from the log on restore (packages/session/session-projection/src/index.ts:495).
 *
 * Task boundary: a direct human prompt (`user/message` whose `source.kind` is `'user'`) starts a
 * task and folds the graph back to empty. In FiNess one REPL line is one dsh run is one human
 * prompt; goal rounds, injected context and tool results are other source kinds and do not reset.
 * @module @finess/thoughts/fold
 */

import { idNumber, isPlainObject, validateThoughtNode } from './schema.js'

/** Projection key (one registrant; ctx.sessionProjections refuses a second at another version). */
export const PROJECTION_KEY = 'thoughts'
/** Bump on ANY change to the state shape or the fold's semantics (session-projection/src/index.ts:86-92). */
export const STATE_VERSION = 1
/** The record tag inside `tool/result.meta`. */
export const RECORD_KIND = 'thought/node'
/** Record payload version. */
export const RECORD_VERSION = 1
/** Most ephemeral nodes in one task; `think_add` errors past it (eviction is T-288, never silent). */
export const MAX_EPHEMERAL_NODES = 200

/**
 * @typedef {import('./schema.js').ThoughtNode} ThoughtNode
 * @typedef {object} ThoughtsState
 * @property {1} v - STATE_VERSION.
 * @property {number} task - human prompts seen in this session (0 before the first).
 * @property {number|null} turn - the open or last turn, null before the first `turn/start`.
 * @property {number} nextId - the next ephemeral id number.
 * @property {ThoughtNode[]} nodes - this task's nodes, in append order.
 */

/** @returns {ThoughtsState} the empty state. */
export const initState = () => ({ v: STATE_VERSION, task: 0, turn: null, nextId: 1, nodes: [] })

/**
 * The `tool/result.meta` payload carrying one node.
 * @param {ThoughtNode} node - a validated node.
 * @returns {{kind: string, v: number, node: ThoughtNode}} the record.
 */
export const nodeRecord = node => ({ kind: RECORD_KIND, v: RECORD_VERSION, node })

/**
 * The node a log event carries, if any. Only an ephemeral node that validates is taken: a malformed
 * or foreign record is ignored rather than poisoning the fold.
 * @param {unknown} event - one session event (live or decoded from JSONL).
 * @returns {ThoughtNode|undefined} the node.
 */
export function recordOf(event) {
  if (event?.type !== 'tool/result') return undefined
  const meta = event.data?.meta
  if (!isPlainObject(meta) || meta.kind !== RECORD_KIND || meta.v !== RECORD_VERSION) return undefined
  if (event.data?.message?.isError === true) return undefined
  const r = validateThoughtNode(meta.node)
  return r.ok && r.value.scope === 'ephemeral' ? r.value : undefined
}

/** @param {unknown} event @returns {boolean} whether it is a direct human prompt (a task start). */
export const isTaskStart = event => event?.type === 'user/message' && event.data?.source?.kind === 'user'

/**
 * The pure projection fold. Returns the SAME reference for every event it does not care about
 * (the registry gates all downstream work on `Object.is`).
 * @param {ThoughtsState} state - current state.
 * @param {unknown} event - the committed event.
 * @returns {ThoughtsState} the next state.
 */
export function foldThought(state, event) {
  if (isTaskStart(event)) return { v: STATE_VERSION, task: state.task + 1, turn: state.turn, nextId: 1, nodes: [] }
  if (event?.type === 'turn/start') {
    const turn = event.data?.turn
    return Number.isSafeInteger(turn) && turn !== state.turn ? { ...state, turn } : state
  }
  const node = recordOf(event)
  if (node === undefined || state.nodes.some(n => n.id === node.id)) return state
  return { ...state, nextId: Math.max(state.nextId, idNumber(node.id) + 1), nodes: [...state.nodes, node] }
}

/**
 * Fold a whole log (the launcher reads decoded JSONL; tests use arrays).
 * @param {Iterable<unknown>} events - session events in append order.
 * @param {ThoughtsState} [from] - starting state.
 * @returns {ThoughtsState} the state after the last event.
 */
export function foldEvents(events, from = initState()) {
  let s = from
  for (const e of events) s = foldThought(s, e)
  return s
}

/**
 * Duck-typed schema (`{parse}` is all the projection registry calls,
 * session-projection/src/index.ts:142,462,521) for the persisted state and the wire view.
 */
export const stateSchema = {
  /** @param {unknown} v @returns {ThoughtsState} the state, or throws. */
  parse(v) {
    if (!isPlainObject(v) || v.v !== STATE_VERSION) throw new Error('thoughts: not a v1 state')
    const { task, turn, nextId, nodes } = v
    if (!Number.isSafeInteger(task) || task < 0) throw new Error('thoughts: bad task counter')
    if (turn !== null && (!Number.isSafeInteger(turn) || turn < 0)) throw new Error('thoughts: bad turn')
    if (!Number.isSafeInteger(nextId) || nextId < 1) throw new Error('thoughts: bad nextId')
    if (!Array.isArray(nodes)) throw new Error('thoughts: nodes is not an array')
    const out = nodes.map((n, i) => {
      const r = validateThoughtNode(n)
      if (!r.ok) throw new Error(`thoughts: node ${i} is invalid`)
      return r.value
    })
    return { v: STATE_VERSION, task, turn, nextId, nodes: out }
  },
}
