/**
 * `/budget` — the configured budgets against what has been used, and a one-task override.
 * Tokens come from the session logs, money from `pricing`; zero tokens spent here.
 * @module scripts/commands/budget
 */

import { BUDGET_KEYS, evaluateBudget, fmtAmount, gatherUsage } from '../lib/budget.mjs'
import { readState, writeState } from '../lib/personas.mjs'
import { head, info, ok, table, warn } from '../lib/util.mjs'

export default {
  name: 'budget',
  group: 'telemetry',
  summary: 'token, cost and time budgets: used, remaining; /budget allow once',
  usage: '/budget [allow once]',
  details: [
    'set limits under "budget" in finess.config.json: sessionTokens, dailyTokens, dailyCost, taskSeconds (all optional)',
    'at 80% a task prints a warning; at 100% it is not started',
    '/budget allow once lets the next task run over a limit (one task only)',
    'taskSeconds is a time limit on each REPL task, /loop-task round and team task',
    'daily figures count today (local date) across every session; local routes count tokens at cost 0',
  ],
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - nothing, or `allow once`.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    if (args.length > 0) {
      if (args.join(' ') !== 'allow once') { warn(`unknown argument: ${args.join(' ')}`); info(this.usage); return 1 }
      writeState({ budgetAllowOnce: true })
      ok('the next task may run over its budget, once')
      return 0
    }
    const budget = ctx.cfg.budget ?? {}
    const usage = gatherUsage(ctx.cfg, { sessionId: ctx.conversation?.id() })
    const verdict = evaluateBudget(budget, usage)
    head('budget')
    const rows = verdict.items.map(i => [i.key, fmtAmount(i.key, i.used), fmtAmount(i.key, i.limit), fmtAmount(i.key, i.remaining), i.level === 'ok' ? '' : i.level === 'warn' ? 'near limit' : 'used up'])
    if (budget.taskSeconds > 0) rows.push(['taskSeconds', '-', String(budget.taskSeconds), '-', 'per task / round'])
    if (rows.length === 0) info(`no budget set - add "budget": { "dailyTokens": 500000 } to finess.config.json (keys: ${BUDGET_KEYS.map(k => k[0]).join(', ')})`)
    else for (const l of table(['budget', 'used', 'limit', 'remaining', ''], rows)) console.log(`  ${l}`)
    if (readState().budgetAllowOnce === true) info('allow once is armed: the next task runs over any limit')
    return 0
  },
}
