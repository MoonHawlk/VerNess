/**
 * Shadow records carry what calibration needs (WS-E Task 1): the full probability map, an
 * option-set hash so metrics never mix option sets, and answers outside the option set rejected.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ROUTING_QUESTIONS, modelAnswers, optionHash, readAnswer } from '../lib/decisions.mjs'

test('option hash is stable and order-independent', () => {
  const a = optionHash({ criteria: { x: '1', y: '2' } })
  assert.equal(a, optionHash({ criteria: { y: 'other text', x: '' } }))
  assert.match(a, /^[0-9a-f]{8}$/)
  assert.notEqual(a, optionHash({ criteria: { x: '', z: '' } }))
})

test('an answer outside the option set is invalid', () => {
  const body = { answers: { level: { choice: 'enormous', answer_confidence: 0.9 } } }
  const a = readAnswer(body, 'level', ROUTING_QUESTIONS.level)
  assert.equal(a.invalid, true)
  assert.equal(a.answer, undefined)
})

test('without a question, readAnswer does not validate', () => {
  const body = { answers: { level: { choice: 'enormous', answer_confidence: 0.9 } } }
  assert.equal(readAnswer(body, 'level').answer, 'enormous')
})

test('probabilities are passed through', () => {
  const body = { answers: { tier: { choice: 'frontier', answer_confidence: 0.6, probabilities: { local_small: 0.1, local_large: 0.3, frontier: 0.6 } } } }
  const a = readAnswer(body, 'tier', ROUTING_QUESTIONS.tier)
  assert.equal(a.answer, 'frontier')
  assert.equal(a.probabilities.frontier, 0.6)
})

test('modelAnswers builds one entry per routing question with its hash', () => {
  const body = { answers: { level: { choice: 'simple', answer_confidence: 0.5, probabilities: { simple: 0.5 } } } }
  const m = modelAnswers(body)
  assert.deepEqual(Object.keys(m), Object.keys(ROUTING_QUESTIONS))
  assert.equal(m.level.answer, 'simple')
  assert.equal(m.level.hash, optionHash(ROUTING_QUESTIONS.level))
  assert.deepEqual(m.level.probabilities, { simple: 0.5 })
  assert.equal(m.tier.answer, undefined)
})
