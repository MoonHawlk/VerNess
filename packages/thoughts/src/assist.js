/**
 * Decision-model assist (T-295), the pure half: the two questions Laya is asked about a new node,
 * and the rule baseline it is scored against. SHADOW ONLY - nothing here (or in the launcher half,
 * scripts/lib/thought-assist.mjs) ever acts on an answer.
 *
 * Both questions go in ONE call (one forward pass):
 *  - `persist`: worth persisting? yes | no. Rule baseline: no (persistence is the operator's act).
 *  - `contradicts`: none, or one of up to 7 persistent candidates picked by search over the claim
 *    (<= 8 options in all). Rule baseline: the structural rule of src/conflicts.js. Asked only when
 *    there is at least one candidate - a choice needs two options.
 * @module @finess/thoughts/assist
 */

import { contradiction } from './conflicts.js'
import { searchNodes } from './search.js'

/** Most candidates offered beside `none` (8 options in all, the decision protocol's limit). */
export const MAX_CANDIDATES = 7

export const PERSIST_QUESTION = Object.freeze({
  type: 'choice',
  instructions: 'This is one conclusion an engineering agent recorded while working. Is it worth keeping across future sessions of this project?',
  criteria: {
    yes: 'durable and reusable: a fact, constraint or decision about the project that later sessions should not re-derive',
    no: 'specific to this task, transient, speculative or trivially re-derived',
  },
})

/**
 * @param {import('./schema.js').ThoughtNode} node - the new node.
 * @param {import('./schema.js').ThoughtNode[]} stored - the project's persistent nodes.
 * @returns {import('./schema.js').ThoughtNode[]} up to MAX_CANDIDATES the claim most resembles.
 */
export const candidatesFor = (node, stored) => searchNodes(stored, node.claim, { limit: MAX_CANDIDATES }).map(h => h.node)

/**
 * The questions for one node.
 * @param {import('./schema.js').ThoughtNode} node - the new node.
 * @param {import('./schema.js').ThoughtNode[]} stored - the project's persistent nodes.
 * @returns {{questions: Record<string, object>, candidates: string[]}} the typed questions and the candidate ids.
 */
export function assistQuestions(node, stored) {
  const cands = candidatesFor(node, stored)
  const questions = { persist: PERSIST_QUESTION }
  if (cands.length > 0) {
    questions.contradicts = {
      type: 'choice',
      instructions: 'Does the new conclusion contradict one of these stored conclusions? Pick the one it contradicts, or none.',
      criteria: { none: 'it contradicts none of them', ...Object.fromEntries(cands.map(n => [n.id, n.claim])) },
    }
  }
  return { questions, candidates: cands.map(n => n.id) }
}

/**
 * The text the model decides about.
 * @param {import('./schema.js').ThoughtNode} node - the new node.
 * @returns {string} the state document.
 */
export const assistState = node => [
  `NEW CONCLUSION (${node.kind}, ${node.confidence}): ${node.claim}`,
  ...(node.evidence.length === 0 ? [] : [`EVIDENCE: ${node.evidence.join('; ')}`]),
].join('\n')

/**
 * The rules' answers, for the same questions.
 * @param {import('./schema.js').ThoughtNode} node - the new node.
 * @param {import('./schema.js').ThoughtNode[]} stored - the persistent nodes.
 * @param {string[]} candidates - the ids offered (the rule may only name one of them).
 * @returns {Record<string, string>} `persist`, and `contradicts` when it was asked.
 */
export function assistRules(node, stored, candidates) {
  const out = { persist: 'no' }
  if (candidates.length === 0) return out
  const hit = stored.find(s => candidates.includes(s.id) && contradiction(node.claim, s.claim) !== undefined)
  out.contradicts = hit?.id ?? 'none'
  return out
}
