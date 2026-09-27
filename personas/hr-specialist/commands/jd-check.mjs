/**
 * `/jd-check` - a persona-scoped command for the `hr-specialist` persona: job-description checklist.
 * Zero tokens, no model call: the launcher runs it in-process, same as any global quick-tool.
 * @module personas/hr-specialist/commands/jd-check
 */

import { head, info, line } from '../../../scripts/lib/util.mjs'

export default {
  name: 'jd-check',
  group: 'personas',
  summary: 'job-description checklist',
  usage: '/jd-check',
  /**
   * @param {object} ctx - command context (unused: this command prints a fixed checklist).
   * @param {string[]} args - ignored.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    head('job description check')
    for (const l of [
      '1. Must-have vs nice-to-have requirements are separated',
      '2. No age, gender, nationality or other protected-characteristic proxies ("young", "native speaker")',
      '3. Salary band stated',
      '4. Reporting line and team named',
      '5. Location and working pattern stated',
      '6. Accessibility note: how to ask for adjustments',
    ]) line(`  ${l}`)
    info('a drafting aid; decisions about real candidates stay with people')
    return 0
  },
}
