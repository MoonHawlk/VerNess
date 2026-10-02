/**
 * `/delegate <persona> <task>` — run one task as an ad-hoc single-task team wearing that persona.
 * Same runner as `/team run`: persona overlay, artifacts in `.finess/runs/delegate/<stamp>/`,
 * `summary.json`, so `/team status delegate` and `/task list` see it.
 * @module scripts/commands/delegate
 */

import { loadPersonas } from '../lib/personas.mjs'
import { runTeam } from '../lib/teams.mjs'
import { info, warn } from '../lib/util.mjs'

/**
 * The ad-hoc team for one delegation.
 * @param {string} persona - persona id.
 * @param {string} prompt - the task.
 * @returns {object} a team the runner accepts.
 */
export const delegateTeam = (persona, prompt) => ({
  id: 'delegate', name: 'delegate', description: 'ad-hoc single-task team', concurrency: 1, onFailure: 'stop',
  members: [{ role: persona, persona }],
  tasks: [{ id: 'task', prompt, member: persona, dependsOn: [] }],
  source: 'ad-hoc',
})

export default {
  name: 'delegate',
  group: 'teams',
  summary: 'run one task as a single-task team with a chosen persona',
  usage: '/delegate <persona> <task...>',
  details: ['output lands in .finess/runs/delegate/<timestamp>/; see it with /task list or /team status delegate'],
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - persona id then the task words.
   * @returns {Promise<number>} exit code.
   */
  async run(ctx, args) {
    const [persona, ...rest] = args
    const prompt = rest.join(' ').trim()
    if (persona === undefined || prompt === '') { warn('usage: /delegate <persona> <task...>'); return 1 }
    const personas = loadPersonas(ctx.cfg)
    if (!personas.has(persona)) { warn(`no such persona: ${persona}`); info(`available: ${[...personas.keys()].join(', ')}`); return 1 }
    const { results } = await runTeam(delegateTeam(persona, prompt), ctx, { runsRoot: ctx.runsRoot })
    return results.length > 0 && results.every(r => r.code === 0) ? 0 : 1
  },
}
