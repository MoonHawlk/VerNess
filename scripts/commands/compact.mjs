/**
 * `/compact` - shrink the conversation so a small model's window has room again. The substrate's own
 * `/compact` is not reachable from a CLI run (see `scripts/lib/compact.mjs`), so this asks the model
 * for one summary turn (billed: `--yes`), starts a new session and seeds it with that summary.
 * @module scripts/commands/compact
 */

import { addNote, markUnsent, moveNotes, NEW_KEY } from '../lib/notes.mjs'
import { parseSummaryRun, seedText, summaryPrompt } from '../lib/compact.mjs'
import { listSessions } from '../lib/sessions.mjs'
import { info, ok, RUN_DIR, warn } from '../lib/util.mjs'

export default {
  name: 'compact',
  group: 'core',
  // Switches the terminal REPL's conversation; the web UI keeps the substrate's own /compact.
  web: false,
  summary: 'condense this conversation into a summary and continue in a fresh session (one model turn)',
  usage: '/compact [--yes]',
  details: [
    'costs one model turn over the whole conversation, so it asks first; --yes confirms',
    'the summary opens a new session as a context block; the old session stays in /sessions',
    'automatic compaction at a window percent: compact.autoPercent in finess.config.json',
  ],
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - `--yes` to confirm the cost.
   * @returns {Promise<number>} exit code.
   */
  async run(ctx, args) {
    if (ctx.conversation === undefined) { warn('no conversation in this context'); return 1 }
    const id = ctx.conversation.id()
    if (id === undefined) { info('nothing to compact: there is no active session yet'); return 0 }
    if (!args.includes('--yes')) {
      const s = listSessions({ workspace: ctx.workspaceKey, limit: 60 }).find(x => x.identity === id)
      const size = s?.lastInputTokens === undefined ? 'the whole conversation' : `about ${s.lastInputTokens} tokens of conversation`
      warn(`this sends one real model turn that reads ${size} and writes a summary; a paid route bills it`)
      info('confirm with: /compact --yes')
      return 0
    }
    const run = ctx.dshAsync ?? ctx.dsh
    const r = await run(['--profile', ctx.cfg.profile.name, '--json', '--session-id', id, summaryPrompt()], { capture: true, env: ctx.routeEnv })
    const { answer, usage } = parseSummaryRun(r.out)
    if (r.code !== 0 || answer === '') {
      warn('the model gave no summary - the conversation is unchanged')
      info('if the window is already full, /new then restate the goal, or raise the route contextWindow')
      return 1
    }
    const seed = seedText(answer, Number(ctx.cfg.compact?.summaryChars ?? 3000))
    // Pending /btw notes follow into the new session, unsent, as /new does; the summary joins them.
    const dir = ctx.runDir ?? RUN_DIR
    moveNotes(dir, id, NEW_KEY)
    markUnsent(dir, NEW_KEY)
    addNote(dir, NEW_KEY, seed, Number.MAX_SAFE_INTEGER)
    ctx.conversation.reset()
    ok(`compacted: ${usage.input} tokens read, ${usage.output} written; the summary (${seed.length} chars) opens the next session`)
    info('see it with /btw (and /context); the old session is still in /sessions')
    return 0
  },
}
