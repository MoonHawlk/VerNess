/** Every reason a decision (or task step) can carry, for logging and gating. */
export const REASON_CODES = [
  'rule_match', 'model_high_confidence', 'model_low_confidence', 'fallback_rules', 'escalated',
  'tool_timeout', 'tool_error', 'budget_exceeded', 'evidence_missing', 'objective_met', 'no_progress',
  'provider_unavailable', 'invalid_answer',
] as const
export type ReasonCode = typeof REASON_CODES[number]

/** A choice over a small, fixed option set (<= 8). The only question type we use (no score, no noul). */
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
