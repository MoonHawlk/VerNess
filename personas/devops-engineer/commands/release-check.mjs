/**
 * `/release-check` - a persona-scoped command for the `devops-engineer` persona: pre-release and rollback checklist.
 * Zero tokens, no model call: the launcher runs it in-process, same as any global quick-tool.
 * @module personas/devops-engineer/commands/release-check
 */

import { head, info, line } from '../../../scripts/lib/util.mjs'

export default {
  name: 'release-check',
  group: 'personas',
  summary: 'pre-release and rollback checklist',
  usage: '/release-check',
  /**
   * @param {object} ctx - command context (unused: this command prints a fixed checklist).
   * @param {string[]} args - ignored.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    head('release check')
    for (const l of [
      '1. Version bumped and tagged',
      '2. Changelog updated',
      '3. CI green on the release commit',
      '4. Artifacts and images pinned by digest',
      '5. Migrations reversible (or a restore plan written)',
      '6. Rollback step written down before the rollout',
      '7. No secrets in the diff or the logs',
      '8. An owner on call for the release window',
    ]) line(`  ${l}`)
    info('every box ticked, or the release waits')
    return 0
  },
}
