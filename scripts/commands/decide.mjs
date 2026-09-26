/**
 * `/decide` — ask the decision model how it would route a task, next to what the rules decide.
 *
 * Side by side on purpose. The decision model is not trusted yet (measured below chance-adjacent
 * accuracy zero-shot), so the value today is *seeing the disagreement*: it is how we learn where it
 * helps, and it is the data the calibration gate (T-223) needs before anything is allowed to steer.
 * @module scripts/commands/decide
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ROUTING_QUESTIONS, askDecision, decisionConfig, decisionHealth, logShadowDecision, readAnswer, ruleRoute,
} from '../lib/decisions.mjs'
import { head, info, paint, RUN_DIR, table, warn } from '../lib/util.mjs'

/**
 * Load the sidecar key written by the lifecycle command, so the caller need not export it.
 * @param {object} dc - the resolved decisions config.
 */
function adoptKey(dc) {
  if (process.env[dc.apiKeyEnv] !== undefined) return
  try { process.env[dc.apiKeyEnv] = readFileSync(join(RUN_DIR, 'laya.key'), 'utf8').trim() } catch { /* no key file */ }
}

export default {
  name: 'decide',
  group: 'decisions',
  summary: 'route a task with the decision model and the rules, side by side',
  usage: '/decide <task text>',
  details: [
    'asks three typed questions in one forward pass: level, model tier, pipeline',
    'gates on answer_confidence, never on act_probability (documented to carry no signal)',
    'nothing is applied — this is shadow mode, and the result is logged for calibration',
  ],
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - the task text.
   * @returns {Promise<number>} exit code.
   */
  async run(ctx, args) {
    const dc = decisionConfig(ctx.cfg)
    adoptKey(dc)
    const text = args.join(' ').trim()
    if (text === '') { warn('give me a task to route: /decide <task text>'); return 1 }

    const rules = ruleRoute(text)
    if (!(await decisionHealth(dc))) {
      head('rules only — the decision service is not answering')
      for (const l of table(['question', 'rules'], [['level', rules.level], ['tier', rules.tier], ['pipeline', rules.pipeline]])) console.log(`  ${l}`)
      info(`start it with: /decision up   (expected at ${dc.baseURL})`)
      return 1
    }

    const r = await askDecision(dc, text, ROUTING_QUESTIONS)
    if (!r.ok) { warn(`decision service error: ${r.error ?? `HTTP ${r.status}`}`); return 1 }

    const rows = []
    const answers = {}
    for (const key of Object.keys(ROUTING_QUESTIONS)) {
      const a = readAnswer(r.body, key)
      answers[key] = a
      const agree = a.answer === rules[key]
      rows.push([
        key,
        `${a.answer ?? '?'} (${(a.confidence ?? 0).toFixed(2)})`,
        rules[key],
        agree ? paint('green', 'agree') : paint('yellow', 'differ'),
      ])
    }
    head(`decision in ${r.ms} ms`)
    for (const l of table(['question', 'decision model', 'rules', ''], rows)) console.log(`  ${l}`)

    const top = readAnswer(r.body, 'level').probabilities
    if (top !== undefined) {
      info(`level distribution: ${Object.entries(top).map(([k, v]) => `${k} ${Number(v).toFixed(2)}`).join('  ')}`)
    }
    info(`rules reasoning: ${rules.why}`)
    info('shadow mode: the rules decision is what would run. Nothing here steers the harness yet.')

    logShadowDecision({
      source: '/decide',
      task: text.slice(0, 500),
      ms: r.ms,
      model: { ...Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { answer: v.answer, confidence: v.confidence }])) },
      rules,
      agreement: Object.keys(ROUTING_QUESTIONS).filter(k => answers[k].answer === rules[k]).length,
    })
    return 0
  },
}
