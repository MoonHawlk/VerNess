/**
 * `/access` — how far the agent's shell and file tools reach into this machine.
 *
 * The substrate already confines every shell/PowerShell/file tool call through its sandbox
 * (`dsh-sandbox-policy`, read from `DSH_PERMISSION_MODE`). This command only chooses the mode; the
 * enforcement is the substrate's.
 *
 *   read-only        reads anywhere, no writes
 *   workspace        (default) writes inside the working directory and temp only
 *   full             unconfined: anything your user account can do, no approval asked
 *
 * In this headless surface nothing can answer an approval prompt, so a call that needs to escalate
 * past the mode is REFUSED rather than asked about — the mode is the whole policy. On Windows the
 * sandbox restricts writes only; reads and network stay open in every mode (substrate limitation,
 * see `packages/sandbox/sandbox-windows-acl`).
 * @module scripts/commands/access
 */

import { ACCESS_MODES, accessMode } from '../lib/routes.mjs'
import { writeState } from '../lib/personas.mjs'
import { head, info, ok, warn } from '../lib/util.mjs'

const MEANING = {
  'read-only': 'reads anywhere, writes nothing',
  'workspace-write': 'writes inside the working directory and temp only; reads anywhere',
  'danger-full-access': 'UNCONFINED - anything your user account can do, with no approval step',
}

export default {
  name: 'access',
  group: 'model',
  summary: 'how far shell and file tools reach: read-only | workspace | full',
  usage: '/access [read-only | workspace | full --yes | reset]',
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - the mode, and `--yes` to confirm full access.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const [want] = args
    if (want === undefined) {
      const mode = accessMode()
      head(`tools run ${mode}: ${MEANING[mode] ?? 'custom mode'}`)
      if (process.env.DSH_PERMISSION_MODE !== undefined) info('set by DSH_PERMISSION_MODE in your shell, which wins over /access')
      info('an action beyond the mode is refused (headless has no approval prompt)')
      info('change it: /access read-only | workspace | full --yes')
      return 0
    }
    if (want === 'reset') {
      writeState({ access: undefined })
      ok(`access back to the default: ${accessMode()}`)
      return 0
    }
    const mode = ACCESS_MODES[want]
    if (mode === undefined) { warn(`unknown mode: ${want}`); info(this.usage); return 1 }
    if (mode === 'danger-full-access' && !args.includes('--yes')) {
      warn('full access lets the model run any command and change any file your account can')
      info('pair it with a model you trust, and confirm with: /access full --yes')
      return 1
    }
    writeState({ access: mode })
    ok(`tools now run ${mode}: ${MEANING[mode]}`)
    if (process.env.DSH_PERMISSION_MODE !== undefined) warn(`DSH_PERMISSION_MODE=${process.env.DSH_PERMISSION_MODE} in your shell still wins`)
    return 0
  },
}
