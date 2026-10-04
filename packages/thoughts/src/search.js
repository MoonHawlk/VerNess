/**
 * On-demand retrieval over nodes (the "tier 2" of docs/10-THOUGHT-GRAPH.md): zero standing cost,
 * the model pulls what it needs. Pure; the caller supplies the nodes of both tiers.
 * @module @finess/thoughts/search
 */

/** @typedef {import('./schema.js').ThoughtNode} ThoughtNode */

/** @param {string} s @returns {string[]} lower-case word tokens of at least two characters. */
export const tokens = s => String(s).toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(t => t.length >= 2)

/**
 * Rank nodes against a free-text query: each query token found in the claim scores 2, in the
 * evidence 1; a node scoring 0 is dropped. Ties keep the newer node first (persistent before
 * ephemeral only by score, never by tier).
 * @param {ThoughtNode[]} nodes - candidates.
 * @param {string} query - free text; empty matches everything.
 * @param {{kind?: string, scope?: string, limit?: number}} [opts] - filters and a cap (default 10).
 * @returns {{node: ThoughtNode, score: number}[]} the hits, best first.
 */
export function searchNodes(nodes, query, { kind, scope, limit = 10 } = {}) {
  const q = [...new Set(tokens(query))]
  const hits = []
  nodes.forEach((node, order) => {
    if (kind !== undefined && node.kind !== kind) return
    if (scope !== undefined && scope !== 'all' && node.scope !== scope) return
    const claim = new Set(tokens(node.claim))
    const ev = new Set(node.evidence.flatMap(tokens))
    const score = q.length === 0 ? 1 : q.reduce((s, t) => s + (claim.has(t) ? 2 : ev.has(t) ? 1 : 0), 0)
    if (score > 0) hits.push({ node, score, order })
  })
  hits.sort((a, b) => b.score - a.score || b.order - a.order)
  return hits.slice(0, Math.max(0, limit)).map(({ node, score }) => ({ node, score }))
}

/**
 * A node and what it was derived from, breadth-first up to `depth` edges away. Missing ids (a
 * forgotten or reset node) are reported, not invented.
 * @param {ThoughtNode[]} nodes - every reachable node.
 * @param {string} id - the root.
 * @param {number} [depth] - edges to follow (default 1, at most 3).
 * @returns {{root: ThoughtNode|undefined, related: ThoughtNode[], missing: string[]}} the subgraph.
 */
export function subgraph(nodes, id, depth = 1) {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const root = byId.get(id)
  if (root === undefined) return { root: undefined, related: [], missing: [id] }
  const seen = new Set([id])
  const related = []
  const missing = []
  let frontier = [root]
  for (let d = 0; d < Math.min(Math.max(0, depth), 3) && frontier.length > 0; d++) {
    const next = []
    for (const n of frontier) {
      for (const parent of n.derivedFrom) {
        if (seen.has(parent)) continue
        seen.add(parent)
        const p = byId.get(parent)
        if (p === undefined) { missing.push(parent); continue }
        related.push(p)
        next.push(p)
      }
    }
    frontier = next
  }
  return { root, related, missing }
}

/**
 * One line per node: `id [kind, confidence] claim`.
 * @param {ThoughtNode} n - the node.
 * @returns {string} the line.
 */
export const nodeLine = n => `${n.id} [${n.kind}, ${n.confidence}] ${n.claim}`

/**
 * A node in full, for `think_open` and `/think show`.
 * @param {ThoughtNode} n - the node.
 * @returns {string[]} the lines.
 */
export function nodeDetail(n) {
  return [
    nodeLine(n),
    `  scope ${n.scope}, turn ${n.turn}, at ${n.at}`,
    ...(n.evidence.length === 0 ? ['  evidence: none'] : n.evidence.map(e => `  evidence: ${e}`)),
    ...(n.derivedFrom.length === 0 ? [] : [`  derived from: ${n.derivedFrom.join(', ')}`]),
  ]
}
