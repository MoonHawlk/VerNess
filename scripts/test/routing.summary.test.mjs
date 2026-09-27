/**
 * `/routing` (T-255): the pure summary of the shadow log — the recent rows and the model-vs-rules
 * agreement — across every record shape the log has held.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { agreement, modelReadout, recentRows, truncate } from '../commands/routing.mjs'

const v2 = (at, task, level, conf, rule) => ({
  v: 2, id: at, at, task,
  model: { level: { answer: level, confidence: conf, probabilities: { [level]: conf }, hash: 'abcd1234' } },
  rules: { level: rule },
})
const legacy = (at, level, rule) => ({ id: `legacy-${at}`, at, task: 'old', model: { level: { answer: level, confidence: 0.5 } }, rules: { level: rule } })

test('modelReadout tolerates v2, legacy, invalid, bare-string and missing entries', () => {
  assert.deepEqual(modelReadout({ answer: 'simple', confidence: 0.7, probabilities: {}, hash: 'x' }), { answer: 'simple', confidence: 0.7 })
  assert.deepEqual(modelReadout({ answer: 'simple', confidence: 0.7 }), { answer: 'simple', confidence: 0.7 })
  assert.deepEqual(modelReadout({ invalid: true, probabilities: {} }), { invalid: true })
  assert.deepEqual(modelReadout('complex'), { answer: 'complex' })
  assert.deepEqual(modelReadout(undefined), {})
  assert.deepEqual(modelReadout({}), { answer: undefined, confidence: undefined })
})

test('truncate keeps one line and cuts with an ellipsis', () => {
  assert.equal(truncate('short'), 'short')
  assert.equal(truncate('a\n  b'), 'a b')
  assert.equal(truncate('x'.repeat(50), 10), `${'x'.repeat(9)}…`)
  assert.equal(truncate(undefined), '')
})

test('recentRows: the last N, newest first, rules / model (confidence)', () => {
  const recs = [
    v2('2026-09-25T10:00:00Z', 'first', 'simple', 0.8, 'simple'),
    legacy('2026-09-26T11:00:00Z', 'complex', 'simple'),
    { id: 'c', at: '2026-09-27T12:30:00Z', task: 'third', model: { level: { invalid: true } }, rules: { level: 'trivial' } },
  ]
  const rows = recentRows(recs, 2, ['level'])
  assert.deepEqual(rows, [
    ['2026-09-27 12:30', 'third', 'trivial / invalid'],
    ['2026-09-26 11:00', 'old', 'simple / complex (0.50)'],
  ])
  assert.equal(recentRows(recs, 10, ['level']).length, 3)
  assert.deepEqual(recentRows([{ at: 'x', task: 't' }], 1, ['level']), [['x', 't', '- / -']])
})

test('agreement: per question over every record; invalid or missing answers are not counted', () => {
  const recs = [
    v2('1', 't', 'simple', 0.8, 'simple'),
    v2('2', 't', 'complex', 0.6, 'simple'),
    legacy('3', 'simple', 'simple'),
    { id: '4', at: '4', model: { level: { invalid: true } }, rules: { level: 'simple' } },
    { id: '5', at: '5', rules: { level: 'simple' } },
  ]
  assert.deepEqual(agreement(recs, ['level', 'tier']), {
    level: { agree: 2, n: 3, rate: 2 / 3 },
    tier: { agree: 0, n: 0, rate: null },
  })
  assert.deepEqual(agreement([], ['level']), { level: { agree: 0, n: 0, rate: null } })
})
