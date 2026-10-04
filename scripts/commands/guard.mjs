/**
 * `/guard` — the irreversible-command guard (T-473): its mode, and `/guard check <line>` to see how a
 * command line would be judged without running it. Uses the plugin's own classifier, so the answer
 * matches the enforcement.
 * @module scripts/commands/guard
 */

import { classifyCommand, GUARD_ID, modeOf, rowOf } from '../../packages/guard/index.js'
import { head, info, ok, warn } from '../lib/util.mjs'

/**
 * The status lines for a config.
 * @param {object} cfg - the merged configuration. @returns {string[]} the lines.
 */
export function guardStatus(cfg) {
  const row = rowOf(cfg)
  const mode = modeOf(row?.config)
  const state = row === undefined ? `NOT configured (no ${GUARD_ID} row): model tool calls are not guarded`
    : row.enabled === false ? 'DISABLED in finess.config.json: model tool calls are not guarded'
      : '[enforced] on tools/pre-execute for bash, pwsh, terminal_send (and run_code\'s nested calls)'
  return [
    `plugin: @finess/guard — ${state}`,
    `mode:   ${mode}${mode === 'deny' ? ' (irreversible commands are refused without asking)' : ' (shown in full, confirmed twice: yes, then DELETE)'}`,
    'REPL:   !cmd / !!cmd use the same classifier and confirmations (always on)',
  ]
}

export default {
  name: 'guard',
  group: 'core',
  summary: 'the irreversible-command guard: mode, and check a line without running it',
  usage: '/guard [check <command line>]',
  /**
   * @param {object} ctx - command context. @param {string[]} args - `check` and the line.
   * @returns {number} exit code: 0, or 2 when the checked line would be blocked.
   */
  run(ctx, args) {
    if (args[0] === 'check') {
      const line = args.slice(1).join(' ')
      if (line.trim() === '') { warn('usage: /guard check <command line>'); return 1 }
      const v = classifyCommand(line)
      if (!v.irreversible) { ok(`allowed - not irreversible: ${line}`); return 0 }
      warn(`IRREVERSIBLE - would need two confirmations: ${line}`)
      for (const r of v.reasons) info(r)
      return 2
    }
    head('command guard (T-473)')
    for (const l of guardStatus(ctx.cfg)) console.log(`  ${l}`)
    info('/guard check <line> shows how a line is judged; nothing is run')
    return 0
  },
}
