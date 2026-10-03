/**
 * The composite decision (T-204): rules → decision model → LLM fallback, per routing question, with
 * confidence bands and cost accounting. Pure: no I/O, no clock, no network.
 *
 * Per question (`pipeline`, `level`, `tier`), in order:
 * 1. bands for the question unset or malformed → `rules`, band `none`;
 * 2. model answer missing, invalid, or without a finite confidence → `rules`, band `none`;
 * 3. band from the confidence: `≥ high` → `high`, `≤ low` → `low`, else `mid`;
 * 4. gate not passed (or unknown) → `rules`, band still reported;
 * 5. `high` → `model`; `mid` → `rules`;
 * 6. `low` → `llm` only with a valid precomputed LLM answer, else `rules` with `escalate: true`.
 *
 * Bands live in config `decisions.bands` (`{<question>: {high, low}}`) and are unset by default:
 * calibration (T-223/T-392) has not produced them, so every question resolves to `rules`, which is
 * today's behaviour. The operator sets a question's band only after `/dd gate` passes it.
 *
 * Nothing is applied in shadow mode. `applied` holds an answer only when `shadow` is false and the
 * source is not `rules` (which already implies bands set and gate passed).
 * @module scripts/lib/routing
 */

import { ROUTING_QUESTIONS } from './decisions.mjs'

/**
 * @typedef {{high: number, low: number}} Band
 * @typedef {'high'|'mid'|'low'|'none'} BandName
 * @typedef {{answer: string, source: 'rules'|'model'|'llm', band: BandName, cost: {llmCalls: number, ms: number}, why: string, escalate?: boolean, confidence?: number}} QuestionDecision
 */

/**
 * Validate one question's band config.
 * @param {unknown} b - `decisions.bands.<question>`.
 * @returns {{band?: Band, error?: string}} the band, or why it is unusable; neither when unset.
 */
export function readBand(b) {
  if (b === undefined || b === null) return {}
  if (typeof b !== 'object') return { error: 'not an object {high, low}' }
  const { high, low } = /** @type {any} */ (b)
  const unit = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
  if (!unit(high) || !unit(low)) return { error: 'high and low must be numbers in [0, 1]' }
  if (low > high) return { error: `low ${low} > high ${high}` }
  return { band: { high, low } }
}

/**
 * @param {number} confidence - the model's (calibrated) confidence.
 * @param {Band} band - the thresholds.
 * @returns {'high'|'mid'|'low'} the band; both boundaries are inclusive towards their extreme.
 */
export function bandOf(confidence, band) {
  if (confidence >= band.high) return 'high'
  if (confidence <= band.low) return 'low'
  return 'mid'
}

/**
 * Decide one question.
 * @param {object} p - inputs.
 * @param {string} p.rules - the rules' answer (always valid: it is the fallback).
 * @param {{answer?: string, confidence?: number, invalid?: boolean} | undefined} p.model - the model's readout.
 * @param {unknown} p.band - `decisions.bands.<question>` as configured.
 * @param {{pass?: boolean} | undefined} p.gate - this question's gate verdict; missing means HOLD.
 * @param {{answer?: string, ms?: number} | undefined} p.llm - a precomputed LLM answer, if any.
 * @param {string[]} p.options - the valid answers.
 * @returns {QuestionDecision} the decision.
 */
export function decideQuestion({ rules, model, band, gate, llm, options }) {
  const none = { llmCalls: 0, ms: 0 }
  const viaRules = (b, why, extra = {}) => ({ answer: rules, source: /** @type {const} */ ('rules'), band: b, cost: none, why, ...extra })
  const { band: th, error } = readBand(band)
  if (th === undefined) return viaRules('none', error === undefined ? 'bands unset' : `bands invalid: ${error}`)
  if (model === undefined || (model.answer === undefined && model.invalid !== true)) return viaRules('none', 'no model answer')
  if (model.invalid === true || !options.includes(/** @type {string} */ (model.answer))) return viaRules('none', 'model answer invalid')
  const c = model.confidence
  if (typeof c !== 'number' || !Number.isFinite(c)) return viaRules('none', 'model confidence missing')
  const b = bandOf(c, th)
  const conf = { confidence: c }
  if (gate?.pass !== true) return viaRules(b, 'gate not passed', conf)
  if (b === 'high') return { answer: /** @type {string} */ (model.answer), source: 'model', band: b, cost: none, why: `confidence ${c.toFixed(2)} >= ${th.high}`, ...conf }
  if (b === 'mid') return viaRules(b, 'mid band', conf)
  if (llm?.answer !== undefined && options.includes(llm.answer)) {
    return { answer: llm.answer, source: 'llm', band: b, cost: { llmCalls: 1, ms: llm.ms ?? 0 }, why: 'low band, llm fallback', ...conf }
  }
  return viaRules(b, llm?.answer === undefined ? 'low band, no llm answer' : 'low band, llm answer invalid', { ...conf, escalate: true })
}

/**
 * The composite over every routing question.
 * @param {object} p - inputs.
 * @param {Record<string, string>} p.rules - `ruleRoute(text)`.
 * @param {Record<string, {answer?: string, confidence?: number, invalid?: boolean}>} [p.model] - `modelAnswers(...)`; undefined when the sidecar is down.
 * @param {Record<string, unknown>} [p.bands] - `decisions.bands`.
 * @param {Record<string, {pass?: boolean}>} [p.gate] - `latestGate(...)`; undefined means every question holds.
 * @param {Record<string, {answer?: string, ms?: number}>} [p.llm] - precomputed LLM answers (see `llmFallback`).
 * @param {boolean} [p.shadow] - shadow mode (default true): nothing is applied.
 * @param {number} [p.ms] - the decision call's time; one forward pass shared by every question.
 * @param {Record<string, {criteria: Record<string, string>}>} [p.questions] - the questions; routing by default.
 * @returns {{per: Record<string, QuestionDecision>, applied: Record<string, string>, cost: {decisionMs: number, llmCalls: number, llmMs: number}}} the result.
 */
export function compositeRoute({ rules, model, bands, gate, llm, shadow = true, ms = 0, questions = ROUTING_QUESTIONS }) {
  /** @type {Record<string, QuestionDecision>} */
  const per = {}
  /** @type {Record<string, string>} */
  const applied = {}
  let llmCalls = 0
  let llmMs = 0
  for (const [q, def] of Object.entries(questions)) {
    const d = decideQuestion({
      rules: rules[q], model: model?.[q], band: bands?.[q], gate: gate?.[q], llm: llm?.[q], options: Object.keys(def.criteria),
    })
    per[q] = d
    llmCalls += d.cost.llmCalls
    llmMs += d.cost.ms
    if (shadow === false && d.source !== 'rules') applied[q] = d.answer
  }
  return { per, applied, cost: { decisionMs: ms, llmCalls, llmMs } }
}

/**
 * Does any question have a usable band? Without one the composite is rules everywhere, so callers
 * skip the gate computation (it reads every record) and, outside shadow mode, the decision call.
 * @param {Record<string, unknown>} [bands] - `decisions.bands`.
 * @returns {boolean} whether at least one question is banded.
 */
export function anyBand(bands) {
  return Object.keys(ROUTING_QUESTIONS).some(q => readBand(bands?.[q]).band !== undefined)
}

/**
 * Questions that would escalate to the LLM: low band and gate passed.
 * @param {Record<string, QuestionDecision>} per - `compositeRoute(...).per`.
 * @returns {string[]} the question keys.
 */
export function escalations(per) {
  return Object.entries(per).filter(([, d]) => d.escalate === true).map(([q]) => q)
}

/**
 * The LLM fallback seam. A STUB: it makes no call. The real provider is WS-G M3's
 * `LlmDecisionProvider`; until then a configured `decisions.llm.route` is only reported, and a
 * low-band question falls back to the rules with `escalate: true` logged. It is never invoked in
 * shadow mode, so task text never reaches a paid route for a decision nobody acts on.
 * @param {{llm?: {route?: string}}} dc - the resolved decisions config.
 * @param {string[]} _questions - the questions that escalated.
 * @returns {Promise<{answers: Record<string, {answer?: string, ms?: number}>, note: string}>} no answers today.
 */
export async function llmFallback(dc, _questions) {
  const route = dc.llm?.route
  return {
    answers: {},
    note: route === undefined || route === '' ? 'no decisions.llm.route' : `llm fallback not implemented yet; route "${route}" not called`,
  }
}

/**
 * The compact form logged in a shadow record and printed by the REPL.
 * @param {ReturnType<typeof compositeRoute>} c - a composite result.
 * @returns {Record<string, any>} `{<question>: {answer, source, band, why}, applied, llmCalls}`.
 */
export function compositeRecord(c) {
  const out = {}
  for (const [q, d] of Object.entries(c.per)) {
    out[q] = { answer: d.answer, source: d.source, band: d.band, why: d.why, ...(d.escalate ? { escalate: true } : {}) }
  }
  return { ...out, applied: c.applied, llmCalls: c.cost.llmCalls }
}
