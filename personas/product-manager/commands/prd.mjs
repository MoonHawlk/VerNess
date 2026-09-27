/**
 * `/prd [title]` - a persona-scoped command for the `product-manager` persona: PRD skeleton.
 * Zero tokens, no model call: the launcher runs it in-process, same as any global quick-tool.
 * @module personas/product-manager/commands/prd
 */

import { head, info, line } from '../../../scripts/lib/util.mjs'

export default {
  name: 'prd',
  group: 'personas',
  summary: 'PRD skeleton',
  usage: '/prd [title]',
  /**
   * @param {object} ctx - command context (unused: this command prints a fixed checklist).
   * @param {string[]} args - the title, as free words.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const title = args.join(' ')
    head(title === '' ? 'PRD' : `PRD: ${title}`)
    for (const l of [
      '1. Problem: who has it, and the evidence',
      '2. Users: the segments this is for',
      '3. Goals and non-goals',
      '4. Success metrics: how we will know it worked',
      '5. Requirements: user stories with testable acceptance criteria',
      '6. Open questions',
      '7. Rollout: phases, flags, and how to roll back',
    ]) line(`  ${l}`)
    info('a skeleton to fill in, not a finished PRD')
    return 0
  },
}
