/**
 * `/diff` (T-454) — what the last task changed in the workspace, against the snapshot taken before it.
 * @module scripts/commands/diff
 */

import { diffSince, isGitRepo, readSnapshots, truncateLines } from '../lib/snapshots.mjs'
import { activeWorkspace } from '../lib/workspace.mjs'
import { head, info, line, warn } from '../lib/util.mjs'

/** Diff lines shown before truncating. */
const MAX_LINES = 200

export default {
  name: 'diff',
  group: 'core',
  summary: 'what the last task changed in the workspace (git workspaces only)',
  usage: '/diff [--all]',
  details: [
    'compares the working tree with the snapshot taken before the last task that could write',
    `the patch is cut at ${MAX_LINES} lines; --all prints it whole`,
    'revert it with /undo',
  ],
  // Reads the terminal's workspace and prints a long patch; not for the browser UI.
  web: false,
  /**
   * @param {object} ctx - command context; `workspaceDir` and `snapshotRoot` override for tests.
   * @param {string[]} args - flags.
   * @returns {number} exit code.
   */
  run(ctx, args = []) {
    const dir = ctx.workspaceDir ?? activeWorkspace().dir
    if (!isGitRepo(dir)) { info(`the workspace is not a git repository - no snapshots, nothing to diff (${dir})`); return 0 }
    const [snap] = readSnapshots(dir, ctx.snapshotRoot)
    if (snap === undefined) { info('no snapshot yet - one is taken before each task that may write'); return 0 }
    const { stat, diff, added } = diffSince(dir, snap)
    head(`changes since ${snap.at}${snap.task ? ` (before: ${snap.task})` : ''}`)
    if (stat.trim() === '' && added.length === 0) { info('nothing changed'); return 0 }
    for (const l of truncateLines(stat, Infinity).lines) line(l)
    if (added.length > 0) {
      head(`new untracked file(s): ${added.length}`)
      for (const f of added) line(`  + ${f}`)
    }
    if (diff.trim() !== '') {
      const { lines, dropped } = truncateLines(diff, args.includes('--all') ? Infinity : MAX_LINES)
      line('')
      for (const l of lines) line(l)
      if (dropped > 0) warn(`${dropped} more line(s) - /diff --all, or: git diff ${snap.base.slice(0, 12)} -- .`)
    }
    info('revert these changes: /undo')
    return 0
  },
}
