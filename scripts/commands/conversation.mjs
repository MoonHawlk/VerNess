/**
 * Conversation control: the harness keeps one substrate session across turns so the model builds on
 * its own history instead of meeting every question cold. These commands steer that session.
 *
 * The session log itself is the substrate's durable source of truth — we only hold its id, so
 * `/resume` is genuinely resuming the recorded conversation, not replaying a summary of it.
 * @module scripts/commands/conversation
 */

import { listSessions } from '../lib/sessions.mjs'
import { head, info, ok, table, warn } from '../lib/util.mjs'

export default {
  name: 'new',
  aliases: ['clear', 'reset'],
  group: 'core',
  summary: 'start a fresh session; the next task begins with no history',
  usage: '/new',
  /**
   * @param {object} ctx - command context.
   * @returns {number} exit code.
   */
  run(ctx) {
    const had = ctx.conversation?.id()
    if (ctx.conversation === undefined) { warn('no conversation in this context'); return 1 }
    ctx.conversation.reset()
    ok(had === undefined ? 'starting fresh (there was no active session)' : `left session ${String(had).replace(/^session-/, '').slice(0, 8)}; the next task starts a new one`)
    info('the old session is not deleted — /sessions still lists it, /resume <id> returns to it')
    return 0
  },
}

/** `/resume` — continue a recorded session instead of the current one. */
export const resume = {
  name: 'resume',
  aliases: ['continue'],
  group: 'core',
  summary: 'continue an earlier session by id prefix',
  usage: '/resume [<id-prefix>]',
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - an optional session id prefix.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    if (ctx.conversation === undefined) { warn('no conversation in this context'); return 1 }
    const sessions = listSessions({ workspace: ctx.workspaceKey, limit: 15 })
    if (args.length === 0) {
      const current = ctx.conversation.id()
      head(`current session: ${current === undefined ? '(none — the next task starts one)' : String(current).replace(/^session-/, '').slice(0, 8)}`)
      for (const l of table(
        ['id', 'when', 'turns', 'title'],
        sessions.map(s => [
          s.id.slice(0, 8),
          new Date(s.at).toISOString().slice(5, 16).replace('T', ' '),
          String(s.turns),
          (s.title ?? '(untitled)').slice(0, 46),
        ]),
      )) console.log(`  ${l}`)
      info('continue one with /resume <id-prefix>')
      return 0
    }
    const needle = args[0].replace(/^session-/, '')
    const match = sessions.find(s => s.id.startsWith(needle))
    if (match === undefined) { warn(`no recent session starts with "${args[0]}"`); return 1 }
    // Adopt the opaque identity, not the short display id.
    ctx.conversation.adopt(match.identity)
    ok(`resuming ${match.id.slice(0, 8)} — ${match.turns} turn(s), "${match.title ?? 'untitled'}"`)
    return 0
  },
}
