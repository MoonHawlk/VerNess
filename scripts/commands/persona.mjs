/**
 * `/persona` — inspect and switch the active persona. Switching writes `.verness/state.json` and
 * regenerates the profile patch, so the next task runs as that persona; the config file the user is
 * editing is never rewritten behind their back.
 * @module scripts/commands/persona
 */

import { activePersonaId, describePersona, loadPersonas, writeState } from '../lib/personas.mjs'
import { head, info, ok, paint, warn } from '../lib/util.mjs'

export default {
  name: 'persona',
  aliases: ['p'],
  group: 'personas',
  summary: 'show, describe or switch the active persona',
  usage: '/persona [<id> | show <id> | list]',
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - subcommand and arguments.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const personas = loadPersonas(ctx.cfg)
    const active = activePersonaId(ctx.cfg)

    if (args.length === 0 || args[0] === 'list') {
      head(`personas (active: ${active})`)
      for (const p of personas.values()) {
        console.log(`  ${p.id === active ? paint('green', '*') : ' '} ${p.id.padEnd(16)} ${p.description === '' ? p.name : p.description}`)
      }
      info('switch with /persona <id>, inspect with /persona show <id>')
      return 0
    }

    if (args[0] === 'show') {
      const p = personas.get(args[1])
      if (p === undefined) { warn(`no such persona: ${args[1]}`); return 1 }
      head(`persona ${p.id}`)
      for (const l of describePersona(p)) console.log(`  ${l}`)
      return 0
    }

    const id = args[0]
    const p = personas.get(id)
    if (p === undefined) {
      warn(`no such persona: ${id}`)
      info(`available: ${[...personas.keys()].join(', ')}`)
      return 1
    }
    writeState({ persona: id })
    ctx.sync()
    ok(`active persona is now ${p.name} (${id})`)
    if (p.model.id !== undefined) info(`it prefers model ${p.model.id} — applied on the next task`)
    if (p.tools.deny.length > 0) info(`it declares ${p.tools.deny.length} denied tool(s) — recorded, enforced from M4`)
    return 0
  },
}
