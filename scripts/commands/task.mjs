/**
 * `/task` — running jobs (from the run registry) and recent delegated and team runs. `cancel <id>`
 * kills a running job's whole process tree (T-169, T-433).
 * @module scripts/commands/task
 */

import { cancelJob, readJobs } from '../lib/procs.mjs'
import { listRuns } from '../lib/teams.mjs'
import { RUN_DIR, head, info, ok, table, warn } from '../lib/util.mjs'
import { join } from 'node:path'

/** @param {string} iso - a start time. @returns {string} a short age such as `42s` or `3m`. */
const age = iso => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}

export default {
  name: 'task',
  group: 'teams',
  summary: 'list running jobs and recent runs; cancel a running job',
  usage: '/task [list [--limit N]] | /task cancel <id>',
  details: [
    'running: /delegate, /team run and /loop-task jobs still alive, with the pids of their dsh children',
    'status: ok | partial (skipped tasks) | failed | running (no summary yet, or still in progress)',
    'cancel <id> (a unique prefix works) kills that job\'s whole process tree and stops it starting more work',
  ],
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - subcommand and flags.
   * @returns {Promise<number>} exit code.
   */
  async run(ctx, args) {
    const sub = args[0] ?? 'list'
    const jobsRoot = ctx.jobsRoot ?? join(RUN_DIR, 'jobs')
    if (sub === 'cancel') {
      if (args[1] === undefined) { warn('usage: /task cancel <id>  (ids are in /task list)'); return 1 }
      const r = cancelJob(jobsRoot, args[1])
      if (!r.ok) { warn(r.error); return 1 }
      ok(`cancelled ${r.job.id} (${r.job.label}); killed ${r.killed.length === 0 ? 'no process yet, it will stop before the next step' : `pid ${r.killed.join(', ')}`}`)
      return 0
    }
    if (sub !== 'list') { warn(`unknown subcommand: ${sub}`); info(this.usage); return 1 }
    const lAt = args.indexOf('--limit')
    const limit = lAt >= 0 && Number(args[lAt + 1]) > 0 ? Number(args[lAt + 1]) : 20
    const jobs = readJobs(jobsRoot)
    if (jobs.length > 0) {
      head(`running (${jobs.length})`)
      for (const l of table(['id', 'kind', 'age', 'pids', 'label'], jobs.map(j => [j.id, j.kind, age(j.started), j.pids.join(',') || '-', j.label]))) console.log(`  ${l}`)
    }
    const rows = listRuns({ root: ctx.runsRoot, limit })
    head(`runs (${rows.length})`)
    if (rows.length === 0) { info('none yet — try /delegate <persona> <task>'); return 0 }
    for (const l of table(['run', 'status', 'tasks', 'personas'], rows.map(r => [r.id, r.status, String(r.tasks), r.personas.join(',') || '-']))) console.log(`  ${l}`)
    return 0
  },
}
