/**
 * `/threats <component>` - a persona-scoped command for the `security-engineer` persona: STRIDE checklist plus secrets and dependencies.
 * Zero tokens, no model call: the launcher runs it in-process, same as any global quick-tool.
 * @module personas/security-engineer/commands/threats
 */

import { head, info, line } from '../../../scripts/lib/util.mjs'

export default {
  name: 'threats',
  group: 'personas',
  summary: 'STRIDE checklist plus secrets and dependencies',
  usage: '/threats <component>',
  /**
   * @param {object} ctx - command context (unused: this command prints a fixed checklist).
   * @param {string[]} args - the component, as free words.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const component = args.join(' ')
    head(component === '' ? 'threats' : `threats: ${component}`)
    for (const l of [
      '1. Spoofing: can someone pretend to be a user, service or host?',
      '2. Tampering: can data or code be changed in transit or at rest?',
      '3. Repudiation: can an action be denied for lack of an audit trail?',
      '4. Information disclosure: what leaks through errors, logs or responses?',
      '5. Denial of service: what can be exhausted (CPU, memory, disk, quota)?',
      '6. Elevation of privilege: where does input cross a trust boundary?',
      '7. Secrets: any key, token or password in code, config, logs or history?',
      '8. Dependencies: known advisories, unpinned versions, unmaintained packages?',
    ]) line(`  ${l}`)
    info('list the assets and entry points first; a finding names file:line, attack, impact and fix')
    return 0
  },
}
