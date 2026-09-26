/**
 * The decision layer: a client for the SystemOne wire protocol, the three routing questions, and the
 * rule baseline they must beat.
 *
 * We integrate a *protocol*, not a model (ADR-0009). `laya-serve` and TypeSafe Jev both answer
 * `POST /v1/systemone`, so the provider is a base URL, not a code path.
 *
 * Nothing here steers the harness. Shadow mode logs what the model would have decided next to what
 * the rules actually decided, which is both the safe rollout and the only way to build the labelled
 * set the calibration gate (T-223) needs.
 * @module scripts/lib/decisions
 */

import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { REPO } from './util.mjs'

/** Where shadow-mode decisions are recorded (gitignored). */
export const decisionsDir = () => join(REPO, '.verness', 'decisions')

/**
 * The three routing questions, all `choice` with small option sets — Laya's strong regime. No
 * `score` (weakest primitive) and no `noul` (follows its own labels, issue #156). Every question in
 * one call shares a single forward pass, so asking all three costs one round trip.
 */
export const ROUTING_QUESTIONS = {
  level: {
    type: 'choice',
    instructions: 'How much work does this request require from an engineering assistant?',
    criteria: {
      trivial: 'a lookup or a one-line answer; no files need to be read',
      simple: 'one file or one command; the path is obvious',
      standard: 'several steps across a few files, but the approach is known',
      complex: 'many steps, unclear approach, or design decisions are needed',
      research: 'the answer is not known and must be investigated before acting',
    },
  },
  tier: {
    type: 'choice',
    instructions: 'What capability does this request actually need?',
    criteria: {
      local_small: 'mechanical work: formatting, extraction, running a known command',
      local_large: 'ordinary reasoning over a small amount of context',
      frontier: 'hard reasoning, long context, or code that must be correct first time',
    },
  },
  pipeline: {
    type: 'choice',
    instructions: 'Which execution strategy fits this request?',
    criteria: {
      standard: 'one model turn with tools',
      agent: 'plan first, then execute over several turns',
      decision: 'a deterministic or rule-driven loop; little generation needed',
      adaptive: 'reduce the problem with cheap computation first, then reason over what survives',
    },
  },
}

/** @param {object} cfg - the VerNess configuration. @returns {object} the decisions config block. */
export function decisionConfig(cfg) {
  const d = cfg.decisions ?? {}
  return {
    enabled: d.enabled ?? false,
    baseURL: d.baseURL ?? 'http://127.0.0.1:8000',
    apiKeyEnv: d.apiKeyEnv ?? 'LAYA_API_KEY',
    timeoutMs: d.timeoutMs ?? 20000,
    shadow: d.shadow ?? true,
    ...d,
  }
}

/**
 * Is the decision service up?
 * @param {object} dc - the resolved decisions config.
 * @returns {Promise<boolean>} whether `GET /health` answers.
 */
export async function decisionHealth(dc) {
  try {
    const r = await fetch(`${dc.baseURL}/health`, { signal: AbortSignal.timeout(2500) })
    return r.ok
  } catch { return false }
}

/**
 * Ask the decision service one or more typed questions about a piece of state.
 *
 * `503` is backpressure, not failure: the server caps concurrency (`LAYA_MAX_CONCURRENT`, default
 * 16) and rejects the excess, so a fan-out must retry rather than treat it as an error.
 * @param {object} dc - the resolved decisions config.
 * @param {string} state - the text being decided about.
 * @param {Record<string, object>} questions - typed questions.
 * @param {{retries?: number}} [opts] - retry budget for 503s.
 * @returns {Promise<{ok: boolean, status?: number, ms: number, body?: any, error?: string}>} the result.
 */
export async function askDecision(dc, state, questions, opts = {}) {
  const headers = { 'content-type': 'application/json' }
  const key = process.env[dc.apiKeyEnv]
  if (key !== undefined && key !== '') headers.authorization = `Bearer ${key}`
  const body = JSON.stringify({ state: { document: state }, questions })
  let retries = opts.retries ?? 3
  const t0 = Date.now()
  for (;;) {
    try {
      const r = await fetch(`${dc.baseURL}/v1/systemone`, {
        method: 'POST', headers, body, signal: AbortSignal.timeout(dc.timeoutMs),
      })
      if (r.status === 503 && retries-- > 0) {
        await new Promise(res => setTimeout(res, 250 + Math.random() * 500))
        continue
      }
      const parsed = await r.json().catch(() => undefined)
      return { ok: r.ok, status: r.status, ms: Date.now() - t0, body: parsed }
    } catch (e) {
      if (retries-- > 0) { await new Promise(res => setTimeout(res, 250)); continue }
      return { ok: false, ms: Date.now() - t0, error: String(e.message ?? e) }
    }
  }
}

/**
 * Identify a question's option set, so calibration never mixes records logged under different
 * options (someone edits a criteria key). Only the keys count; rewording a description does not.
 * @param {{criteria: Record<string, string>}} question - a typed question.
 * @returns {string} the first 8 hex characters of sha256 over the sorted option keys.
 */
export function optionHash(question) {
  return createHash('sha256').update(JSON.stringify(Object.keys(question.criteria).sort())).digest('hex').slice(0, 8)
}

/**
 * Read one answer out of a SystemOne response, tolerating shape differences between providers.
 *
 * Gates on `answer_confidence` — the temperature-calibrated field that ECE is fitted against — and
 * never on `confidence` (raw entropy) or `action.act_probability` (documented to carry no signal,
 * issue #185).
 *
 * With `question`, a choice outside its criteria is a provider bug: it comes back as
 * `{invalid: true}` with no answer, so the rules apply.
 * @param {any} body - the parsed response body.
 * @param {string} key - the question key.
 * @param {{criteria: Record<string, string>}} [question] - the question asked, to validate against.
 * @returns {{answer?: string, confidence?: number, probabilities?: Record<string, number>, invalid?: boolean}} the answer.
 */
export function readAnswer(body, key, question) {
  const a = body?.answers?.[key]
  if (a === undefined) return {}
  const answer = a.choice ?? a.answer ?? (typeof a.score === 'number' ? String(a.score) : undefined)
  const confidence = a.answer_confidence ?? a.confidence
  if (question !== undefined && answer !== undefined && !Object.hasOwn(question.criteria, answer)) {
    return { invalid: true, probabilities: a.probabilities }
  }
  return { answer, confidence, probabilities: a.probabilities }
}

/**
 * The model's side of a shadow record: every routing question's answer, confidence, full
 * probability map and option-set hash — what calibration (T-221, T-222) scores.
 * @param {any} body - the parsed SystemOne response body.
 * @returns {Record<string, {answer?: string, confidence?: number, probabilities?: Record<string, number>, invalid?: boolean, hash: string}>} per question.
 */
export function modelAnswers(body) {
  const model = {}
  for (const [k, q] of Object.entries(ROUTING_QUESTIONS)) model[k] = { ...readAnswer(body, k, q), hash: optionHash(q) }
  return model
}

/**
 * The rule baseline: what the harness decides today, and the thing any model must beat before it is
 * allowed to steer anything (T-251). Deliberately dumb, fast and explainable.
 * @param {string} text - the task text.
 * @returns {{level: string, tier: string, pipeline: string, why: string}} the rule decision.
 */
export function ruleRoute(text) {
  const t = String(text).toLowerCase()
  const words = t.split(/\s+/).filter(w => w !== '').length
  const mentionsFiles = /\.(ts|js|mjs|json|md|yml|yaml|py|sql)\b|\bfile\b|\bdocs?\/|\bsrc\//.test(t)
  const investigative = /\b(why|investigate|research|compare|evaluate|design|architect|root cause)\b/.test(t)
  const mechanical = /\b(list|show|print|format|rename|count|read|cat|head|tail)\b/.test(t)
  const multiStep = /\b(then|after that|and also|refactor|migrate|implement|build)\b/.test(t)

  let level = 'standard'
  let why = 'default'
  if (investigative) { level = 'research'; why = 'investigative verb' }
  else if (multiStep || words > 60) { level = 'complex'; why = multiStep ? 'multi-step verb' : 'long request' }
  else if (mechanical && words <= 15 && !mentionsFiles) { level = 'trivial'; why = 'short mechanical request' }
  else if (mechanical || words <= 25) { level = 'simple'; why = 'short or mechanical' }

  const tier = level === 'trivial' || level === 'simple' ? 'local_small'
    : level === 'standard' ? 'local_large'
      : 'frontier'
  const pipeline = level === 'research' ? 'adaptive'
    : level === 'complex' ? 'agent'
      : level === 'trivial' ? 'decision'
        : 'standard'
  return { level, tier, pipeline, why }
}

/**
 * Record one shadow-mode decision: what the rules chose (and ran), what the model would have chosen,
 * and how confident it was. This file is the labelled set T-220 will score.
 *
 * Records are `v: 2` with a random `id` (the label key). Older records have neither and no
 * probabilities; the labeller derives an id for them.
 * @param {object} record - the decision record.
 * @param {string} [dir] - where to write; defaults to `decisionsDir()`.
 * @returns {string} the record id.
 */
export function logShadowDecision(record, dir = decisionsDir()) {
  mkdirSync(dir, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  const id = randomBytes(6).toString('hex')
  appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify({ v: 2, id, at: new Date().toISOString(), ...record })}\n`, 'utf8')
  return id
}
