/**
 * What the graph puts in front of the model on its own (T-285, T-286, T-289): the `thoughtsContext`
 * projection and the two listeners that enter context messages.
 *
 * Every injection is ONE durable user-role message with source
 * `{kind: 'finess-thoughts', form, part, ...}`, entered through the `agent/pre-step` waterfall
 * (upstream packages/core/agent-loop/src/agent.ts:277, typed packages/core/agent/src/runtime-types.ts:320,
 * decision :112) right after the step's claimed messages, as agent-instructions does
 * (packages/context/agent-instructions/src/index.ts:315-341). A plugin-owned source kind is legal:
 * the source map is merge-extensible (packages/llm/llm/src/message.ts:103-115) and the session
 * validates a user message's source only as a non-empty `kind` (packages/core/session/src/index.ts:354-359).
 * Being logged, each message is frozen by construction and resumes with the session; this
 * projection folds them back so nothing is injected twice.
 *
 *   part 'constraints' form 'instructions'  T-285 baseline, first step of a top-level session only
 *   part 'seed'        form 'recall'        T-289 nodes passed to a subagent child, its first step
 *   part 'digest'      form 'recall'        T-286 after a compaction/summary newer than the last digest
 *
 * Parent side of T-289 is the `tools/pre-execute` waterfall (packages/core/tools/src/index.ts:153).
 * @module @finess/thoughts/context
 */

import { randomUUID } from 'node:crypto'

import { renderDigest } from './compact.js'
import { PROJECTION_KEY, foldEvents } from './fold.js'
import { renderBaseline } from './inject.js'
import { isPlainObject, validateThoughtNode } from './schema.js'
import { projectKey, storedNodes } from './store.js'
import { SUBAGENT_TOOLS, isChildSession, resolveSeed, seedStash } from './subagent.js'

export const CONTEXT_KEY = 'thoughtsContext'
/** Bump on ANY change to the state shape or the fold's semantics. */
export const CONTEXT_STATE_VERSION = 1
export const SOURCE_KIND = 'finess-thoughts'

/**
 * @typedef {import('./schema.js').ThoughtNode} ThoughtNode
 * @typedef {object} ContextState
 * @property {1} v - CONTEXT_STATE_VERSION.
 * @property {boolean} started - a step has started in this session (the baseline window is closed).
 * @property {{part: 'constraints'|'seed', ids: string[], text: string}|null} frozen - the session's frozen block, as logged.
 * @property {ThoughtNode[]} seeds - nodes passed in by a parent (children only).
 * @property {number} compactions - `compaction/summary` events seen.
 * @property {number} digested - the compaction count the last digest answered.
 */

/** @returns {ContextState} the empty state. */
export const initContext = () => ({ v: CONTEXT_STATE_VERSION, started: false, frozen: null, seeds: [], compactions: 0, digested: 0 })

/** @param {unknown} content @returns {string} the text blocks joined. */
const textOf = content => (Array.isArray(content) ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '')

/** @param {unknown} v @returns {string[]} the strings of an array, else []. */
const strings = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])

/**
 * The pure fold; the same reference for every event it ignores.
 * @param {ContextState} s - current state.
 * @param {unknown} event - the committed event.
 * @returns {ContextState} the next state.
 */
export function foldContext(s, event) {
  if (event?.type === 'step/start') return s.started ? s : { ...s, started: true }
  if (event?.type === 'compaction/summary') return { ...s, compactions: s.compactions + 1 }
  if (event?.type !== 'user/message') return s
  const src = event.data?.source
  if (!isPlainObject(src) || src.kind !== SOURCE_KIND) return s
  const text = textOf(event.data.content)
  if (src.part === 'constraints' && s.frozen === null) return { ...s, frozen: { part: 'constraints', ids: strings(src.ids), text } }
  if (src.part === 'seed' && s.frozen === null) {
    const seeds = (Array.isArray(src.nodes) ? src.nodes : []).map(validateThoughtNode).filter(r => r.ok).map(r => r.value)
    return { ...s, frozen: { part: 'seed', ids: strings(src.ids), text }, seeds }
  }
  if (src.part === 'digest' && Number.isSafeInteger(src.compaction) && src.compaction > s.digested) return { ...s, digested: src.compaction }
  return s
}

/** Duck-typed `{parse}` schema for the persisted state and the wire view. */
export const contextSchema = {
  /** @param {unknown} v @returns {ContextState} the state, or throws. */
  parse(v) {
    if (!isPlainObject(v) || v.v !== CONTEXT_STATE_VERSION) throw new Error(`thoughtsContext: not a v${CONTEXT_STATE_VERSION} state`)
    const { started, frozen, seeds, compactions, digested } = v
    if (typeof started !== 'boolean') throw new Error('thoughtsContext: bad started')
    if (frozen !== null && (!isPlainObject(frozen) || !['constraints', 'seed'].includes(frozen.part) || typeof frozen.text !== 'string' || !Array.isArray(frozen.ids))) throw new Error('thoughtsContext: bad frozen block')
    if (!Array.isArray(seeds)) throw new Error('thoughtsContext: bad seeds')
    for (const n of [compactions, digested]) if (!Number.isSafeInteger(n) || n < 0) throw new Error('thoughtsContext: bad counter')
    const out = seeds.map((n, i) => { const r = validateThoughtNode(n); if (!r.ok) throw new Error(`thoughtsContext: seed ${i} is invalid`); return r.value })
    return { v: CONTEXT_STATE_VERSION, started, frozen: frozen === null ? null : { part: frozen.part, ids: strings(frozen.ids), text: frozen.text }, seeds: out, compactions, digested }
  },
}

/**
 * The live context state: the registry's cell, or a fold of the log.
 * @param {object} projections - `ctx.sessionProjections`.
 * @param {object} session - the session.
 * @returns {ContextState} the state.
 */
export function contextState(projections, session) {
  const s = projections?.stateOf?.(session, CONTEXT_KEY)
  return s ?? session.snapshotEvents().reduce(foldContext, initContext())
}

/**
 * The thoughts state (same fallback as plugin.sessionState, kept here to avoid a cycle).
 * @param {object} projections - `ctx.sessionProjections`.
 * @param {object} session - the session.
 * @returns {import('./fold.js').ThoughtsState} the state.
 */
const thoughtsOf = (projections, session) => projections?.stateOf?.(session, PROJECTION_KEY) ?? foldEvents(session.snapshotEvents())

/** @param {object} session @returns {string} the session's project key (its cwd). */
export const projectOf = session => projectKey(session.header?.cwd ?? process.cwd())

/**
 * Every node a session may see: its task's nodes, plus the project's persistent ones at top level,
 * or only what its parent passed in a child (T-289).
 * @param {{projections: object, store: {read: (p: string) => Promise<object>}}} deps - seams.
 * @returns {(session: object) => Promise<ThoughtNode[]>} the lookup.
 */
export const visibleNodes = ({ projections, store }) => async session => {
  const own = thoughtsOf(projections, session).nodes
  if (isChildSession(session.header)) return [...own, ...contextState(projections, session).seeds]
  return [...own, ...storedNodes(await store.read(projectOf(session)))]
}

/**
 * One context message.
 * @param {'constraints'|'seed'|'digest'} part - which injection.
 * @param {string} text - model-facing text.
 * @param {object} extra - more source fields.
 * @returns {object} a UserMessage (`createUserMessage` shape, packages/llm/llm/src/message.ts:221-252).
 */
export function contextMessage(part, text, extra = {}) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: SOURCE_KIND, form: part === 'constraints' ? 'instructions' : 'recall', part, ...extra } }
}

/**
 * The messages to enter with this step.
 * @param {object} session - the agent's session.
 * @param {string[]} claimed - the claimed messages' texts.
 * @param {{projections: object, store: object, stash: ReturnType<typeof seedStash>}} deps - seams.
 * @returns {Promise<object[]>} zero to two messages.
 */
export async function messagesFor(session, claimed, { projections, store, stash }) {
  const st = contextState(projections, session)
  const out = []
  let frozen = st.frozen?.text
  if (!st.started && st.frozen === null) {
    if (isChildSession(session.header)) {
      const seed = stash.take(claimed)
      if (seed !== undefined) {
        out.push(contextMessage('seed', seed.text, { ids: seed.nodes.map(n => n.id), nodes: seed.nodes }))
        frozen = seed.text
      }
    } else {
      const b = renderBaseline(storedNodes(await store.read(projectOf(session))))
      if (b !== undefined) out.push(contextMessage('constraints', b.text, { ids: b.ids }))
    }
  }
  if (st.compactions > st.digested) {
    const d = renderDigest(thoughtsOf(projections, session).nodes, frozen)
    if (d !== undefined) out.push(contextMessage('digest', d.text, { ids: d.ids, compaction: st.compactions }))
  }
  return out
}

/**
 * Mount the projection and both listeners.
 * @param {object} ctx - carries `sessionProjections`, `on`, optionally `logger`.
 * @param {{store: object, subagentTools?: readonly string[]}} deps - the persistent store, delegating tool names.
 * @returns {{stash: ReturnType<typeof seedStash>}} the seed stash (tests read it).
 */
export function mountContext(ctx, { store, subagentTools = SUBAGENT_TOOLS }) {
  const projections = ctx.sessionProjections
  projections.register({
    key: CONTEXT_KEY,
    stateSchema: contextSchema,
    init: () => initContext(),
    apply: foldContext,
    wire: { viewSchema: contextSchema, view: s => s },
    stateVersion: CONTEXT_STATE_VERSION,
  })
  const stash = seedStash()
  const visible = visibleNodes({ projections, store })
  const warn = (what, e) => ctx.logger?.warn?.(`finess-thoughts: ${what}: ${e instanceof Error ? e.message : String(e)}`)
  if (typeof ctx.on !== 'function') return { stash }

  ctx.on('agent/pre-step', async (payload, next) => {
    // After next(): a compaction made inside the waterfall is already in the log.
    const decision = await next()
    if (decision?.kind !== 'enter') return decision
    if (payload.step === 1 && decision.messages.length === 0) return decision
    const session = payload.agent?.session
    if (session === undefined) return decision
    let add
    try { add = await messagesFor(session, (payload.messages ?? []).map(m => textOf(m.content)), { projections, store, stash }) } catch (e) { warn('context injection skipped', e); return decision }
    if (add.length === 0) return decision
    const at = decision.messages.findLastIndex(m => payload.messages?.includes(m))
    return { ...decision, messages: decision.messages.toSpliced(at + 1, 0, ...add) }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const prompt = exec?.arguments?.prompt
    const session = exec?.agent?.session
    if (!subagentTools.includes(exec?.name) || typeof prompt !== 'string' || session === undefined) return next()
    let seed
    try { seed = resolveSeed(await visible(session), prompt) } catch (e) { return { kind: 'deny', reason: `could not resolve the [thoughts: ...] nodes: ${e instanceof Error ? e.message : String(e)}` } }
    if (seed === undefined) return next()
    if ('error' in seed) return { kind: 'deny', reason: seed.error }
    const decision = await next()
    // 'ask' may still be approved by the user: stash then too (bounded, consume-once, so a stale entry costs nothing).
    if (decision?.kind === 'allow' || decision?.kind === 'ask') stash.put(prompt, seed)
    return decision
  })
  return { stash }
}
