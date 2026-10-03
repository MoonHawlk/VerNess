/**
 * Shadow supervisor for `/loop-task` (T-231): after a round, ask the decision model what the loop
 * should do next and log it beside the rules' verdict. Never acted on, never throws, never blocks the
 * loop beyond the call's own timeout.
 * @module scripts/lib/loop-shadow
 */

import { SUPERVISOR_QUESTION, askDecision, decisionConfig, loadTemperatures, logShadowDecision, modelAnswers, ruleSupervisor } from './decisions.mjs'

/**
 * @param {object} cfg - the FiNess configuration.
 * @param {{objective: string, digest: string, round: number, kind: string}} round - the round just classified (`kind` is `classifyRound`'s).
 * @param {{ask?: typeof askDecision, dir?: string}} [opts] - `ask` and `dir` are test seams (fake model, temp decisions dir).
 * @returns {Promise<string | undefined>} the shadow record id, or undefined when off or the call failed.
 */
export async function shadowSupervise(cfg, { objective, digest, round, kind }, opts = {}) {
  try {
    const dc = decisionConfig(cfg)
    if (dc.enabled !== true || dc.shadow !== true) return undefined
    const ask = opts.ask ?? askDecision
    const state = `OBJECTIVE: ${objective}\nROUND: ${round}\nROUND DIGEST:\n${digest}`
    const r = await ask(dc, state, { supervisor: SUPERVISOR_QUESTION }, { retries: 1 })
    if (!r?.ok) return undefined
    const model = modelAnswers(r.body, loadTemperatures(opts.dir), { supervisor: SUPERVISOR_QUESTION })
    return logShadowDecision({
      source: 'loop', task: `${objective}\n\n${digest}`.slice(0, 500), round, ms: r.ms, model,
      rules: { supervisor: ruleSupervisor(kind) },
    }, opts.dir)
  } catch { return undefined }
}
