/**
 * `/dashboard` — build and open the task dashboard: the open backlog to prioritise, every call, its
 * performance, and a drill-down into the logs behind it. Static HTML, generated from records the harness already keeps.
 * @module scripts/commands/dashboard
 */

import { buildDashboard } from '../dashboard.mjs'
import { info } from '../lib/util.mjs'

export default {
  name: 'dashboard',
  aliases: ['dash'],
  group: 'telemetry',
  summary: 'build and open the HTML task dashboard',
  usage: '/dashboard [--no-open] [--limit N]',
  details: [
    'backlog: every open task in docs/03-BACKLOG.md with a P0-P3 picker, filters, sort, and copy-as-markdown; the file itself rendered below',
    'sessions with turns, tool calls, tokens and wall time; click a row for its full timeline',
    'shadow decisions with model-vs-rules agreement and latency; team runs with per-task outcomes',
    'a static file under .verness/ - no server, no network, regenerate any time',
  ],
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - flags.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const at = args.indexOf('--limit')
    const path = buildDashboard(ctx.cfg, {
      open: !args.includes('--no-open'),
      limit: at >= 0 ? Number(args[at + 1]) : undefined,
    })
    info(`open it again any time: ${path}`)
    return 0
  },
}
