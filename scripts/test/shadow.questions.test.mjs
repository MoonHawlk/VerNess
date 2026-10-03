/**
 * Shadow-only questions: the loop supervisor (T-231) and the inbound guard (T-243). Fake model, temp dirs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateChoiceQuestion } from '../../packages/contracts/src/decision.ts'
import { GUARD_QUESTION, LABEL_QUESTIONS, ROUTING_QUESTIONS, SUPERVISOR_QUESTION, modelAnswers, questionErrors, readDecisionRecords, ruleSupervisor } from '../lib/decisions.mjs'
import { latestGate, readShadow } from '../lib/labels.mjs'
import { shadowSupervise } from '../lib/loop-shadow.mjs'

const inTemp = async fn => {
  const dir = mkdtempSync(join(tmpdir(), 'finess-shadowq-'))
  try { await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
const ON = { decisions: { enabled: true, shadow: true } }
const round = { objective: 'fix the bug', digest: 'Rounds so far: 2.', round: 2, kind: 'working' }

test('new questions are valid choices; supervisor has 4 options and guard 3', () => {
  assert.equal(validateChoiceQuestion(GUARD_QUESTION).ok, true)
  assert.equal(validateChoiceQuestion(SUPERVISOR_QUESTION).ok, true)
  assert.deepEqual(Object.keys(SUPERVISOR_QUESTION.criteria), ['continue', 'retry', 'complete', 'escalate'])
  assert.deepEqual(Object.keys(GUARD_QUESTION.criteria), ['ok', 'needs-review', 'refuse'])
  assert.equal(questionErrors({ ...ROUTING_QUESTIONS, guard: GUARD_QUESTION }), undefined)
  assert.deepEqual(Object.keys(LABEL_QUESTIONS), ['level', 'tier', 'pipeline', 'guard', 'supervisor'])
})

test('ruleSupervisor maps classifyRound kinds', () => {
  assert.deepEqual(['done', 'blocked', 'working'].map(ruleSupervisor), ['complete', 'escalate', 'continue'])
})

test('guard rides in the same call and is read next to the routing answers', () => {
  const body = { answers: { guard: { choice: 'needs-review', answer_confidence: 0.7, probabilities: { ok: 0.2, 'needs-review': 0.7, refuse: 0.1 } }, level: { choice: 'simple' } } }
  const m = modelAnswers(body, undefined, { ...ROUTING_QUESTIONS, guard: GUARD_QUESTION })
  assert.equal(m.guard.answer, 'needs-review')
  assert.equal(m.level.answer, 'simple')
  assert.equal(modelAnswers(body).guard, undefined)
})

test('shadowSupervise logs a loop record with model and rules verdicts', () => inTemp(async dir => {
  let seen
  const ask = async (dc, state, qs) => {
    seen = { state, keys: Object.keys(qs) }
    return { ok: true, ms: 5, body: { answers: { supervisor: { choice: 'retry', answer_confidence: 0.6, probabilities: { continue: 0.2, retry: 0.6, complete: 0.1, escalate: 0.1 } } } } }
  }
  const id = await shadowSupervise(ON, round, { ask, dir })
  assert.ok(id)
  assert.deepEqual(seen.keys, ['supervisor'])
  assert.match(seen.state, /fix the bug/)
  const [rec] = readDecisionRecords(dir)
  assert.equal(rec.source, 'loop')
  assert.equal(rec.model.supervisor.answer, 'retry')
  assert.equal(rec.rules.supervisor, 'continue')
  assert.equal(readShadow(dir)[0].id, id)
  assert.equal(latestGate(dir, ['supervisor']).supervisor.pass, false)
}))

test('shadowSupervise is inert when off, and swallows failures', () => inTemp(async dir => {
  const boom = async () => { throw new Error('down') }
  assert.equal(await shadowSupervise({}, round, { ask: boom, dir }), undefined)
  assert.equal(await shadowSupervise(ON, round, { ask: boom, dir }), undefined)
  assert.equal(await shadowSupervise(ON, round, { ask: async () => ({ ok: false, error: 'x' }), dir }), undefined)
  assert.deepEqual(readDecisionRecords(dir), [])
}))
