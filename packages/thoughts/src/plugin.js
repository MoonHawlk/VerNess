/**
 * The dsh side of the thought graph: the `thoughts` projection (T-280) and the model's tools
 * `think_add` / `think_search` / `think_open` (T-283). `defineTool` is injected so this module (and
 * its tests) never needs the substrate installed; `index.js` passes the real one.
 *
 * Substrate seams used (upstream deepseek-harness 0.1.7-rc.2):
 * - ctx.sessionProjections.register / stateOf - packages/session/session-projection/src/index.ts:233-293, :319
 * - ctx.tools.register + defineTool, output.presentationMeta - packages/core/tools/src/schema.ts:483-554
 * - exec.agent.session (runtime-types.ts:168), session.header.cwd (core/session/src/types.ts:105),
 *   session.snapshotEvents() (core/session/src/index.ts:649)
 * - ctx.storageDomain.open (packages/storage/storage-domain/src/index.ts:103, provided at :236)
 * - `agent/pre-step` and `tools/pre-execute` waterfalls, through context.js (T-285, T-286, T-289);
 *   think_add's "verified" gate reads the turn's tool/call + tool/result pairs (evidence.js, T-287)
 * @module @finess/thoughts/plugin
 */

import { domainStore } from './adapters.js'
import { contextState, mountContext, visibleNodes } from './context.js'
import { gateVerified, turnReads } from './evidence.js'
import { MAX_EPHEMERAL_NODES, PROJECTION_KEY, STATE_VERSION, foldEvents, foldThought, initState, nodeRecord, stateSchema } from './fold.js'
import { THOUGHT_CONFIDENCE, THOUGHT_KINDS, buildNode, formatIssues } from './schema.js'
import { nodeDetail, nodeLine, searchNodes, subgraph } from './search.js'
import { isChildSession, seedFloor } from './subagent.js'

/** Output-schema spec of one node (the tools registry validates every value against it). */
const NODE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    scope: { type: 'string', required: true, enum: ['ephemeral', 'persistent'] },
    kind: { type: 'string', required: true, enum: [...THOUGHT_KINDS] },
    claim: { type: 'string', required: true },
    evidence: { type: 'array', required: true, items: { type: 'string' } },
    confidence: { type: 'string', required: true, enum: [...THOUGHT_CONFIDENCE] },
    derivedFrom: { type: 'array', required: true, items: { type: 'string' } },
    turn: { type: 'integer', required: true },
    at: { type: 'string', required: true },
  },
}

/**
 * The live thoughts state of a session: the registry's cell, or a fold of the log when the
 * projection is not registered on this context.
 * @param {object} projections - `ctx.sessionProjections`.
 * @param {object} session - the agent's session.
 * @returns {import('./fold.js').ThoughtsState} the state.
 */
export function sessionState(projections, session) {
  const s = projections?.stateOf?.(session, PROJECTION_KEY)
  return s ?? foldEvents(session.snapshotEvents())
}

/** @param {object} exec @returns {object} the owning session, or throws. */
function sessionOf(exec, tool) {
  const session = exec?.agent?.session
  if (session === undefined) throw new Error(`${tool} needs an owning agent session`)
  return session
}

/**
 * The three tool definitions (before `defineTool`).
 * @param {{projections: object, store: ReturnType<typeof domainStore>, now?: () => Date}} deps - seams.
 * @returns {object[]} `think_add`, `think_search`, `think_open` option objects.
 */
export function toolSpecs({ projections, store, now = () => new Date() }) {
  const allNodes = visibleNodes({ projections, store })
  const think_add = {
    name: 'think_add',
    description: 'Record one step of your reasoning as a small node: what you tried, found, decided, or must respect. '
      + 'Use it for conclusions you will need again in this task; a node is one sentence (<=200 chars). '
      + 'Mark confidence "verified" only when you read the evidence yourself in this turn. Nodes reset when a new task starts.',
    parameters: {
      kind: { type: 'string', required: true, enum: [...THOUGHT_KINDS], description: 'attempt | finding | decision | constraint | artifact' },
      claim: { type: 'string', required: true, description: 'One sentence, at most 200 characters.' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'Pointers backing the claim, e.g. "src/a.ts:42" or "ran npm test: 12 pass".' },
      confidence: { type: 'string', enum: [...THOUGHT_CONFIDENCE], description: 'verified (evidence read this turn) | asserted (default).' },
      derivedFrom: { type: 'array', items: { type: 'string' }, description: 'Ids of nodes this one builds on, e.g. ["n-2"].' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { node: { ...NODE, required: true }, note: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Recorded ${nodeLine(value.node)}${value.note === undefined ? '' : `\nNote: ${value.note}`}` }],
      // The durable record: the projection folds it back out of tool/result.meta.
      presentationMeta: (_args, value) => nodeRecord(value.node),
    },
    async execute(args, exec) {
      const session = sessionOf(exec, 'think_add')
      // presentationMeta only runs for top-level calls; nested, the node would vanish silently.
      if (exec.parent !== undefined) throw new Error('think_add must be called directly, not from inside another tool call: the node would not be recorded')
      const state = sessionState(projections, session)
      if (state.nodes.length >= MAX_EPHEMERAL_NODES) throw new Error(`this task already holds ${MAX_EPHEMERAL_NODES} nodes; open or search the ones you have instead of adding more`)
      // A child's own ids start above the ones its parent passed in (T-289).
      const nextId = isChildSession(session.header) ? Math.max(state.nextId, seedFloor(contextState(projections, session).seeds)) : state.nextId
      const built = buildNode(args, { id: `n-${nextId}`, scope: 'ephemeral', turn: state.turn ?? 0, at: now().toISOString() })
      if (!built.ok) throw new Error(`invalid node: ${formatIssues(built.errors)}`)
      const known = new Set(state.nodes.map(n => n.id))
      if (built.value.derivedFrom.some(id => !known.has(id))) for (const n of await allNodes(session)) known.add(n.id)
      const unknown = built.value.derivedFrom.filter(id => !known.has(id))
      if (unknown.length > 0) throw new Error(`derivedFrom names unknown nodes: ${unknown.join(', ')} (think_search lists what exists)`)
      // T-287: "verified" only with evidence read in this turn, judged from the log.
      const { node, note } = gateVerified(built.value, turnReads(session.snapshotEvents(), state.turn), session.header?.cwd ?? process.cwd())
      return note === undefined ? { node } : { node, note }
    },
    presentCall: args => ({ card: 'generic', title: `Think: ${String(args?.claim ?? '').slice(0, 60)}`, kind: 'other' }),
  }
  const think_search = {
    name: 'think_search',
    description: 'Search your recorded thought nodes (this task) and the project\'s persistent ones by words in the claim or evidence. Returns ids and claims; use think_open for a full node.',
    parameters: {
      query: { type: 'string', required: true, description: 'Words to look for; empty lists the newest nodes.' },
      kind: { type: 'string', enum: [...THOUGHT_KINDS], description: 'Only this kind.' },
      scope: { type: 'string', enum: ['ephemeral', 'persistent', 'all'], description: 'Which tier (default all).' },
      limit: { type: 'integer', description: 'Most hits (default 10, at most 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { hits: { type: 'array', required: true, items: { ...NODE } }, total: { type: 'integer', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.hits.length === 0 ? 'No matching nodes.' : value.hits.map(nodeLine).join('\n') }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const nodes = await allNodes(sessionOf(exec, 'think_search'))
      const limit = Math.min(Math.max(1, args.limit ?? 10), 50)
      const hits = searchNodes(nodes, args.query, { kind: args.kind, scope: args.scope, limit }).map(h => h.node)
      return { hits, total: nodes.length }
    },
  }
  const think_open = {
    name: 'think_open',
    description: 'Open one thought node by id with the nodes it was derived from (up to `depth` edges, default 1). '
      + 'A subagent sees none of your nodes unless you name them in its prompt as [thoughts: n-2 p-1]; it then receives exactly those.',
    parameters: {
      id: { type: 'string', required: true, description: 'A node id, e.g. "n-3" or "p-1".' },
      depth: { type: 'integer', description: 'Edges to follow back (0-3, default 1).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node: { ...NODE, required: true },
          related: { type: 'array', required: true, items: { ...NODE } },
          missing: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [...nodeDetail(value.node), ...value.related.flatMap(nodeDetail), ...(value.missing.length === 0 ? [] : [`not available: ${value.missing.join(', ')}`])].join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const g = subgraph(await allNodes(sessionOf(exec, 'think_open')), args.id, args.depth ?? 1)
      if (g.root === undefined) throw new Error(`no node ${args.id}; ephemeral ids reset when a new task starts (think_search lists what exists)`)
      return { node: g.root, related: g.related, missing: g.missing }
    },
  }
  return [think_add, think_search, think_open]
}

/**
 * Mount everything on a registrant context.
 * @param {object} ctx - carries `sessionProjections`, `tools`, `storageDomain`.
 * @param {{defineTool: (o: object) => object, now?: () => Date}} deps - the substrate's `defineTool`.
 * @returns {{store: ReturnType<typeof domainStore>, stash: object}} the persistent store handle and the subagent seed stash (tests use them).
 */
export function mount(ctx, { defineTool, now }) {
  const store = domainStore(ctx.storageDomain)
  // T-285/T-286/T-289: the context projection and its pre-step / pre-execute listeners (context.js).
  const { stash } = mountContext(ctx, { store })
  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateSchema,
    init: () => initState(),
    apply: foldThought,
    wire: { viewSchema: stateSchema, view: s => s },
    stateVersion: STATE_VERSION,
  })
  for (const spec of toolSpecs({ projections: ctx.sessionProjections, store, now })) ctx.tools.register(defineTool(spec))
  return { store, stash }
}
