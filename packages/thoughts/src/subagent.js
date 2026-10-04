/**
 * Explicit subagent seeding (T-289): a subagent receives only the nodes its parent names, by id,
 * in the subagent call - never the graph.
 *
 * How the ids travel. The subagent tool's parameters are fixed upstream
 * (packages/subagent/tool-subagent/src/index.ts:389-399) and `tools/pre-execute` may allow or deny
 * a call but not rewrite its arguments (packages/core/tools/src/index.ts:153, decision :607). So
 * the parent writes a marker in the prompt, `[thoughts: n-2 p-1]`. On the parent side the
 * `tools/pre-execute` listener (context.js) resolves the ids against what the parent can see,
 * DENIES the call with a reason when an id is unknown or the set is over its caps, and, once the
 * rest of the waterfall allows it, stashes the resolved nodes under the prompt text. On the child
 * side the first `agent/pre-step` finds its prompt among the claimed messages, takes the stash
 * entry (once), and enters the nodes as one durable context message, which the context
 * projection folds into the child's `seeds`. Identical prompts name identical ids, so keying by
 * prompt text cannot hand a child someone else's nodes.
 *
 * What is closed off implicitly: a child (header `origin: 'subagent'` or `delegationDepth > 0`,
 * upstream packages/core/session/src/types.ts:117,123) gets no T-285 baseline,
 * its think_search / think_open see its own nodes plus its seeds and never the project's
 * persistent store, and a fork's inherited thought records fold away at the cut (fold.js).
 * Limitation: only in-process children run this plugin; an out-of-process provider (Claude Code,
 * Codex, ACP) receives the marker as plain text and no nodes.
 * @module @finess/thoughts/subagent
 */

import { cappedLines } from './inject.js'
import { THOUGHT_ID_RE, idNumber } from './schema.js'

/** Tool names that delegate to a subagent (tool-subagent's default `toolName`, index.ts:108). */
export const SUBAGENT_TOOLS = Object.freeze(['subagent'])
export const MAX_SEED_NODES = 12
export const MAX_SEED_BYTES = 4096
/** Stash entries kept for children not yet started (oldest dropped). */
export const MAX_STASH = 32

const MARKER_RE = /\[thoughts?:([^\]]*)\]/gi

/** @typedef {import('./schema.js').ThoughtNode} ThoughtNode */

/**
 * The ids named by every `[thoughts: ...]` marker in a prompt.
 * @param {string} prompt - the subagent prompt.
 * @returns {{ids: string[], bad: string[]}} distinct valid ids in order, and tokens that are not ids.
 */
export function parseSeedIds(prompt) {
  const ids = []
  const bad = []
  for (const m of String(prompt).matchAll(MARKER_RE)) {
    for (const t of m[1].split(/[\s,]+/).filter(Boolean)) {
      if (!THOUGHT_ID_RE.test(t)) bad.push(t)
      else if (!ids.includes(t)) ids.push(t)
    }
  }
  return { ids, bad }
}

/**
 * One rendered line per seeded node (the child's view).
 * @param {ThoughtNode} n - the node.
 * @returns {string} the line.
 */
const seedLine = n => `- ${n.id} [${n.kind}, ${n.confidence}] ${n.claim}${n.evidence.length === 0 ? '' : ` (evidence: ${n.evidence.join('; ')})`}`

/**
 * Resolve the named ids against the parent's visible nodes and render the child's message.
 * @param {ThoughtNode[]} pool - every node the parent can see.
 * @param {string} prompt - the subagent prompt.
 * @returns {{nodes: ThoughtNode[], text: string}|{error: string}|undefined} the seed, why it is refused, or undefined without a marker.
 */
export function resolveSeed(pool, prompt) {
  const { ids, bad } = parseSeedIds(prompt)
  if (ids.length === 0 && bad.length === 0) return undefined
  if (bad.length > 0) return { error: `[thoughts: ...] takes node ids like n-2 or p-1; not ids: ${bad.join(', ')}` }
  const byId = new Map(pool.map(n => [n.id, n]))
  const unknown = ids.filter(id => !byId.has(id))
  if (unknown.length > 0) return { error: `[thoughts: ...] names unknown nodes: ${unknown.join(', ')} (known: ${[...byId.keys()].slice(-20).join(', ') || 'none'}; think_search lists them)` }
  if (ids.length > MAX_SEED_NODES) return { error: `[thoughts: ...] names ${ids.length} nodes; pass at most ${MAX_SEED_NODES}, the ones the subagent needs` }
  const nodes = ids.map(id => byId.get(id))
  const r = cappedLines('Thought nodes passed to you by the delegating agent (you see only these; think_open <id> reopens one):', nodes.map(n => ({ id: n.id, line: seedLine(n) })), {
    maxItems: MAX_SEED_NODES, maxBytes: MAX_SEED_BYTES, more: () => '',
  })
  if (r === undefined || r.ids.length < nodes.length) return { error: `[thoughts: ...] nodes exceed ${MAX_SEED_BYTES} bytes; pass fewer` }
  return { nodes, text: r.text }
}

/**
 * A bounded, consume-once stash from the parent's allowed call to the child's first step.
 * @param {number} [max] - entries kept.
 * @returns {{put: (prompt: string, seed: {nodes: ThoughtNode[], text: string}) => void,
 *   take: (texts: string[]) => {nodes: ThoughtNode[], text: string}|undefined, size: () => number}} the stash.
 */
export function seedStash(max = MAX_STASH) {
  /** @type {Map<string, {nodes: ThoughtNode[], text: string}>} */
  const m = new Map()
  return {
    put(prompt, seed) {
      m.delete(prompt)
      m.set(prompt, seed)
      while (m.size > max) m.delete(m.keys().next().value)
    },
    take(texts) {
      for (const [prompt, seed] of m) {
        if (texts.some(t => t.includes(prompt))) { m.delete(prompt); return seed }
      }
      return undefined
    },
    size: () => m.size,
  }
}

/**
 * Whether a session is a subagent child: no implicit graph for it. A user's fork is not a child.
 * @param {object|undefined} header - `session.header`.
 * @returns {boolean} a child.
 */
export const isChildSession = header => header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0

/**
 * The first free ephemeral id number above the seeds, so a child's own nodes never reuse one.
 * @param {ThoughtNode[]} seeds - seeded nodes.
 * @returns {number} the floor for the child's next `n-` id.
 */
export const seedFloor = seeds => Math.max(1, ...seeds.filter(n => n.id.startsWith('n-')).map(n => idNumber(n.id) + 1))
