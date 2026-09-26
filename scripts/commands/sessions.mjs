/**
 * `/sessions` — recent sessions with their titles and volumes, straight from the durable logs. Handy
 * for finding a session id to resume or to inspect with `/tools --session <id>`.
 * @module scripts/commands/sessions
 */

import { listSessions } from '../lib/sessions.mjs'
import { head, human, info, table } from '../lib/util.mjs'

export default {
  name: 'sessions',
  aliases: ['session', 'ls'],
  group: 'telemetry',
  summary: 'recent sessions: title, turns, tool calls, size',
  usage: '/sessions [--all] [--limit N]',
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - flags.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const limitAt = args.indexOf('--limit')
    const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : 12
    const sessions = listSessions({ limit, workspace: args.includes('--all') ? undefined : ctx.workspaceKey })
    if (sessions.length === 0) { info('no sessions recorded yet — run a task first'); return 0 }

    head(`${sessions.length} most recent session(s)`)
    for (const l of table(
      ['id', 'when', 'turns', 'tools', 'size', 'title'],
      sessions.map(s => [
        s.id.slice(0, 8),
        new Date(s.at).toISOString().slice(5, 16).replace('T', ' '),
        String(s.turns),
        String(s.toolCalls),
        human(s.bytes),
        (s.title ?? '(untitled)').slice(0, 44),
      ]),
    )) console.log(`  ${l}`)
    info('resume one with:  dsh --profile ' + ctx.cfg.profile.name + ' --session-id <id> "<task>"')
    return 0
  },
}
