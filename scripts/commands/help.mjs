/**
 * `/help` — the command index, grouped. Also the template for a new command: default-export
 * `{ name, summary, run }` from a file in this directory and it is registered automatically.
 * @module scripts/commands/help
 */

import { head, info, line, paint } from '../lib/util.mjs'

export default {
  name: 'help',
  aliases: ['?', 'commands'],
  group: 'core',
  summary: 'list every quick-tool',
  usage: '/help [command]',
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - optional command name.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const seen = new Map()
    for (const cmd of ctx.commands.values()) seen.set(cmd.name, cmd)

    if (args.length > 0) {
      const cmd = ctx.commands.get(args[0].replace(/^\//, '').toLowerCase())
      if (cmd === undefined) { info(`no such command: ${args[0]}`); return 1 }
      head(`/${cmd.name}`)
      info(cmd.summary)
      if (cmd.usage !== undefined) info(`usage: ${cmd.usage}`)
      if (cmd.aliases !== undefined) info(`aliases: ${cmd.aliases.map(a => `/${a}`).join(' ')}`)
      if (cmd.details !== undefined) for (const l of cmd.details) info(l)
      return 0
    }

    const groups = new Map()
    for (const cmd of seen.values()) {
      const g = cmd.group ?? 'other'
      groups.set(g, [...(groups.get(g) ?? []), cmd])
    }
    const order = ['core', 'model', 'personas', 'teams', 'telemetry', 'other']
    for (const g of [...groups.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b))) {
      head(g)
      for (const cmd of groups.get(g).sort((a, b) => a.name.localeCompare(b.name))) {
        line(`  ${paint('bold', `/${cmd.name}`.padEnd(12))} ${cmd.summary}`)
      }
    }
    line('')
    info('anything that is not a command is sent to the model as a task')
    info('add a command: drop a file in scripts/commands/ exporting { name, summary, run }')
    return 0
  },
}
