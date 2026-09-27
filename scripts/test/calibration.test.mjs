/**
 * Calibration metrics and the temperature refit (T-221, T-222 / T-261). Values are hand-computed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { accuracy, applyTemperature, auroc, ece, fitTemperature, nll, report, splitHoldout } from '../lib/calibration.mjs'
import { ROUTING_QUESTIONS, optionHash, readAnswer } from '../lib/decisions.mjs'

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)

test('accuracy', () => {
  assert.equal(accuracy([{ pred: 'a', label: 'a' }, { pred: 'a', label: 'b' }]), 0.5)
  assert.ok(Number.isNaN(accuracy([])))
})

test('ece: perfectly calibrated is 0, always-sure-and-half-right is 0.5', () => {
  close(ece([{ conf: 0.75, correct: true }, { conf: 0.75, correct: true }, { conf: 0.75, correct: true }, { conf: 0.75, correct: false }]), 0)
  close(ece([{ conf: 1, correct: true }, { conf: 1, correct: false }]), 0.5)
  assert.ok(Number.isNaN(ece([])))
})

test('ece: two bins weighted by size', () => {
  // bin [0.2,0.3): conf 0.25, acc 0 -> gap .25, weight 1/3; bin [0.9,1]: conf .95 acc 1 -> gap .05, weight 2/3
  close(ece([{ conf: 0.25, correct: false }, { conf: 0.95, correct: true }, { conf: 0.95, correct: true }]), 0.25 / 3 + 0.05 * 2 / 3)
})

test('auroc', () => {
  assert.equal(auroc([{ conf: 0.9, correct: true }, { conf: 0.1, correct: false }]), 1)
  assert.equal(auroc([{ conf: 0.1, correct: true }, { conf: 0.9, correct: false }]), 0)
  assert.equal(auroc([{ conf: 0.5, correct: true }, { conf: 0.5, correct: false }]), 0.5)
  assert.equal(auroc([{ conf: 0.5, correct: true }]), null)
})

test('temperature: identity at 1, sharpens below 1, flattens above, zeros stay zero', () => {
  const p = { a: 0.6, b: 0.4 }
  assert.deepEqual(applyTemperature(p, 1), p)
  assert.ok(applyTemperature(p, 0.5).a > 0.6)
  assert.ok(applyTemperature(p, 2).a < 0.6)
  close(Object.values(applyTemperature(p, 3)).reduce((s, x) => s + x, 0), 1)
  assert.equal(applyTemperature({ a: 0.5, b: 0.5, c: 0 }, 2).c, 0)
})

test('fit: an over-confident model gets T > 1 and lower NLL', () => {
  // Always 0.9 on the predicted option, right only 60% of the time.
  const rows = []
  for (let i = 0; i < 100; i++) rows.push({ probs: { a: 0.9, b: 0.1 }, label: i < 60 ? 'a' : 'b' })
  const f = fitTemperature(rows)
  assert.ok(f.T > 1)
  assert.ok(f.nllAfter < f.nllBefore)
  close(f.nllBefore, nll(rows, 1))
})

test('splitHoldout is deterministic, disjoint and complete', () => {
  const rows = Array.from({ length: 20 }, (_, i) => i)
  const a = splitHoldout(rows, 0.3, 42)
  assert.deepEqual(a, splitHoldout(rows, 0.3, 42))
  assert.equal(a.holdout.length, 6)
  assert.deepEqual([...a.train, ...a.holdout].sort((x, y) => x - y), rows)
})

/** A labelled v2 record for the `level` question. */
function rec(id, model, conf, rules, probs) {
  const hash = optionHash(ROUTING_QUESTIONS.level)
  return { id, model: { level: { answer: model, confidence: conf, probabilities: probs, hash } }, rules: { level: rules } }
}

test('report: one row per (question, hash); rules scored at confidence 1; skip labels ignored', () => {
  const hashes = { level: optionHash(ROUTING_QUESTIONS.level) }
  const records = [
    rec('r1', 'simple', 0.8, 'simple'),
    rec('r2', 'simple', 0.6, 'complex'),
    rec('r3', 'trivial', 0.4, 'complex'),
    rec('r4', 'simple', 0.9, 'simple'),
  ]
  const labels = new Map([['r1', { level: 'simple' }], ['r2', { level: 'complex' }], ['r3', { level: 'skip' }]])
  const [row, ...rest] = report(records, labels, { questions: ['level'], hashes })
  assert.equal(rest.length, 0)
  assert.equal(row.question, 'level')
  assert.equal(row.hash, hashes.level)
  assert.equal(row.n, 2)
  assert.equal(row.model.accuracy, 0.5)
  assert.equal(row.rules.accuracy, 1)
  close(row.rules.ece, 0)
  // model: conf .8 right (bin 8), conf .6 wrong (bin 6) -> (.2 + .6) / 2
  close(row.model.ece, 0.4)
  assert.equal(row.model.auroc, 1)
  assert.equal(row.modelRefit, undefined, 'no refit below 50 labels')
})

test('report: a record without a hash counts under the current option set', () => {
  const hashes = { level: optionHash(ROUTING_QUESTIONS.level) }
  const legacy = { id: 'old', model: { level: { answer: 'simple', confidence: 0.5 } }, rules: { level: 'simple' } }
  const [row] = report([legacy], new Map([['old', { level: 'simple' }]]), { questions: ['level'], hashes })
  assert.equal(row.hash, hashes.level)
  assert.equal(row.n, 1)
})

test('report: refit is fitted on train, judged on the holdout, kept only when holdout NLL improves', () => {
  const hashes = { level: optionHash(ROUTING_QUESTIONS.level) }
  const records = []
  const labels = new Map()
  for (let i = 0; i < 100; i++) {
    records.push(rec(`r${i}`, 'simple', 0.9, 'simple', { simple: 0.9, complex: 0.1 }))
    labels.set(`r${i}`, { level: i % 5 < 3 ? 'simple' : 'complex' })
  }
  const [row] = report(records, labels, { questions: ['level'], hashes })
  assert.equal(row.n, 100)
  assert.ok(row.T > 1, `T=${row.T}`)
  assert.equal(row.modelRefit.n, 30)
  assert.ok(row.modelRefit.ece < row.model.ece)
})

test('readAnswer applies a matching temperature and keeps the raw confidence', () => {
  const q = ROUTING_QUESTIONS.tier
  const body = { answers: { tier: { choice: 'frontier', answer_confidence: 0.6, probabilities: { local_small: 0.1, local_large: 0.3, frontier: 0.6 } } } }
  const a = readAnswer(body, 'tier', q, { [`tier:${optionHash(q)}`]: { T: 2 } })
  assert.equal(a.confidenceRaw, 0.6)
  assert.ok(a.confidence < 0.6)
  close(a.confidence, Math.max(...Object.values(a.probabilities)))
  assert.equal(a.answer, 'frontier')
  const untouched = readAnswer(body, 'tier', q, { 'tier:deadbeef': { T: 2 } })
  assert.equal(untouched.confidence, 0.6)
})
