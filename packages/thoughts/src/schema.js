/**
 * Thought-node schema and boundary validation (T-281). Runtime twin of
 * `packages/contracts/src/thought.ts`, kept in plain JS because this package is installed into the
 * dsh profile as a `file:` copy under node_modules, where Node refuses to strip TypeScript.
 * `scripts/test/thoughts.parity.test.mjs` pins the two together: change both or neither.
 * @module @finess/thoughts/schema
 */

export const THOUGHT_SCOPES = Object.freeze(['ephemeral', 'persistent'])
export const THOUGHT_KINDS = Object.freeze(['attempt', 'finding', 'decision', 'constraint', 'artifact'])
export const THOUGHT_CONFIDENCE = Object.freeze(['verified', 'asserted'])
export const MAX_CLAIM_CHARS = 200
export const MAX_EVIDENCE_ITEMS = 8
export const MAX_EVIDENCE_CHARS = 300
export const MAX_DERIVED_FROM = 16
export const THOUGHT_ID_RE = /^[np]-[1-9][0-9]*$/
export const THOUGHT_FIELDS = Object.freeze(['id', 'scope', 'kind', 'claim', 'evidence', 'confidence', 'derivedFrom', 'turn', 'at'])

/**
 * @typedef {object} ThoughtNode
 * @property {string} id - `n-<k>` ephemeral, `p-<k>` persistent.
 * @property {'ephemeral'|'persistent'} scope - lifetime.
 * @property {'attempt'|'finding'|'decision'|'constraint'|'artifact'} kind - what the node records.
 * @property {string} claim - one sentence, <= MAX_CLAIM_CHARS.
 * @property {string[]} evidence - pointers backing the claim.
 * @property {'verified'|'asserted'} confidence - verified == evidence was read in-turn.
 * @property {string[]} derivedFrom - the edges.
 * @property {number} turn - the turn that produced it (0 for operator-written nodes).
 * @property {string} at - ISO-8601 UTC timestamp.
 */
/** @typedef {{path: (string|number)[], message: string}} Issue */
/** @template T @typedef {{ok: true, value: T} | {ok: false, errors: Issue[]}} Result */

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/** @param {unknown} v @returns {v is Record<string, unknown>} a plain object. */
export function isPlainObject(v) {
  if (typeof v !== 'object' || v === null) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Why `claim` is not one sentence of at most MAX_CLAIM_CHARS, or undefined when it is.
 * @param {string} claim - the candidate claim.
 * @returns {string|undefined} the problem.
 */
export function claimProblem(claim) {
  const c = claim.trim()
  if (c === '') return 'required: a non-empty sentence'
  if (c.length > MAX_CLAIM_CHARS) return `${c.length} characters exceeds the limit of ${MAX_CLAIM_CHARS}; a longer thought is a document - write an artifact and point at it`
  if (/[\r\n]/.test(c)) return 'must be one sentence (no line breaks)'
  if (/[.!?]["')\]]?\s+[A-Z]/.test(c)) return 'must be one sentence; record each further sentence as its own node'
  return undefined
}

/**
 * @param {unknown} v - candidate list.
 * @param {string} path - field name.
 * @param {number} max - most entries.
 * @param {number} maxChars - longest entry.
 * @param {Issue[]} errors - sink.
 * @param {(s: string) => string|undefined} [check] - extra per-entry rule.
 * @returns {string[]} the accepted entries.
 */
function stringList(v, path, max, maxChars, errors, check) {
  if (!Array.isArray(v)) { errors.push({ path: [path], message: 'expected an array of strings' }); return [] }
  if (v.length > max) errors.push({ path: [path], message: `${v.length} entries exceeds the limit of ${max}` })
  const seen = new Set()
  const out = []
  v.forEach((item, i) => {
    if (typeof item !== 'string' || item.trim() === '') { errors.push({ path: [path, i], message: 'must be a non-empty string' }); return }
    if (item.length > maxChars) { errors.push({ path: [path, i], message: `${item.length} characters exceeds the limit of ${maxChars}` }); return }
    if (seen.has(item)) { errors.push({ path: [path, i], message: `"${item}" is listed more than once` }); return }
    const problem = check?.(item)
    if (problem !== undefined) { errors.push({ path: [path, i], message: problem }); return }
    seen.add(item)
    out.push(item)
  })
  return out
}

/**
 * Check one complete node at a boundary (event fold, store read, tool output). Every field is
 * required, unknown fields are refused, the claim is trimmed, and `verified` needs evidence.
 * @param {unknown} v - the candidate.
 * @returns {Result<ThoughtNode>} the normalised node, or every issue found.
 */
export function validateThoughtNode(v) {
  if (!isPlainObject(v)) return { ok: false, errors: [{ path: [], message: 'expected an object' }] }
  /** @type {Issue[]} */
  const errors = []
  for (const key of Object.keys(v)) if (!THOUGHT_FIELDS.includes(key)) errors.push({ path: [key], message: `unknown field "${key}"` })
  const { id, scope, kind, claim, confidence, turn, at } = v
  const idOk = typeof id === 'string' && THOUGHT_ID_RE.test(id)
  if (!idOk) errors.push({ path: ['id'], message: 'expected an id like "n-7" or "p-3"' })
  if (!THOUGHT_SCOPES.includes(scope)) errors.push({ path: ['scope'], message: `expected one of ${THOUGHT_SCOPES.join(', ')}` })
  if (idOk && THOUGHT_SCOPES.includes(scope) && (id[0] === 'p') !== (scope === 'persistent')) {
    errors.push({ path: ['id'], message: 'an ephemeral id starts with "n-", a persistent one with "p-"' })
  }
  if (!THOUGHT_KINDS.includes(kind)) errors.push({ path: ['kind'], message: `expected one of ${THOUGHT_KINDS.join(', ')}` })
  if (typeof claim !== 'string') errors.push({ path: ['claim'], message: 'required: a string' })
  else { const p = claimProblem(claim); if (p !== undefined) errors.push({ path: ['claim'], message: p }) }
  const evidence = stringList(v.evidence, 'evidence', MAX_EVIDENCE_ITEMS, MAX_EVIDENCE_CHARS, errors)
  if (!THOUGHT_CONFIDENCE.includes(confidence)) errors.push({ path: ['confidence'], message: `expected one of ${THOUGHT_CONFIDENCE.join(', ')}` })
  else if (confidence === 'verified' && Array.isArray(v.evidence) && v.evidence.length === 0) errors.push({ path: ['confidence'], message: '"verified" needs at least one evidence entry' })
  const derivedFrom = stringList(v.derivedFrom, 'derivedFrom', MAX_DERIVED_FROM, 32, errors, s => (THOUGHT_ID_RE.test(s) ? (s === id ? 'a node cannot derive from itself' : undefined) : 'expected an id like "n-7" or "p-3"'))
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0) errors.push({ path: ['turn'], message: 'expected a non-negative integer' })
  if (typeof at !== 'string' || !ISO_RE.test(at) || Number.isNaN(Date.parse(at))) errors.push({ path: ['at'], message: 'expected an ISO-8601 UTC timestamp' })
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { id, scope, kind, claim: claim.trim(), evidence, confidence, derivedFrom, turn, at } }
}

/**
 * Build a full node from what a writer supplies (the model through `think_add`, the operator through
 * `/think add`) and validate it. Defaults: no evidence, `asserted`, no edges.
 * @param {unknown} input - `{kind, claim, evidence?, confidence?, derivedFrom?}`.
 * @param {{id: string, scope: 'ephemeral'|'persistent', turn: number, at: string}} stamp - writer-owned fields.
 * @returns {Result<ThoughtNode>} the node, or every issue (paths are the input's).
 */
export function buildNode(input, stamp) {
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: [], message: 'expected an object' }] }
  const allowed = ['kind', 'claim', 'evidence', 'confidence', 'derivedFrom']
  const extra = Object.keys(input).filter(k => !allowed.includes(k))
  if (extra.length > 0) return { ok: false, errors: extra.map(k => ({ path: [k], message: `unknown field "${k}" (the writer sets id, scope, turn and at)` })) }
  return validateThoughtNode({
    id: stamp.id, scope: stamp.scope, kind: input.kind, claim: input.claim,
    evidence: input.evidence ?? [], confidence: input.confidence ?? 'asserted', derivedFrom: input.derivedFrom ?? [],
    turn: stamp.turn, at: stamp.at,
  })
}

/**
 * @param {Issue[]} errors - validation issues.
 * @returns {string} one line, `path: message; ...`.
 */
export function formatIssues(errors) {
  return errors.map(e => `${e.path.length === 0 ? '(node)' : e.path.join('.')}: ${e.message}`).join('; ')
}

/** @param {string} id @returns {number} the numeric part of an `n-`/`p-` id. */
export const idNumber = id => Number(String(id).slice(2))
