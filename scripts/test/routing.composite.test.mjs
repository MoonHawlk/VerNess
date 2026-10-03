/**
 * The composite decision (T-204): rules → model → LLM fallback, with bands, gated per question.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { anyBand, bandOf, compositeRecord, compositeRoute, decideQuestion, escalations, llmFallback, readBand } from '../lib/routing.mjs'

const RULES = { level: 'standard', tier: 'local_large', pipeline: 'standard' }
const PASS = { level: { pass: true }, tier: { pass: true }, pipeline: { pass: true } }
const BAND = { high: 0.8, low: 0.4 }
const BANDS = { level: BAND, tier: BAND, pipeline: BAND }
const model = c => ({
  level: { answer: 'complex', confidence: c },
  tier: { answer: 'frontier', confidence: c },
  pipeline: { answer: 'agent', confidence: c },
})
const OPTS = ['standard', 'agent', 'decision', 'adaptive']
const one = p => decideQuestion({ rules: 'standard', model: { answer: 'agent', confidence: 0.9 }, band: BAND, gate: { pass: true }, llm: undefined, options: OPTS, ...p })

test('bands unset (default): every question is rules, band none, nothing applied', () => {
  for (const shadow of [true, false]) {
    const c = compositeRoute({ rules: RULES, model: model(0.99), gate: PASS, shadow, ms: 300 })
    for (const q of Object.keys(RULES)) {
      assert.equal(c.per[q].source, 'rules')
      assert.equal(c.per[q].answer, RULES[q])
      assert.equal(c.per[q].band, 'none')
      assert.equal(c.per[q].why, 'bands unset')
    }
    assert.deepEqual(c.applied, {})
    assert.deepEqual(c.cost, { decisionMs: 300, llmCalls: 0, llmMs: 0 })
  }
  assert.equal(anyBand(undefined), false)
  assert.equal(anyBand({}), false)
})

test('bands set, gate passed: high → model, mid → rules, low → rules + escalate', () => {
  assert.equal(compositeRoute({ rules: RULES, model: model(0.9), bands: BANDS, gate: PASS }).per.tier.source, 'model')
  assert.equal(compositeRoute({ rules: RULES, model: model(0.9), bands: BANDS, gate: PASS }).per.tier.answer, 'frontier')
  const mid = compositeRoute({ rules: RULES, model: model(0.6), bands: BANDS, gate: PASS }).per.tier
  assert.deepEqual([mid.source, mid.band, mid.answer, mid.escalate], ['rules', 'mid', 'local_large', undefined])
  const low = compositeRoute({ rules: RULES, model: model(0.2), bands: BANDS, gate: PASS }).per.tier
  assert.deepEqual([low.source, low.band, low.answer, low.escalate], ['rules', 'low', 'local_large', true])
})

test('thresholds are inclusive: = high is high, = low is low', () => {
  assert.equal(bandOf(0.8, BAND), 'high')
  assert.equal(bandOf(0.4, BAND), 'low')
  assert.equal(bandOf(0.40001, BAND), 'mid')
  assert.equal(bandOf(0.79999, BAND), 'mid')
  assert.equal(one({ model: { answer: 'agent', confidence: 0.8 } }).source, 'model')
  assert.equal(one({ model: { answer: 'agent', confidence: 0.4 } }).band, 'low')
  // low == high: a single cut, nothing is mid
  assert.equal(bandOf(0.5, { high: 0.5, low: 0.5 }), 'high')
})

test('gate not passed, or unknown: rules, but the band is still reported', () => {
  for (const gate of [undefined, {}, { tier: { pass: false } }, { tier: {} }]) {
    const d = compositeRoute({ rules: RULES, model: model(0.95), bands: BANDS, gate, shadow: false }).per.tier
    assert.deepEqual([d.source, d.band, d.why, d.answer], ['rules', 'high', 'gate not passed', 'local_large'])
  }
  const held = compositeRoute({ rules: RULES, model: model(0.95), bands: BANDS, gate: undefined, shadow: false })
  assert.deepEqual(held.applied, {})
})

test('missing model answer: sidecar down, question absent, or answer absent', () => {
  assert.equal(compositeRoute({ rules: RULES, model: undefined, bands: BANDS, gate: PASS }).per.level.why, 'no model answer')
  assert.equal(compositeRoute({ rules: RULES, model: {}, bands: BANDS, gate: PASS }).per.level.why, 'no model answer')
  const d = one({ model: {} })
  assert.deepEqual([d.source, d.band, d.answer], ['rules', 'none', 'standard'])
})

test('invalid model answer: flagged invalid, or outside the options', () => {
  assert.equal(one({ model: { invalid: true, confidence: 0.99 } }).why, 'model answer invalid')
  const d = one({ model: { answer: 'enormous', confidence: 0.99 } })
  assert.deepEqual([d.source, d.band, d.why], ['rules', 'none', 'model answer invalid'])
})

test('missing or non-finite confidence: rules, band none', () => {
  for (const confidence of [undefined, NaN, Infinity, '0.9', null]) {
    const d = one({ model: { answer: 'agent', confidence } })
    assert.deepEqual([d.source, d.band, d.why], ['rules', 'none', 'model confidence missing'])
  }
})

test('malformed bands: rules with the reason; usable bands validated', () => {
  for (const band of [0.8, 'high', { high: 0.8 }, { low: 0.4 }, { high: 1.2, low: 0.4 }, { high: 0.8, low: -0.1 }, { high: '0.8', low: 0.4 }, { high: 0.3, low: 0.6 }, { high: NaN, low: 0 }]) {
    const d = one({ band })
    assert.equal(d.source, 'rules')
    assert.equal(d.band, 'none')
    assert.match(d.why, /^bands invalid: /)
  }
  assert.deepEqual(readBand(null), {})
  assert.deepEqual(readBand({ high: 1, low: 0 }), { band: { high: 1, low: 0 } })
  assert.equal(anyBand({ tier: { high: 0.3, low: 0.6 } }), false)
  assert.equal(anyBand({ tier: BAND }), true)
})

test('each question is independent: bands on tier only, only tier leaves rules', () => {
  const c = compositeRoute({ rules: RULES, model: model(0.95), bands: { tier: BAND }, gate: PASS, shadow: false })
  assert.equal(c.per.tier.source, 'model')
  assert.equal(c.per.level.source, 'rules')
  assert.equal(c.per.pipeline.source, 'rules')
  assert.deepEqual(c.applied, { tier: 'frontier' })
})

test('gate per question: pipeline passes, tier holds', () => {
  const c = compositeRoute({ rules: RULES, model: model(0.95), bands: BANDS, gate: { pipeline: { pass: true }, tier: { pass: false } }, shadow: false })
  assert.deepEqual(c.applied, { pipeline: 'agent' })
})

test('shadow mode (default) never applies, even when everything passes', () => {
  const c = compositeRoute({ rules: RULES, model: model(0.95), bands: BANDS, gate: PASS })
  assert.equal(c.per.tier.source, 'model')
  assert.deepEqual(c.applied, {})
  assert.deepEqual(compositeRoute({ rules: RULES, model: model(0.95), bands: BANDS, gate: PASS, shadow: true }).applied, {})
})

test('low band with a valid llm answer → llm, counted in cost', () => {
  const c = compositeRoute({ rules: RULES, model: model(0.1), bands: BANDS, gate: PASS, llm: { pipeline: { answer: 'decision', ms: 900 } }, shadow: false, ms: 250 })
  assert.deepEqual([c.per.pipeline.source, c.per.pipeline.answer, c.per.pipeline.band], ['llm', 'decision', 'low'])
  assert.deepEqual(c.per.pipeline.cost, { llmCalls: 1, ms: 900 })
  assert.deepEqual(c.per.tier.cost, { llmCalls: 0, ms: 0 })
  assert.deepEqual(c.cost, { decisionMs: 250, llmCalls: 1, llmMs: 900 })
  assert.deepEqual(c.applied, { pipeline: 'decision' })
})

test('llm answer outside the options, or absent → rules + escalate', () => {
  const bad = one({ model: { answer: 'agent', confidence: 0.1 }, llm: { answer: 'frontier' } })
  assert.deepEqual([bad.source, bad.escalate, bad.why], ['rules', true, 'low band, llm answer invalid'])
  const none = one({ model: { answer: 'agent', confidence: 0.1 }, llm: {} })
  assert.equal(none.source, 'rules')
})

test('llm answer ignored outside the low band and when the gate holds', () => {
  const llm = { tier: { answer: 'local_small' } }
  assert.equal(compositeRoute({ rules: RULES, model: model(0.6), bands: BANDS, gate: PASS, llm }).per.tier.source, 'rules')
  assert.equal(compositeRoute({ rules: RULES, model: model(0.1), bands: BANDS, gate: {}, llm }).per.tier.source, 'rules')
  assert.equal(compositeRoute({ rules: RULES, model: model(0.1), bands: BANDS, gate: {}, llm }).per.tier.escalate, undefined)
})

test('escalations lists low-band questions that passed the gate', () => {
  const c = compositeRoute({ rules: RULES, model: model(0.1), bands: { tier: BAND, level: BAND }, gate: { tier: { pass: true } } })
  assert.deepEqual(escalations(c.per), ['tier'])
})

test('llmFallback is a stub: no answers, with or without a route', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('no network expected') }
  try {
    assert.deepEqual((await llmFallback({}, ['tier'])).answers, {})
    const r = await llmFallback({ llm: { route: 'openrouter' } }, ['tier'])
    assert.deepEqual(r.answers, {})
    assert.match(r.note, /not implemented/)
  } finally { globalThis.fetch = realFetch }
})

test('compositeRecord is compact and serialisable', () => {
  const c = compositeRoute({ rules: RULES, model: model(0.1), bands: BANDS, gate: PASS })
  const rec = JSON.parse(JSON.stringify(compositeRecord(c)))
  assert.deepEqual(rec.tier, { answer: 'local_large', source: 'rules', band: 'low', why: 'low band, no llm answer', escalate: true })
  assert.deepEqual(rec.applied, {})
  assert.equal(rec.llmCalls, 0)
})
