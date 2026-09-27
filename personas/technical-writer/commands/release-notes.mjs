/**
 * `/release-notes` - a persona-scoped command for the `technical-writer` persona: release-notes template.
 * Zero tokens, no model call: the launcher runs it in-process, same as any global quick-tool.
 * @module personas/technical-writer/commands/release-notes
 */

import { head, info, line } from '../../../scripts/lib/util.mjs'

export default {
  name: 'release-notes',
  group: 'personas',
  summary: 'release-notes template',
  usage: '/release-notes',
  /**
   * @param {object} ctx - command context (unused: this command prints a fixed checklist).
   * @param {string[]} args - ignored.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    head('release notes')
    for (const l of [
      '1. Added',
      '2. Changed',
      '3. Fixed',
      '4. Deprecated',
      '5. Breaking',
      '6. Upgrade steps',
    ]) line(`  ${l}`)
    info('every line names its task ID (T-###); build it from git log and 03-BACKLOG-DONE.md')
    return 0
  },
}
