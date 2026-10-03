/**
 * `/undo` (T-454) — put the workspace back as it was before the last task. Shows the plan first;
 * only `/undo --yes` changes files. Tracked files are restored from the snapshot (working tree only,
 * no reset); files that are untracked now but were not before are deleted; ignored files are never
 * touched.
 * @module scripts/commands/undo
 */

import { applyUndo, isGitRepo, readSnapshots, undoPlan } from '../lib/snapshots.mjs'
import { activeWorkspace } from '../lib/workspace.mjs'
import { head, info, line, ok, warn } from '../lib/util.mjs'

/** @type {Record<string, string>} */
const VERB = { M: 'restore', D: 'bring back', A: 'remove (added)', T: 'restore' }

export default {
  name: 'undo',
  group: 'core',
  summary: 'revert the workspace to the snapshot before the last task (asks first)',
  usage: '/undo [--yes]',
  details: [
    'without --yes it only prints what would change',
    'restores tracked files and deletes new untracked files; never resets, never touches ignored files',
    'untracked files that existed before the task are left as they are (their content was not snapshotted)',
  ],
  // Rewrites files in the terminal's workspace.
  web: false,
  /**
   * @param {object} ctx - command context; `workspaceDir` and `snapshotRoot` override for tests.
   * @param {string[]} args - flags.
   * @returns {number} exit code.
   */
  run(ctx, args = []) {
    const dir = ctx.workspaceDir ?? activeWorkspace().dir
    if (!isGitRepo(dir)) { info(`the workspace is not a git repository - no snapshots, nothing to undo (${dir})`); return 0 }
    const [snap] = readSnapshots(dir, ctx.snapshotRoot)
    if (snap === undefined) { info('no snapshot yet - one is taken before each task that may write'); return 0 }
    const plan = undoPlan(dir, snap)
    if (plan.restore.length === 0 && plan.remove.length === 0) {
      info(`the workspace already matches the snapshot from ${snap.at}`)
      for (const f of plan.drifted) warn(`${f} changed but was untracked before - left as it is`)
      return 0
    }
    head(`undo to the snapshot from ${snap.at}${snap.task ? ` (before: ${snap.task})` : ''}`)
    for (const c of plan.restore) line(`  ${(VERB[c.status] ?? 'restore').padEnd(15)} ${c.path}`)
    for (const f of plan.remove) line(`  ${'delete (new)'.padEnd(15)} ${f}`)
    for (const f of plan.drifted) warn(`${f} changed but was untracked before - left as it is`)
    if (!args.includes('--yes')) { info('nothing changed yet - run /undo --yes to apply'); return 0 }
    const res = applyUndo(dir, snap, plan)
    for (const e of res.errors) warn(e)
    if (!res.ok) return 1
    ok(`restored ${plan.restore.length} file(s), deleted ${plan.remove.length}`)
    return 0
  },
}
