/**
 * `/agents` — the roster: every persona that can be put to work, and every team that coordinates
 * them. It is the one place that answers "who can I ask, and what is actually enforced?".
 * @module scripts/commands/agents
 */

import { activePersonaId, loadPersonas } from '../lib/personas.mjs'
import { loadTeams, validateTeam } from '../lib/teams.mjs'
import { head, info, paint, table } from '../lib/util.mjs'

export default {
  name: 'agents',
  aliases: ['roster'],
  group: 'personas',
  summary: 'personas and teams available, and which is active',
  usage: '/agents',
  /**
   * @param {object} ctx - command context.
   * @returns {number} exit code.
   */
  run(ctx) {
    const personas = loadPersonas(ctx.cfg)
    const active = activePersonaId(ctx.cfg)
    const teams = loadTeams()

    head(`personas (${personas.size})`)
    for (const l of table(
      ['', 'id', 'name', 'model', 'tools', 'skills', 'source'],
      [...personas.values()].map(p => [
        p.id === active ? paint('green', '*') : ' ',
        p.id,
        p.name,
        p.model.id ?? 'active route',
        `${p.tools.allow.length}/${p.tools.deny.length}`,
        String(p.skills.length),
        p.source,
      ]),
    )) console.log(`  ${l}`)
    info('* = active. tools column is allow/deny counts — recorded now, enforced from M4')

    head(`teams (${teams.size})`)
    if (teams.size === 0) info('none yet — add teams/<id>.json (see teams/README.md)')
    for (const t of teams.values()) {
      const problems = validateTeam(t, personas)
      console.log(`  ${t.id.padEnd(16)} ${t.members.length} member(s), ${t.tasks.length} task(s)${problems.length > 0 ? paint('yellow', `  ${problems.length} problem(s)`) : ''}`)
      if (t.description !== '') info(`  ${t.description}`)
    }
    info('run one with /team run <id>')
    return 0
  },
}
