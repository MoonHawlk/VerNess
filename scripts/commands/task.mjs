/**
 * `/task` — recent delegated and team runs. `cancel` is not offered: a run is awaited in-process and
 * the runner keeps no process registry, so there is no handle to stop it by (Ctrl+C aborts it).
 * @module scripts/commands/task
 */

import { listRuns } from '../lib/teams.mjs'
import { head, info, table, warn } from '../lib/util.mjs'

export default {
  name: 'task',
  group: 'teams',
  summary: 'list recent delegated and team runs, newest first',
  usage: '/task [list [--limit N]]',
  details: ['status: ok | partial (skipped tasks) | failed | running (no summary yet, or still in progress)', 'cancel is not supported: runs have no process registry'],
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - subcommand and flags.
   * @returns {Promise<number>} exit code.
   */
  async run(ctx, args) {
    const sub = args[0] ?? 'list'
    if (sub === 'cancel') { warn('cancel is not supported: runs are awaited in-process; press Ctrl+C to abort the current one'); return 1 }
    if (sub !== 'list') { warn(`unknown subcommand: ${sub}`); info(this.usage); return 1 }
    const lAt = args.indexOf('--limit')
    const limit = lAt >= 0 && Number(args[lAt + 1]) > 0 ? Number(args[lAt + 1]) : 20
    const rows = listRuns({ root: ctx.runsRoot, limit })
    head(`runs (${rows.length})`)
    if (rows.length === 0) { info('none yet — try /delegate <persona> <task>'); return 0 }
    for (const l of table(['run', 'status', 'tasks', 'personas'], rows.map(r => [r.id, r.status, String(r.tasks), r.personas.join(',') || '-']))) console.log(`  ${l}`)
    return 0
  },
}
