/**
 * @finess/thoughts - the thought graph's foundation (docs/10-THOUGHT-GRAPH.md, T-280..T-284).
 *
 * Two tiers:
 * - ephemeral: nodes the model records with `think_add` during a task. Each is a `thought/node`
 *   record carried in its own `tool/result.meta` (see src/fold.js for why not a bespoke
 *   SessionEvent), folded by the `thoughts` session projection, reset when a human prompt starts a
 *   new task. Log-derived, so it survives resume and compaction.
 * - persistent: nodes promoted on purpose (`/think promote`) or written by the operator
 *   (`/think add`), kept in ctx.storage (domain `finess_thoughts`, one record per project), capped
 *   in bytes, erroring when full.
 *
 * Public surface (stable for T-285..T-297; import from '@finess/thoughts' or the src module):
 *   schema   THOUGHT_SCOPES, THOUGHT_KINDS, THOUGHT_CONFIDENCE, MAX_CLAIM_CHARS, MAX_EVIDENCE_ITEMS,
 *            MAX_EVIDENCE_CHARS, MAX_DERIVED_FROM, THOUGHT_ID_RE, THOUGHT_FIELDS,
 *            validateThoughtNode(v), buildNode(input, stamp), claimProblem(claim), formatIssues(errs),
 *            isPlainObject(v), idNumber(id)
 *   fold     PROJECTION_KEY, STATE_VERSION, RECORD_KIND, RECORD_VERSION, MAX_EPHEMERAL_NODES,
 *            initState(), foldThought(state, event), foldEvents(events, from?), recordOf(event),
 *            isTaskStart(event), nodeRecord(node), stateSchema
 *   search   searchNodes(nodes, query, opts), subgraph(nodes, id, depth), nodeLine(n), nodeDetail(n), tokens(s)
 *   store    DOMAIN_NAME, DOMAIN_VERSION, TABLE, DEFAULT_CAP_BYTES, DOMAIN_SPEC, ThoughtStoreFullError,
 *            projectKey(dir), emptyProject(), recordBytes(r), parseProject(v), findStored(r, id),
 *            addPersistent(r, input, opts), promote(r, eph, opts), link(r, a, b, opts), forget(r, id),
 *            verifyStored(r, node), storedNodes(r)
 *   adapters domainStore(ctx.storageDomain), fileStore(file), storeFile(dshHome), readUnit(file), writeUnit(file, map)
 *   plugin   mount(ctx, {defineTool}), toolSpecs(deps), sessionState(projections, session)
 *   (T-285..T-289)
 *   context  CONTEXT_KEY, CONTEXT_STATE_VERSION, SOURCE_KIND, initContext(), foldContext(s, e), contextSchema,
 *            contextState(projections, session), visibleNodes(deps), contextMessage(part, text, extra),
 *            messagesFor(session, claimed, deps), mountContext(ctx, {store}), projectOf(session)
 *   inject   BASELINE_MAX_NODES, BASELINE_MAX_BYTES, cappedLines(head, items, caps), constraintNodes(stored), renderBaseline(stored)
 *   compact  DIGEST_KINDS, DIGEST_MAX_NODES, DIGEST_MAX_BYTES, renderDigest(nodes, frozen)
 *   evidence READ_TOOLS, taskSegment(events), turnReads(events, turn), normPath(p), pointerOf(token),
 *            namesRead(entry, read, cwd), gateVerified(node, reads, cwd), gatePromotion(eph, events, cwd)
 *   evict    STUB_PREFIX, RECOVER_PREFIX, STUB_CLAIM_CHARS, DEMOTE_ORDER, isStubNode(n), demotable(s), recoveryOf(n),
 *            stubOf(s), demoteToFit(r, cap, protect), findOriginal(stub, events), restoreStub(r, id, original)
 *   subagent SUBAGENT_TOOLS, MAX_SEED_NODES, MAX_SEED_BYTES, MAX_STASH, parseSeedIds(prompt), resolveSeed(pool, prompt),
 *            seedStash(max), isChildSession(header), seedFloor(seeds)
 *   fold     also isForkCut(event); STATE_VERSION is 2 (a fork cut folds the graph to empty)
 *
 * Only this file imports the substrate (`defineTool`); everything under src/ is plain Node.
 * @module @finess/thoughts
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { mount } from './src/plugin.js'

export * from './src/schema.js'
export * from './src/fold.js'
export * from './src/search.js'
export * from './src/store.js'
export * from './src/adapters.js'
export * from './src/context.js'
export * from './src/inject.js'
export * from './src/compact.js'
export * from './src/evidence.js'
export * from './src/evict.js'
export * from './src/subagent.js'
export { mount, sessionState, toolSpecs } from './src/plugin.js'

export const name = 'finess-thoughts'
export const inject = ['tools', 'sessionProjections', 'storageDomain']

/**
 * Mount the projection and the three tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - registrant context.
 */
export function apply(ctx) {
  mount(ctx, { defineTool })
}
