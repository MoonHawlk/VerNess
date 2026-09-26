/**
 * `/usage` — what the harness actually did: sessions, turns, steps, tool calls and token accounting
 * per route, read from the substrate's own session logs.
 *
 * Token counts come from `assistant/message.usage`, which the substrate records only when the
 * provider adapter reported accounting. Local OpenAI-compatible routes report none, and this command
 * says so instead of inventing numbers.
 * @module scripts/commands/usage
 */

import { aggregateUsage, listSessions } from '../lib/sessions.mjs'
import { head, info, num, table, warn } from '../lib/util.mjs'

export default {
  name: 'usage',
  group: 'telemetry',
  summary: 'work done and tokens per route, from the session logs',
  usage: '/usage [--all] [--limit N]',
  details: [
    'by default only sessions of this workspace are counted; --all counts every workspace',
    'tokens appear only for providers that report accounting (local routes usually do not)',
  ],
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - flags.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const limitAt = args.indexOf('--limit')
    const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : undefined
    const workspace = args.includes('--all') ? undefined : ctx.workspaceKey
    const sessions = listSessions({ limit, workspace })
    if (sessions.length === 0) {
      info('no sessions recorded yet — run a task first')
      return 0
    }
    const { routes, totals, anyReported } = aggregateUsage(sessions)

    head('work')
    for (const l of table(
      ['sessions', 'prompts', 'turns', 'steps', 'tool calls'],
      [[num(totals.sessions), num(totals.prompts), num(totals.turns), num(totals.steps), num(totals.toolCalls)]],
    )) console.log(`  ${l}`)

    head('routes')
    for (const l of table(
      ['route', 'model', 'model calls', 'input tok', 'output tok'],
      routes.map(r => [
        r.provider, r.model, num(r.calls),
        r.reported ? num(r.inputTokens) : '—',
        r.reported ? num(r.outputTokens) : '—',
      ]),
    )) console.log(`  ${l}`)

    if (!anyReported) {
      warn('no route reported token accounting for these sessions')
      info('that is expected for local OpenAI-compatible routes: the substrate only logs')
      info('`usage` when the provider adapter sends it. Model calls above are exact.')
    }
    return 0
  },
}
