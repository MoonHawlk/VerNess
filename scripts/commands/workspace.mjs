/**
 * `/workspace` — which directory the agent works in (T-363). Task runs start the substrate there, so
 * it is also the root the `workspace` access mode lets tools write under. The project brief (`#`),
 * `/btw` notes and quick-tools that read FiNess itself (dashboard, backlog) stay with this repo.
 * @module scripts/commands/workspace
 */

import { accessMode } from '../lib/routes.mjs'
import { activeWorkspace, resolveWorkspace, switchWorkspace } from '../lib/workspace.mjs'
import { head, info, ok, REPO, warn } from '../lib/util.mjs'

export default {
  name: 'workspace',
  aliases: ['cwd'],
  group: 'model',
  // The browser UI picks its own workspace; this one steers the terminal launcher's task runs.
  web: false,
  summary: 'the directory the agent works in: /workspace <dir> | reset',
  usage: '/workspace [<dir> | reset]',
  details: [
    'the next task runs in that directory; the `workspace` access mode writes only under it',
    'switching starts a new conversation (a session belongs to the directory it was recorded in)',
    'the project brief and /btw notes stay with FiNess; start with --workspace <dir> to set it at boot',
  ],
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - a directory (spaces allowed), or `reset`.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    if (args.length === 0) {
      const ws = activeWorkspace()
      head(`the agent works in ${ws.dir}${ws.isRepo ? ' (this repo)' : ''}`)
      if (ws.missing !== undefined) warn(`the saved workspace ${ws.missing} is gone - using this repo`)
      info(`tools run ${accessMode()}${accessMode() === 'workspace-write' ? ': writes stay under that directory' : ''}`)
      info('change it: /workspace <dir>, back to this repo: /workspace reset')
      return 0
    }
    let target
    if (args.length === 1 && args[0] === 'reset') target = undefined
    else {
      const r = resolveWorkspace(args.join(' '))
      if ('error' in r) { warn(r.error); info(this.usage); return 1 }
      target = r.dir
    }
    const { changed, ws } = switchWorkspace(target)
    if (changed) ctx.conversation?.reset()
    ok(ws.isRepo ? `the agent works in this repo again (${REPO})` : `the agent now works in ${ws.dir}`)
    if (changed) info('the next task starts a new conversation there')
    else info('unchanged')
    return 0
  },
}
