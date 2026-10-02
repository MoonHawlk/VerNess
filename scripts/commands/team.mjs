/**
 * `/team` — list, inspect and run teams. A run executes the team's task list, each task in its own
 * substrate run wearing its member's persona, honouring `dependsOn` and feeding an upstream task's
 * output into its dependents.
 * @module scripts/commands/team
 */

import { loadPersonas } from '../lib/personas.mjs'
import { latestRun, loadTeams, readRun, runTeam, statusRows, validateTeam } from '../lib/teams.mjs'
import { head, info, table, warn } from '../lib/util.mjs'

export default {
  name: 'team',
  aliases: ['teams'],
  group: 'teams',
  summary: 'list, inspect and run a team of personas over a task list',
  usage: '/team [list | show <id> | run <id> [--parallel N] [--only a,b] [--dry-run] | status [<id>]]',
  details: [
    'status [<id>]: per-task status, exit and seconds of the newest run (of that team, or of any team)',
    'a team is teams/<id>.json: members bind a role to a persona, tasks name a member and dependsOn',
    'each task runs as its own substrate run with a --patch persona overlay, so the profile is untouched',
    'transcripts, summary.md and a machine-readable summary.json land in .verness/runs/<team>/<timestamp>/',
  ],
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - subcommand and flags.
   * @returns {Promise<number>} exit code.
   */
  async run(ctx, args) {
    const teams = loadTeams()
    const sub = args[0] ?? 'list'

    if (sub === 'list') {
      head(`teams (${teams.size})`)
      if (teams.size === 0) { info('none yet — add teams/<id>.json (see teams/README.md)'); return 0 }
      for (const l of table(
        ['id', 'name', 'members', 'tasks', 'concurrency'],
        [...teams.values()].map(t => [t.id, t.name, String(t.members.length), String(t.tasks.length), String(t.concurrency)]),
      )) console.log(`  ${l}`)
      return 0
    }

    // Before the team lookup: a run stays readable after its teams/<id>.json is gone.
    if (sub === 'status') {
      const id = args[1]
      const latest = latestRun(id, ctx.runsRoot)
      if (latest === undefined) {
        warn(id === undefined ? 'no team runs yet' : `no runs for team: ${id}`)
        info('start one with /team run <id>')
        return 1
      }
      const run = readRun(latest.dir)
      const failed = run.tasks.filter(t => t.status !== 'ok').length
      head(`team ${run.team}: run ${run.stamp}${run.state === 'incomplete' ? ' (incomplete)' : ''}`)
      for (const l of table(['task', 'persona', 'status', 'exit', 'seconds'], statusRows(run))) console.log(`  ${l}`)
      info(`${run.tasks.length - failed}/${run.tasks.length} ok · from ${run.source} · ${run.dir}`)
      return 0
    }

    const team = teams.get(args[1])
    if (team === undefined) { warn(`no such team: ${args[1] ?? '(none given)'}`); info(`available: ${[...teams.keys()].join(', ') || 'none'}`); return 1 }

    if (sub === 'show') {
      const personas = loadPersonas(ctx.cfg)
      head(`team ${team.name} (${team.id})`)
      if (team.description !== '') info(team.description)
      info(`source: ${team.source}   concurrency: ${team.concurrency}`)
      head('members')
      for (const l of table(['role', 'persona', 'exists'], team.members.map(m => [m.role ?? m.persona, m.persona, personas.has(m.persona) ? 'yes' : 'NO']))) console.log(`  ${l}`)
      head('tasks')
      for (const l of table(['id', 'member', 'after', 'prompt'], team.tasks.map(t => [
        t.id, t.member ?? '(active persona)', t.dependsOn.join(',') || '-',
        t.prompt.length > 60 ? `${t.prompt.slice(0, 57)}...` : t.prompt,
      ]))) console.log(`  ${l}`)
      const problems = validateTeam(team, personas)
      for (const p of problems) warn(p)
      return problems.length === 0 ? 0 : 1
    }

    if (sub === 'run') {
      const pAt = args.indexOf('--parallel')
      const oAt = args.indexOf('--only')
      const { results } = await runTeam(team, ctx, {
        concurrency: pAt >= 0 ? Number(args[pAt + 1]) : undefined,
        only: oAt >= 0 ? String(args[oAt + 1] ?? '').split(',').filter(s => s !== '') : undefined,
        dryRun: args.includes('--dry-run'),
      })
      return results.some(r => r.code !== 0) ? 1 : 0
    }

    warn(`unknown subcommand: ${sub}`)
    info(this.usage)
    return 1
  },
}
