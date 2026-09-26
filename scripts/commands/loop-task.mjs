/**
 * `/loop-task` — run one objective to completion over bounded, self-checking rounds.
 * @module scripts/commands/loop-task
 */

import { runLoopTask } from '../loop-task.mjs'
import { info, warn } from '../lib/util.mjs'

export default {
  name: 'loop-task',
  aliases: ['loop'],
  group: 'core',
  summary: 'work one objective over several rounds until done, blocked or stopped',
  usage: '/loop-task [--rounds N] [--no-verify] [--here] <objective>',
  details: [
    'each round is its own substrate run on one session, so state lives in the log, not the context',
    'every round is told which tools it has already run, so asking again is visibly redundant',
    'stops on DONE (verified by a fresh-context check), BLOCKED, repetition, no progress, or the round limit',
    '--here continues the current conversation instead of starting a dedicated session',
  ],
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - flags and the objective.
   * @returns {Promise<number>} exit code.
   */
  async run(ctx, args) {
    const at = args.indexOf('--rounds')
    const rounds = at >= 0 ? Number(args[at + 1]) : undefined
    const objective = args
      .filter((a, i) => !a.startsWith('--') && i !== at + 1)
      .join(' ')
      .trim()
    if (objective === '') { warn('give me an objective: /loop-task <what you want done>'); return 1 }
    if (at >= 0 && (!Number.isFinite(rounds) || rounds < 1)) { warn('--rounds needs a positive number'); return 1 }

    const res = await runLoopTask(ctx, objective, {
      maxRounds: rounds,
      verify: !args.includes('--no-verify'),
      fresh: !args.includes('--here'),
    })
    info(`recorded in .verness/loops/ — ${res.rounds} round(s), outcome ${res.outcome}`)
    return res.outcome === 'done' ? 0 : 1
  },
}
