/**
 * `/tools` — the tools the model was actually offered, read from the most recent session's
 * `request/header` event. That is the only honest source: it is what the substrate sent on the wire,
 * not what we believe is registered. Each tool is marked `allowed | denied | ask` under the ACTIVE
 * persona's policy (T-154), computed with the plugin's own `decide`, so it matches the enforcement.
 * @module scripts/commands/tools
 */

import { join } from 'node:path'

import { verdict } from '../../packages/tool-policy/index.js'
import { activePolicy } from '../lib/personas.mjs'
import { listSessions, readSessionEvents } from '../lib/sessions.mjs'
import { head, info, warn } from '../lib/util.mjs'

export default {
  name: 'tools',
  group: 'telemetry',
  summary: 'tools offered to the model in the most recent session',
  usage: '/tools [--session <id>] [--all]',
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - flags.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const idAt = args.indexOf('--session')
    const sessions = listSessions({ workspace: args.includes('--all') ? undefined : ctx.workspaceKey, limit: 40 })
    const chosen = idAt >= 0 ? sessions.find(s => s.id.startsWith(args[idAt + 1])) : sessions[0]
    if (chosen === undefined) { info('no sessions recorded yet — run a task first'); return 0 }

    const events = readSessionEvents(join(chosen.dir, 'session.v4.jsonl.zstd'))
    const header = events.findLast(e => e.type === 'request/header')?.data?.header
    if (header === undefined) { warn('that session has no request header (it never reached the model)'); return 1 }

    const tools = header.tools ?? []
    const { id, policy, row } = activePolicy(ctx.cfg)
    const on = row !== undefined && row.enabled !== false
    head(`${tools.length} tool(s) offered in session ${chosen.id.slice(0, 8)}; policy column: persona ${id}`)
    for (const t of tools) {
      const first = String(t.description ?? '').split(/(?<=\.)\s/)[0]
      const v = on ? verdict(policy, String(t.name)) : 'allowed'
      console.log(`  ${String(t.name).padEnd(22)} ${v.padEnd(8)} ${first.length > 80 ? `${first.slice(0, 77)}...` : first}`)
    }
    info(on ? `policy: persona ${id}, enforced by finess-tool-policy (/permissions)` : 'policy: finess-tool-policy is not enabled, so every tool is allowed')
    info(`route: ${header.config?.provider}/${header.config?.model}`)
    info('this is what the substrate actually sent on the wire for that request')
    return 0
  },
}
