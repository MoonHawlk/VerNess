/**
 * Workspace snapshots for `/diff` and `/undo` (T-454). Before a task that may write, a git workspace
 * gets a cheap snapshot: `git stash create` (a commit of the tracked working tree that touches
 * neither the tree, the index nor the stash list; empty output = clean, so HEAD is the base) plus
 * the untracked file list. Kept in `.finess/run/snapshots/<workspaceKey>.json`, newest first.
 *
 * Safety: git runs via spawnSync with argument arrays; everything is scoped to the workspace
 * (pathspec `.`, `--relative`); undo never resets, never stages, and only deletes files that are
 * untracked-and-not-ignored now but were not before.
 * @module scripts/lib/snapshots
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, normalize, sep } from 'node:path'

import { RUN_DIR } from './util.mjs'
import { workspaceKey } from './workspace.mjs'

/** Snapshots kept per workspace. */
export const KEEP = 10
/** Untracked files whose size/mtime are recorded (so undo can say which it cannot restore). */
const STAT_CAP = 500

/**
 * Run git in `cwd`.
 * @param {string} cwd - working directory.
 * @param {string[]} args - git arguments.
 * @param {{spawn?: typeof spawnSync}} [opts] - injectable spawn (tests).
 * @returns {{ok: boolean, out: string, err: string}} the result.
 */
export function git(cwd, args, { spawn = spawnSync } = {}) {
  const r = spawn('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0 && r.error === undefined, out: r.stdout ?? '', err: (r.stderr ?? '') + (r.error ? String(r.error.message) : '') }
}

/** @param {string} out - NUL-separated git output. @returns {string[]} the entries. */
export const splitZ = out => out.split('\0').filter(s => s !== '')

/**
 * @param {string} dir - a directory.
 * @returns {boolean} whether it sits inside a git work tree.
 */
export function isGitRepo(dir) {
  const r = git(dir, ['rev-parse', '--is-inside-work-tree'])
  return r.ok && r.out.trim() === 'true'
}

/** @param {string} dir - the workspace. @returns {string[]} untracked, not-ignored files, relative to it. */
export function untrackedFiles(dir) {
  return splitZ(git(dir, ['ls-files', '-z', '--others', '--exclude-standard', '--', '.']).out)
}

/**
 * Parse `git diff --name-status -z` output into `{status, path}` (renames are off, so one path each).
 * @param {string} out - raw output.
 * @returns {{status: string, path: string}[]} the changes.
 */
export function parseNameStatus(out) {
  const parts = splitZ(out)
  const res = []
  for (let i = 0; i + 1 < parts.length; i += 2) res.push({ status: parts[i][0], path: parts[i + 1] })
  return res
}

/**
 * Build a snapshot record (pure).
 * @param {{stash: string, head: string, untracked: string[], stats?: Record<string, {size: number, mtimeMs: number}>, at?: string, task?: string}} f - facts.
 * @returns {{at: string, base: string, clean: boolean, head: string, untracked: string[], stats: object, task?: string}} the record.
 */
export function snapshotRecord({ stash, head, untracked, stats = {}, at = new Date().toISOString(), task }) {
  const s = String(stash ?? '').trim()
  return { at, base: s === '' ? head : s, clean: s === '', head, untracked: [...untracked].sort(), stats, ...(task === undefined ? {} : { task: String(task).slice(0, 120) }) }
}

/**
 * Prepend a record, keeping the newest `keep` (pure).
 * @param {object[]} list - existing records, newest first. @param {object} rec - the new one.
 * @param {number} [keep] - how many to keep.
 * @returns {object[]} the new list.
 */
export const pushSnapshot = (list, rec, keep = KEEP) => [rec, ...(Array.isArray(list) ? list : [])].slice(0, keep)

/** @param {string} dir - workspace. @param {string} [root] - snapshots dir. @returns {string} the file. */
export const snapshotFile = (dir, root = join(RUN_DIR, 'snapshots')) => join(root, `${workspaceKey(dir)}.json`)

/** @param {string} dir - workspace. @param {string} [root] - snapshots dir. @returns {object[]} records, newest first. */
export function readSnapshots(dir, root) {
  try { const v = JSON.parse(readFileSync(snapshotFile(dir, root), 'utf8')); return Array.isArray(v) ? v : [] } catch { return [] }
}

/**
 * Snapshot the workspace before a task. No-op outside git or before the first commit.
 * @param {string} dir - the workspace.
 * @param {{root?: string, task?: string}} [opts] - snapshots dir (tests) and the task text.
 * @returns {{ok: true, record: object}|{ok: false, reason: string}} what happened.
 */
export function takeSnapshot(dir, { root, task } = {}) {
  if (!isGitRepo(dir)) return { ok: false, reason: 'not a git repository' }
  const head = git(dir, ['rev-parse', '--verify', '-q', 'HEAD'])
  if (!head.ok) return { ok: false, reason: 'no commit yet' }
  const stash = git(dir, ['stash', 'create'])
  if (!stash.ok) return { ok: false, reason: `git stash create failed: ${stash.err.trim()}` }
  const untracked = untrackedFiles(dir)
  const stats = {}
  for (const f of untracked.slice(0, STAT_CAP)) {
    try { const s = statSync(join(dir, f)); stats[f] = { size: s.size, mtimeMs: Math.round(s.mtimeMs) } } catch { /* vanished */ }
  }
  const record = snapshotRecord({ stash: stash.out, head: head.out.trim(), untracked, stats, task })
  const file = snapshotFile(dir, root)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(pushSnapshot(readSnapshots(dir, root), record), null, 2)}\n`)
  return { ok: true, record }
}

/**
 * What undo would do (pure).
 * @param {{snapshot: {untracked: string[], stats?: object}, changed: {status: string, path: string}[], untrackedNow: string[], statNow?: (f: string) => ({size: number, mtimeMs: number}|undefined)}} f - facts.
 * @returns {{restore: {status: string, path: string}[], remove: string[], drifted: string[]}}
 *   tracked paths to restore, new untracked files to delete, and pre-existing untracked files that
 *   changed (their content was never snapshotted, so they stay as they are).
 */
export function planUndo({ snapshot, changed, untrackedNow, statNow = () => undefined }) {
  const before = new Set(snapshot.untracked ?? [])
  const remove = untrackedNow.filter(f => !before.has(f) && safeRel(f)).sort()
  const drifted = []
  for (const f of [...before].sort()) {
    const was = snapshot.stats?.[f]
    if (was === undefined) continue
    const now = statNow(f)
    if (now === undefined || now.size !== was.size || Math.round(now.mtimeMs) !== was.mtimeMs) drifted.push(f)
  }
  return { restore: [...changed].sort((a, b) => a.path.localeCompare(b.path)), remove, drifted }
}

/** @param {string} rel - a path git reported. @returns {boolean} whether it stays inside the workspace. */
export function safeRel(rel) {
  if (typeof rel !== 'string' || rel === '' || isAbsolute(rel)) return false
  const n = normalize(rel)
  return n !== '..' && !n.startsWith(`..${sep}`) && !n.startsWith('../')
}

/**
 * Keep the first `max` lines (pure).
 * @param {string} text - text. @param {number} [max] - line cap.
 * @returns {{lines: string[], dropped: number}} the kept lines and how many were cut.
 */
export function truncateLines(text, max = 200) {
  const t = String(text).replace(/\n$/, '')
  const all = t === '' ? [] : t.split('\n')
  return { lines: all.slice(0, max), dropped: Math.max(0, all.length - max) }
}

/**
 * What changed since a snapshot, scoped to the workspace.
 * @param {string} dir - workspace. @param {object} snap - the record.
 * @returns {{stat: string, diff: string, changed: {status: string, path: string}[], added: string[]}} the facts.
 */
export function diffSince(dir, snap) {
  const stat = git(dir, ['diff', '--relative', '--stat', snap.base, '--', '.']).out
  const diff = git(dir, ['diff', '--relative', snap.base, '--', '.']).out
  const changed = parseNameStatus(git(dir, ['diff', '--relative', '--no-renames', '--name-status', '-z', snap.base, '--', '.']).out)
  const before = new Set(snap.untracked ?? [])
  const added = untrackedFiles(dir).filter(f => !before.has(f))
  return { stat, diff, changed, added }
}

/** @param {string} dir - workspace. @param {object} snap - the record. @returns {ReturnType<typeof planUndo>} the plan. */
export function undoPlan(dir, snap) {
  const changed = parseNameStatus(git(dir, ['diff', '--relative', '--no-renames', '--name-status', '-z', snap.base, '--', '.']).out)
  const statNow = f => { try { const s = statSync(join(dir, f)); return { size: s.size, mtimeMs: s.mtimeMs } } catch { return undefined } }
  return planUndo({ snapshot: snap, changed, untrackedNow: untrackedFiles(dir), statNow })
}

/**
 * Apply a plan: restore tracked files from the snapshot (working tree only), then delete the new
 * untracked files. Never resets, never touches ignored files.
 * @param {string} dir - workspace. @param {object} snap - the record. @param {ReturnType<typeof planUndo>} plan - the plan.
 * @returns {{ok: boolean, errors: string[]}} the outcome.
 */
export function applyUndo(dir, snap, plan) {
  const errors = []
  if (plan.restore.length > 0) {
    let r = git(dir, ['restore', `--source=${snap.base}`, '--worktree', '--', '.'])
    // git < 2.23 has no `restore`; checkout also writes the index for those paths.
    if (!r.ok && /not a git command|unknown/i.test(r.err)) r = git(dir, ['checkout', snap.base, '--', '.'])
    if (!r.ok) errors.push(`restore failed: ${r.err.trim()}`)
  }
  for (const f of plan.remove) {
    if (!safeRel(f)) continue
    const p = join(dir, f)
    try { if (existsSync(p)) rmSync(p, { force: true }) } catch (e) { errors.push(`could not delete ${f}: ${e.message}`) }
  }
  return { ok: errors.length === 0, errors }
}
