/**
 * `/raid` - a persona-scoped command for the `project-manager` persona: empty RAID register (risks, assumptions, issues, dependencies).
 * Zero tokens, no model call: the launcher runs it in-process, same as any global quick-tool.
 * @module personas/project-manager/commands/raid
 */

import { head, info, line } from '../../../scripts/lib/util.mjs'

export default {
  name: 'raid',
  group: 'personas',
  summary: 'empty RAID register (risks, assumptions, issues, dependencies)',
  usage: '/raid',
  /**
   * @param {object} ctx - command context (unused: this command prints a fixed checklist).
   * @param {string[]} args - ignored.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    head('RAID register')
    for (const l of [
      '1. Risks: id | description | likelihood | impact | owner | mitigation',
      '2. Assumptions: id | assumption | owner | how and when it is checked',
      '3. Issues: id | description | severity | owner | next step | due',
      '4. Dependencies: id | depends on | owner | needed by | status',
    ]) line(`  ${l}`)
    info('every row has an owner; review it at each status report')
    return 0
  },
}
