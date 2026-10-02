import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_CHOICE_OPTIONS, validateChoiceQuestion } from '../src/decision.ts'

const options = (n: number): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, `option ${i}`]))
const q = (criteria: unknown, extra: Record<string, unknown> = {}): unknown => ({ type: 'choice', instructions: 'Pick one.', criteria, ...extra })

test('MAX_CHOICE_OPTIONS is 8', () => {
  assert.equal(MAX_CHOICE_OPTIONS, 8)
})

test('a choice with 2..8 options is valid and normalised', () => {
  for (const n of [2, 5, MAX_CHOICE_OPTIONS]) {
    const r = validateChoiceQuestion(q(options(n)))
    assert.equal(r.ok, true, `n=${n}`)
    if (r.ok) assert.equal(Object.keys(r.value.criteria).length, n)
  }
})

test('more than 8 options is rejected with the limit named', () => {
  const r = validateChoiceQuestion(q(options(MAX_CHOICE_OPTIONS + 1)))
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.deepEqual(r.errors.map(e => e.path), [['criteria']])
    assert.match(r.errors[0]!.message, /9 options exceeds the limit of 8/)
  }
})

test('fewer than 2 options is rejected', () => {
  for (const n of [0, 1]) {
    const r = validateChoiceQuestion(q(options(n)))
    assert.equal(r.ok, false, `n=${n}`)
  }
})

test('shape errors: not an object, wrong type, empty instructions, non-string description', () => {
  assert.equal(validateChoiceQuestion(null).ok, false)
  assert.equal(validateChoiceQuestion([]).ok, false)
  const r = validateChoiceQuestion({ type: 'score', instructions: ' ', criteria: { a: 'x', b: 2 } })
  assert.equal(r.ok, false)
  if (!r.ok) assert.deepEqual(r.errors.map(e => e.path), [['type'], ['instructions'], ['criteria', 'b']])
  const missing = validateChoiceQuestion({ type: 'choice', instructions: 'Pick.' })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.deepEqual(missing.errors.map(e => e.path), [['criteria']])
})
