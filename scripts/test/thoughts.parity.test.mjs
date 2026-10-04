/**
 * The thought-node vocabulary exists twice: as the contract (`packages/contracts/src/thought.ts`)
 * and as the plugin's runtime copy (`packages/thoughts/src/schema.js`, plain JS because the plugin is
 * a `file:` copy under node_modules, where Node will not strip types). This pins them together.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as C from '../../packages/contracts/src/thought.ts'
import * as J from '../../packages/thoughts/src/schema.js'

const AT = '2026-10-03T12:00:00.000Z'
const base = { id: 'n-1', scope: 'ephemeral', kind: 'finding', claim: 'It holds.', evidence: [], confidence: 'asserted', derivedFrom: [], turn: 0, at: AT }

test('constants match', () => {
  for (const k of ['THOUGHT_SCOPES', 'THOUGHT_KINDS', 'THOUGHT_CONFIDENCE', 'MAX_CLAIM_CHARS', 'MAX_EVIDENCE_ITEMS', 'MAX_EVIDENCE_CHARS', 'MAX_DERIVED_FROM', 'THOUGHT_FIELDS']) {
    assert.deepEqual([C[k]].flat(), [J[k]].flat(), k)
  }
  assert.equal(C.THOUGHT_ID_RE.source, J.THOUGHT_ID_RE.source)
})

test('both validators agree on every fixture (verdict, issue paths, normalised value)', () => {
  const fixtures = [
    base,
    { ...base, claim: '  padded.  ', evidence: ['a:1'], confidence: 'verified', derivedFrom: ['n-2', 'p-1'] },
    { ...base, id: 'p-3', scope: 'persistent' },
    { ...base, id: 'p-3' },
    { ...base, id: 'n-0' },
    { ...base, kind: 'idea' },
    { ...base, claim: 'x'.repeat(201) },
    { ...base, claim: 'One. Two.' },
    { ...base, claim: 'a\nb' },
    { ...base, confidence: 'verified' },
    { ...base, evidence: ['a', 'a', ''] },
    { ...base, evidence: Array.from({ length: 9 }, (_, i) => `e${i}`) },
    { ...base, derivedFrom: ['n-1'] },
    { ...base, derivedFrom: ['x'] },
    { ...base, turn: 1.5 },
    { ...base, at: '2026-10-03' },
    { ...base, extra: true },
    [],
    null,
    'node',
  ]
  for (const f of fixtures) {
    const c = C.validateThoughtNode(f)
    const j = J.validateThoughtNode(f)
    assert.equal(j.ok, c.ok, JSON.stringify(f))
    if (c.ok) assert.deepEqual(j.value, c.value)
    else assert.deepEqual(j.errors.map(e => e.path), c.errors.map(e => e.path), JSON.stringify(f))
  }
})

test('claimProblem agrees', () => {
  for (const s of ['ok.', '', 'A. B', 'e.g. this', 'x'.repeat(200), 'x'.repeat(201), 'Done! Next', 'Is it? yes']) {
    assert.equal(J.claimProblem(s), C.claimProblem(s), s)
  }
})
