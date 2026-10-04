import type { Issue, Result } from './issue.ts'
import { isObject, unknownFields } from './validate-helpers.ts'

/**
 * Thought-graph node vocabulary (docs/10-THOUGHT-GRAPH.md, T-281). The runtime copy of this
 * validator lives in `packages/thoughts/src/schema.js` (plain JS: the dsh plugin is installed as a
 * `file:` copy under the profile's node_modules, where Node will not strip types). The two are kept
 * identical by `scripts/test/thoughts.parity.test.mjs`; change both or neither.
 */
export const THOUGHT_SCOPES = ['ephemeral', 'persistent'] as const
export type ThoughtScope = typeof THOUGHT_SCOPES[number]

export const THOUGHT_KINDS = ['attempt', 'finding', 'decision', 'constraint', 'artifact'] as const
export type ThoughtKind = typeof THOUGHT_KINDS[number]

/** `verified` means the evidence was read in-turn; `asserted` means the model only claims it. */
export const THOUGHT_CONFIDENCE = ['verified', 'asserted'] as const
export type ThoughtConfidence = typeof THOUGHT_CONFIDENCE[number]

/** One sentence, at most this many characters: a node that needs more is a document. */
export const MAX_CLAIM_CHARS = 200
/** Bounds on the evidence list and each entry (a pointer, not a transcript). */
export const MAX_EVIDENCE_ITEMS = 8
export const MAX_EVIDENCE_CHARS = 300
/** Bound on the edge list of one node. */
export const MAX_DERIVED_FROM = 16

/** Ephemeral ids are `n-<k>` (reset per task); persistent ids are `p-<k>` (per project). */
export const THOUGHT_ID_RE = /^[np]-[1-9][0-9]*$/

export const THOUGHT_FIELDS = ['id', 'scope', 'kind', 'claim', 'evidence', 'confidence', 'derivedFrom', 'turn', 'at'] as const

export interface ThoughtNode {
  id: string
  scope: ThoughtScope
  kind: ThoughtKind
  /** One sentence, <= MAX_CLAIM_CHARS. */
  claim: string
  evidence: string[]
  confidence: ThoughtConfidence
  /** The edges: ids this node was derived from. */
  derivedFrom: string[]
  turn: number
  /** ISO-8601 UTC timestamp. */
  at: string
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/**
 * Why `claim` is not one sentence of at most MAX_CLAIM_CHARS, or undefined when it is. One sentence:
 * no line break, and no sentence end (`.`, `!` or `?` then a space) followed by a capital letter.
 */
export function claimProblem(claim: string): string | undefined {
  const c = claim.trim()
  if (c === '') return 'required: a non-empty sentence'
  if (c.length > MAX_CLAIM_CHARS) return `${c.length} characters exceeds the limit of ${MAX_CLAIM_CHARS}; a longer thought is a document - write an artifact and point at it`
  if (/[\r\n]/.test(c)) return 'must be one sentence (no line breaks)'
  if (/[.!?]["')\]]?\s+[A-Z]/.test(c)) return 'must be one sentence; record each further sentence as its own node'
  return undefined
}

function stringList(v: unknown, path: string, max: number, maxChars: number, errors: Issue[], check?: (s: string) => string | undefined): string[] {
  if (!Array.isArray(v)) { errors.push({ path: [path], message: 'expected an array of strings' }); return [] }
  if (v.length > max) errors.push({ path: [path], message: `${v.length} entries exceeds the limit of ${max}` })
  const seen = new Set<string>()
  const out: string[] = []
  v.forEach((item: unknown, i) => {
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
 */
export function validateThoughtNode(v: unknown): Result<ThoughtNode> {
  if (!isObject(v)) return { ok: false, errors: [{ path: [], message: 'expected an object' }] }
  const errors: Issue[] = []
  unknownFields(v, THOUGHT_FIELDS, [], errors)
  const { id, scope, kind, claim, confidence, turn, at } = v
  if (typeof id !== 'string' || !THOUGHT_ID_RE.test(id)) errors.push({ path: ['id'], message: 'expected an id like "n-7" or "p-3"' })
  if (!THOUGHT_SCOPES.includes(scope as ThoughtScope)) errors.push({ path: ['scope'], message: `expected one of ${THOUGHT_SCOPES.join(', ')}` })
  if (typeof id === 'string' && THOUGHT_ID_RE.test(id) && THOUGHT_SCOPES.includes(scope as ThoughtScope) && (id[0] === 'p') !== (scope === 'persistent')) {
    errors.push({ path: ['id'], message: 'an ephemeral id starts with "n-", a persistent one with "p-"' })
  }
  if (!THOUGHT_KINDS.includes(kind as ThoughtKind)) errors.push({ path: ['kind'], message: `expected one of ${THOUGHT_KINDS.join(', ')}` })
  if (typeof claim !== 'string') errors.push({ path: ['claim'], message: 'required: a string' })
  else { const p = claimProblem(claim); if (p !== undefined) errors.push({ path: ['claim'], message: p }) }
  const evidence = stringList(v['evidence'], 'evidence', MAX_EVIDENCE_ITEMS, MAX_EVIDENCE_CHARS, errors)
  if (!THOUGHT_CONFIDENCE.includes(confidence as ThoughtConfidence)) errors.push({ path: ['confidence'], message: `expected one of ${THOUGHT_CONFIDENCE.join(', ')}` })
  else if (confidence === 'verified' && Array.isArray(v['evidence']) && v['evidence'].length === 0) errors.push({ path: ['confidence'], message: '"verified" needs at least one evidence entry' })
  const derivedFrom = stringList(v['derivedFrom'], 'derivedFrom', MAX_DERIVED_FROM, 32, errors, s => (THOUGHT_ID_RE.test(s) ? (s === id ? 'a node cannot derive from itself' : undefined) : 'expected an id like "n-7" or "p-3"'))
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0) errors.push({ path: ['turn'], message: 'expected a non-negative integer' })
  if (typeof at !== 'string' || !ISO_RE.test(at) || Number.isNaN(Date.parse(at))) errors.push({ path: ['at'], message: 'expected an ISO-8601 UTC timestamp' })
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      id: id as string, scope: scope as ThoughtScope, kind: kind as ThoughtKind, claim: (claim as string).trim(),
      evidence, confidence: confidence as ThoughtConfidence, derivedFrom, turn: turn as number, at: at as string,
    },
  }
}
