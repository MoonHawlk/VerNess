/**
 * `/a11y` - a persona-scoped command for the `frontend-developer` persona: WCAG AA quick checklist.
 * Zero tokens, no model call: the launcher runs it in-process, same as any global quick-tool.
 * @module personas/frontend-developer/commands/a11y
 */

import { head, info, line } from '../../../scripts/lib/util.mjs'

export default {
  name: 'a11y',
  group: 'personas',
  summary: 'WCAG AA quick checklist',
  usage: '/a11y',
  /**
   * @param {object} ctx - command context (unused: this command prints a fixed checklist).
   * @param {string[]} args - ignored.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    head('accessibility (WCAG AA)')
    for (const l of [
      '1. Semantic elements: buttons are <button>, links are <a>, headings in order',
      '2. Every input has a label; every meaningful image has alt text',
      '3. Keyboard: everything reachable with Tab, in a sensible order',
      '4. Focus is always visible',
      '5. Contrast: 4.5:1 for text, 3:1 for large text and UI parts',
      '6. Motion respects prefers-reduced-motion',
      '7. Colour is never the only way meaning is shown',
      '8. Usable at 200% zoom and at phone width',
    ]) line(`  ${l}`)
    info('check light and dark themes too')
    return 0
  },
}
