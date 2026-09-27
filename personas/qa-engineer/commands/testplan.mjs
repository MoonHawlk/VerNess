/**
 * `/testplan <feature>` - a persona-scoped command for the `qa-engineer` persona: fixed test-plan checklist for a feature.
 * Zero tokens, no model call: the launcher runs it in-process, same as any global quick-tool.
 * @module personas/qa-engineer/commands/testplan
 */

import { head, info, line } from '../../../scripts/lib/util.mjs'

export default {
  name: 'testplan',
  group: 'personas',
  summary: 'fixed test-plan checklist for a feature',
  usage: '/testplan <feature>',
  /**
   * @param {object} ctx - command context (unused: this command prints a fixed checklist).
   * @param {string[]} args - the feature, as free words.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const feature = args.join(' ')
    head(feature === '' ? 'test plan' : `test plan: ${feature}`)
    for (const l of [
      '1. Scope: what is in, what is explicitly out',
      '2. Happy path: the main flow end to end',
      '3. Boundaries: empty, one, many, maximum, off-by-one',
      '4. Invalid input: wrong type, malformed, missing fields',
      '5. Error and timeout paths: dependency down, slow, partial failure',
      '6. Concurrency: two users or two runs at once',
      '7. Regression: related features that could break',
      '8. Data: setup and teardown, so tests do not depend on each other',
      '9. Exit criteria: what must pass before this ships',
    ]) line(`  ${l}`)
    info('a checklist, not a test run - write the cases, run them, quote the output')
    return 0
  },
}
