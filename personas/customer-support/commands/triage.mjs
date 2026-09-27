/**
 * `/triage` - a persona-scoped command for the `customer-support` persona: severity rubric, categories and escalation rules.
 * Zero tokens, no model call: the launcher runs it in-process, same as any global quick-tool.
 * @module personas/customer-support/commands/triage
 */

import { head, info, line } from '../../../scripts/lib/util.mjs'

export default {
  name: 'triage',
  group: 'personas',
  summary: 'severity rubric, categories and escalation rules',
  usage: '/triage',
  /**
   * @param {object} ctx - command context (unused: this command prints a fixed checklist).
   * @param {string[]} args - ignored.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    head('triage')
    for (const l of [
      '1. S1: service down or data loss for many users - escalate now',
      '2. S2: a core feature broken, no workaround',
      '3. S3: broken with a workaround, or one user affected',
      '4. S4: question, cosmetic issue or feature request',
      '5. Categories: bug | how-to | account | billing | feature request | security',
      '6. Always escalate to a human: security, billing disputes, data-loss reports',
    ]) line(`  ${l}`)
    info('drafts only - a human sends; never ask for passwords or payment details')
    return 0
  },
}
