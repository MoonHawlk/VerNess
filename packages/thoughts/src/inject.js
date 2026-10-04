/**
 * Frozen session-start injection (T-285): the project's persistent `constraint` nodes, rendered
 * once, hard-capped in count and bytes, and entered as one durable user-role context message at
 * the session's first step. Never recomputed: once the message is in the log the context
 * projection (context.js) holds it, and later store changes reach only later sessions. A session
 * that starts with no constraints gets nothing, then or later. Demoted stubs are never injected.
 *
 * Why a logged message and not a system-prompt section: a section's text is re-evaluated at every
 * assembly and its AssembleContext carries only a scope, no session (upstream
 * packages/core/system-prompt/src/index.ts:42-49, :66), so it cannot be frozen per session or
 * survive a process restart. A logged message is frozen by construction, resumes with the session,
 * and sits in the cached prefix. Seam: the `agent/pre-step` waterfall (context.js).
 * @module @finess/thoughts/inject
 */

import { isStubNode } from './evict.js'

/** Most constraint nodes injected. */
export const BASELINE_MAX_NODES = 12
/** Byte cap of the whole rendered baseline, header and overflow line included. */
export const BASELINE_MAX_BYTES = 1536

/** @typedef {import('./schema.js').ThoughtNode} ThoughtNode */

const utf8 = s => Buffer.byteLength(s, 'utf8')

/**
 * Render a header and one line per item, stopping at whichever cap binds first; a final line
 * counts what was left out, and that line fits inside the byte cap too.
 * @param {string} head - first line.
 * @param {{id: string, line: string}[]} items - candidate lines, in priority order.
 * @param {{maxItems: number, maxBytes: number, more: (n: number) => string}} caps - limits and the overflow line.
 * @returns {{text: string, ids: string[]}|undefined} the text and the ids it shows; undefined when nothing fits.
 */
export function cappedLines(head, items, { maxItems, maxBytes, more }) {
  const lines = [head]
  const ids = []
  for (const [i, it] of items.entries()) {
    const left = items.length - i - 1
    const tail = left > 0 ? `\n${more(left)}` : ''
    if (ids.length >= maxItems || utf8([...lines, it.line].join('\n') + tail) > maxBytes) break
    lines.push(it.line)
    ids.push(it.id)
  }
  if (ids.length === 0) return undefined
  const skipped = items.length - ids.length
  if (skipped > 0) lines.push(more(skipped))
  return { text: lines.join('\n'), ids }
}

/**
 * The constraint nodes eligible for the baseline, oldest first (stable across sessions).
 * @param {ThoughtNode[]} stored - the project's persistent nodes.
 * @returns {ThoughtNode[]} the constraints, stubs excluded.
 */
export const constraintNodes = stored => stored.filter(n => n.kind === 'constraint' && !isStubNode(n))

/**
 * Render the frozen baseline.
 * @param {ThoughtNode[]} stored - the project's persistent nodes.
 * @param {{maxNodes?: number, maxBytes?: number}} [caps] - overrides.
 * @returns {{text: string, ids: string[]}|undefined} the baseline, or undefined when there are no constraints.
 */
export function renderBaseline(stored, { maxNodes = BASELINE_MAX_NODES, maxBytes = BASELINE_MAX_BYTES } = {}) {
  const items = constraintNodes(stored).map(n => ({ id: n.id, line: `- ${n.id}: ${n.claim}` }))
  return cappedLines('Project constraints from the thought graph (fixed for this session; think_open <id> for evidence):', items, {
    maxItems: maxNodes,
    maxBytes,
    more: k => `(${k} more constraint${k === 1 ? '' : 's'}: think_search with kind "constraint")`,
  })
}
