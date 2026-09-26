/**
 * `/hypotheses <question>` — a persona-scoped command for the `data-scientist` persona. Prints a
 * fixed checklist for turning a loose question into testable hypotheses (zero tokens, no model
 * call): the launcher runs this in-process, same as any global quick-tool.
 * @module personas/data-scientist/commands/hypotheses
 */

import { head, info, line } from '../../../scripts/lib/util.mjs'

export default {
  name: 'hypotheses',
  group: 'personas',
  summary: 'checklist for turning a question into testable hypotheses',
  usage: '/hypotheses <question>',
  /**
   * @param {object} ctx - command context (unused: this command is a static checklist).
   * @param {string[]} args - the question, as free words.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const question = args.join(' ')
    head(question === '' ? 'hypotheses checklist' : `hypotheses: ${question}`)
    for (const l of [
      '1. State the null: what would "no effect / no difference" look like in the data?',
      '2. State the alternative(s): the specific, falsifiable claim(s) you actually suspect.',
      '3. Name the metric and the population/segment it is measured over.',
      '4. Name the comparison: baseline vs. treatment, before vs. after, or cohort vs. cohort.',
      '5. Say what data would prove each hypothesis wrong, and where that data lives.',
      '6. Note confounders you would need to control for or explicitly rule out.',
      '7. Decide the minimum sample size / date range before looking at results.',
    ]) line(`  ${l}`)
    info('this is a checklist, not an analysis — run the query, then check results against it')
    return 0
  },
}
