/**
 * Compaction digest (T-286): after the substrate compacts a session, the current task's `finding`
 * and `decision` nodes are rendered into one durable context message entered with the next step,
 * so they survive as structure rather than as the summariser's prose. The session's frozen block
 * (the T-285 constraints, or a subagent's seeded nodes) is repeated verbatim from the log, because
 * the compacted range may have swallowed it.
 *
 * Trigger: a `compaction/summary` event (upstream packages/compaction/compaction/src/types.ts:34)
 * newer than the last digest. compaction-basic compacts inside the `agent/pre-step` waterfall
 * (packages/compaction/compaction-basic/src/index.ts:158-176), so the listener (context.js) checks
 * only after `await next()` and sees the compaction whatever the listener order. A model-free
 * `compaction/prune` does not count (it shortens tool output, not reasoning). An overflow
 * compaction (compaction-basic/src/index.ts:190-218) retries without a pre-step; its digest
 * enters with the following step.
 * @module @finess/thoughts/compact
 */

import { cappedLines } from './inject.js'

export const DIGEST_KINDS = Object.freeze(['finding', 'decision'])
/** Most nodes in one digest (newest kept). */
export const DIGEST_MAX_NODES = 24
/** Byte cap of the node part (the frozen block is capped where it was made). */
export const DIGEST_MAX_BYTES = 3072

/** @typedef {import('./schema.js').ThoughtNode} ThoughtNode */

/**
 * Render the digest.
 * @param {ThoughtNode[]} nodes - this task's ephemeral nodes, in append order.
 * @param {string|undefined} frozen - the session's frozen block, verbatim, if any.
 * @param {{maxNodes?: number, maxBytes?: number}} [caps] - overrides.
 * @returns {{text: string, ids: string[]}|undefined} the digest, or undefined when there is nothing to carry.
 */
export function renderDigest(nodes, frozen, { maxNodes = DIGEST_MAX_NODES, maxBytes = DIGEST_MAX_BYTES } = {}) {
  const items = nodes.filter(n => DIGEST_KINDS.includes(n.kind)).reverse().map(n => ({
    id: n.id,
    line: `- ${n.id} [${n.kind}, ${n.confidence}] ${n.claim}${n.derivedFrom.length === 0 ? '' : ` (from ${n.derivedFrom.join(', ')})`}`,
  }))
  const body = cappedLines('This task\'s findings and decisions so far (from the thought graph, newest first; think_open <id> for evidence):', items, {
    maxItems: maxNodes,
    maxBytes,
    more: k => `(${k} older: think_search)`,
  })
  const parts = [...(frozen === undefined || frozen === '' ? [] : [frozen]), ...(body === undefined ? [] : [body.text])]
  if (parts.length === 0) return undefined
  return { text: ['Context was compacted. Carried over:', ...parts].join('\n\n'), ids: body?.ids ?? [] }
}
