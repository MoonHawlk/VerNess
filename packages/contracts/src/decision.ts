import type { Issue, Result } from './issue.ts'
import { isObject, recordEntries } from './validate-helpers.ts'

/** Every reason a decision (or task step) can carry, for logging and gating. */
export const REASON_CODES = [
  'rule_match', 'model_high_confidence', 'model_low_confidence', 'fallback_rules', 'escalated',
  'tool_timeout', 'tool_error', 'budget_exceeded', 'evidence_missing', 'objective_met', 'no_progress',
  'provider_unavailable', 'invalid_answer',
] as const
export type ReasonCode = typeof REASON_CODES[number]

/**
 * The most options one choice question may carry (T-385). Laya's strong regime is a small option
 * set; a larger one (17 personas) is split into stages (T-396), never asked at once.
 */
export const MAX_CHOICE_OPTIONS = 8

/** A choice over a small, fixed option set (2..MAX_CHOICE_OPTIONS, see `validateChoiceQuestion`). The only question type we use (no score, no null). */
export interface ChoiceQuestion<O extends string = string> {
  type: 'choice'
  instructions: string
  criteria: Record<O, string>
}

export interface DecisionRequest<O extends string = string> {
  /** What is being decided about (task text, a state digest). */
  state: string
  question: ChoiceQuestion<O>
  /** Stable name used for logging, calibration and gating, e.g. 'pipeline'. */
  key: string
  /** Hard latency budget; a provider that cannot answer in time returns provider_unavailable. */
  timeoutMs?: number
}

export interface DecisionResult<O extends string = string> {
  decision: O | undefined
  /** Calibrated confidence in [0, 1] (answer_confidence after any temperature). */
  confidence: number
  probabilities?: Record<O, number>
  reason_code: ReasonCode
  provider: string
  ms: number
}

export interface DecisionCapabilities {
  maxOptions: number
  batch: boolean              // several questions in one call
  calibrated: boolean
  local: boolean               // no network beyond loopback
}

export interface DecisionModel {
  readonly id: string
  readonly capabilities: DecisionCapabilities
  decide<O extends string>(req: DecisionRequest<O>): Promise<DecisionResult<O>>
}

/**
 * Check a choice question before it goes on the wire: `type` is 'choice', `instructions` is a
 * non-empty string, and `criteria` maps 2..MAX_CHOICE_OPTIONS non-empty option names to string
 * descriptions. Too many options is an error that names the limit, not a silent truncation.
 */
export function validateChoiceQuestion(v: unknown): Result<ChoiceQuestion> {
  if (!isObject(v)) return { ok: false, errors: [{ path: [], message: 'expected an object' }] }
  const errors: Issue[] = []
  if (v['type'] !== 'choice') errors.push({ path: ['type'], message: 'expected "choice" (the only question type we use)' })
  const instructions = v['instructions']
  if (typeof instructions !== 'string' || instructions.trim() === '') {
    errors.push({ path: ['instructions'], message: 'required: a non-empty string' })
  }
  const criteria: Record<string, string> = {}
  const raw = v['criteria']
  if (!isObject(raw)) {
    errors.push({ path: ['criteria'], message: 'required: an object of option -> description' })
  } else {
    const entries = recordEntries(raw, ['criteria'], errors)
    for (const [k, d] of entries) {
      if (k.trim() === '') errors.push({ path: ['criteria', k], message: 'an option name must be non-empty' })
      else if (typeof d !== 'string') errors.push({ path: ['criteria', k], message: 'expected a string description' })
      else criteria[k] = d
    }
    if (entries.length < 2) errors.push({ path: ['criteria'], message: `a choice needs at least 2 options, got ${entries.length}` })
    if (entries.length > MAX_CHOICE_OPTIONS) {
      errors.push({ path: ['criteria'], message: `${entries.length} options exceeds the limit of ${MAX_CHOICE_OPTIONS}; split the question into stages (T-396)` })
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { type: 'choice', instructions: instructions as string, criteria } }
}
