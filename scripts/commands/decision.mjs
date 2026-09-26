/**
 * `/decision` — lifecycle of the decision sidecar, mirroring the model engine's `up`/`stats`/`down`.
 * @module scripts/commands/decision
 */

import { decisionDown, decisionStats, decisionUp } from '../decision.mjs'
import { info, warn } from '../lib/util.mjs'

export default {
  name: 'decision',
  aliases: ['decisions'],
  group: 'decisions',
  summary: 'decision engine lifecycle: /decision up | stats | down [--force]',
  usage: '/decision up | stats | down [--force]',
  details: [
    'up    installs laya[serve] into .verness/py if needed, then starts it on loopback with a key',
    'stats checkpoints loaded, measured p50 latency, and a sample typed answer',
    'down  stops the sidecar we started and releases its checkpoints',
  ],
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - subcommand and flags.
   * @returns {Promise<number>} exit code.
   */
  async run(ctx, args) {
    const sub = args[0] ?? 'stats'
    if (sub === 'up') return (await decisionUp(ctx.cfg)) ? 0 : 1
    if (sub === 'stats') return (await decisionStats(ctx.cfg)) ? 0 : 1
    if (sub === 'down') return (await decisionDown(ctx.cfg, { force: args.includes('--force') })) ? 0 : 1
    warn(`unknown subcommand: ${sub}`)
    info(this.usage)
    return 1
  },
}
