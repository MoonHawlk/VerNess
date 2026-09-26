import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  capabilityGaps,
  levelRank,
  mergeRequirements,
  validateCapabilities,
} from '../src/capabilities.ts'

test('levelRank', () => {
  assert.equal(levelRank(undefined), 0)
  assert.equal(levelRank('none'), 0)
  assert.equal(levelRank('low'), 1)
  assert.equal(levelRank('medium'), 2)
  assert.equal(levelRank('high'), 3)
})

test('capabilityGaps: per key, missing means none', () => {
  assert.deepEqual(capabilityGaps({}, { code: 'low' }), ['code: none < low'])
  assert.deepEqual(capabilityGaps({ code: 'low' }, { code: 'low' }), [])
  assert.deepEqual(capabilityGaps({ code: 'medium' }, { code: 'low' }), [])
})

test('capabilityGaps: context numeric', () => {
  assert.deepEqual(capabilityGaps({}, { context: 8000 }), ['context: 0 < 8000'])
  assert.deepEqual(capabilityGaps({ context: 8000 }, { context: 8000 }), [])
  assert.deepEqual(capabilityGaps({ context: 4000 }, { context: 8000 }), ['context: 4000 < 8000'])
})

test('capabilityGaps: multiple gaps collected in key order', () => {
  assert.deepEqual(
    capabilityGaps({}, { code: 'low', reasoning: 'high', context: 100 }),
    ['code: none < low', 'reasoning: none < high', 'context: 0 < 100'],
  )
})

test('capabilityGaps: empty means eligible', () => {
  assert.deepEqual(capabilityGaps({ code: 'high', context: 100000 }, {}), [])
})

test('mergeRequirements: no args returns empty object', () => {
  assert.deepEqual(mergeRequirements(), {})
})

test('mergeRequirements: stricter level wins', () => {
  assert.deepEqual(mergeRequirements({ code: 'low' }, { code: 'high' }), { code: 'high' })
  assert.deepEqual(mergeRequirements({ code: 'high' }, { code: 'low' }), { code: 'high' })
})

test('mergeRequirements: context takes the max', () => {
  assert.deepEqual(mergeRequirements({ context: 4000 }, { context: 8000 }), { context: 8000 })
})

test('mergeRequirements: keys absent from all inputs stay absent', () => {
  const merged = mergeRequirements({ code: 'low' }, {})
  assert.deepEqual(merged, { code: 'low' })
  assert.equal('reasoning' in merged, false)
  assert.equal('context' in merged, false)
})

test('mergeRequirements: merges across many inputs', () => {
  assert.deepEqual(
    mergeRequirements({ code: 'low', context: 1000 }, { code: 'medium' }, { vision: 'high' }, {}),
    { code: 'medium', context: 1000, vision: 'high' },
  )
})

test('validateCapabilities: accepts valid input', () => {
  const result = validateCapabilities({ code: 'high', context: 8000 })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.value, { code: 'high', context: 8000 })
})

test('validateCapabilities: rejects non-object', () => {
  const result = validateCapabilities(null)
  assert.equal(result.ok, false)
  if (!result.ok) assert.deepEqual(result.errors, [{ path: [], message: 'expected an object' }])

  const arrResult = validateCapabilities([])
  assert.equal(arrResult.ok, false)
})

test('validateCapabilities: unknown key with did-you-mean', () => {
  const result = validateCapabilities({ codee: 'high' })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.errors.length, 1)
    assert.deepEqual(result.errors[0]!.path, ['codee'])
    assert.match(result.errors[0]!.message, /unknown capability "codee"/)
    assert.match(result.errors[0]!.message, /did you mean "code"\?/)
  }
})

test('validateCapabilities: unknown key with no close match lists valid keys', () => {
  const result = validateCapabilities({ zzzzzzzz: 'high' })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0]!.message, /unknown capability "zzzzzzzz"/)
    assert.match(result.errors[0]!.message, /code/)
    assert.match(result.errors[0]!.message, /tool_calling/)
  }
})

test('validateCapabilities: unknown level lists the four levels', () => {
  const result = validateCapabilities({ code: 'expert' })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.errors.length, 1)
    assert.deepEqual(result.errors[0]!.path, ['code'])
    for (const level of ['none', 'low', 'medium', 'high']) {
      assert.match(result.errors[0]!.message, new RegExp(level))
    }
  }
})

test('validateCapabilities: negative context rejected', () => {
  const result = validateCapabilities({ context: -1 })
  assert.equal(result.ok, false)
  if (!result.ok) assert.deepEqual(result.errors[0]!.path, ['context'])
})

test('validateCapabilities: non-integer context rejected', () => {
  const result = validateCapabilities({ context: 1.5 })
  assert.equal(result.ok, false)
})

test('validateCapabilities: non-number context rejected', () => {
  const result = validateCapabilities({ context: '8000' })
  assert.equal(result.ok, false)
})

test('validateCapabilities: collects all issues, not just the first', () => {
  const result = validateCapabilities({ codee: 'high', context: -1 })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.errors.length, 2)
})

test('validateCapabilities: uses path prefix', () => {
  const result = validateCapabilities({ codee: 'high' }, ['models', 0, 'capabilities'])
  assert.equal(result.ok, false)
  if (!result.ok) assert.deepEqual(result.errors[0]!.path, ['models', 0, 'capabilities', 'codee'])
})

test('validateCapabilities: round trip through JSON', () => {
  const result = validateCapabilities({ code: 'high', vision: 'low', context: 32000 })
  assert.equal(result.ok, true)
  if (result.ok) {
    const again = validateCapabilities(JSON.parse(JSON.stringify(result.value)))
    assert.equal(again.ok, true)
    if (again.ok) assert.deepEqual(again.value, result.value)
  }
})

test('validateCapabilities: value contains only provided keys, no defaults', () => {
  const result = validateCapabilities({ code: 'high' })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(Object.keys(result.value), ['code'])
  }
})
