/**
 * The agent's working directory (T-363). Task runs spawn the substrate with this as `cwd`, so it is
 * also the `workspace-write` sandbox root and where the session is recorded. Defaults to this repo;
 * `/workspace <dir>` or `--workspace <dir>` point it at another project. The brief, `/btw` notes and
 * every quick-tool that reads FiNess files stay with the repo.
 * @module scripts/lib/workspace
 */

import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'

import { readState, writeState } from './personas.mjs'
import { REPO } from './util.mjs'

/**
 * The substrate's session-directory slug for a project path (`projectKey` in
 * `session-persistence-jsonl/src/format.ts`, minus its `--` fences, so a substring match still works).
 * @param {string} dir - an absolute project path.
 * @returns {string} the slug, e.g. `C-work-my~0020app`.
 */
export function workspaceKey(dir) {
  dir = String(dir)
  let out = ''
  let sep = false
  // UTF-16 code units, as the substrate walks them.
  for (let i = 0; i < dir.length; i++) {
    const c = dir[i]
    if (c === '/' || c === '\\' || c === ':') { if (!sep) out += '-'; sep = true; continue }
    sep = false
    out += c !== '~' && /^[A-Za-z0-9._-]$/.test(c) ? c : `~${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return (out.replace(/^-+/, '') || 'root').slice(0, 251)
}

/** @param {string} path - a path. @returns {boolean} whether it is an existing directory. */
const isDir = path => { try { return statSync(path).isDirectory() } catch { return false } }

/**
 * Validate a directory the user typed: `~` expands, a relative path resolves against `base`, and the
 * result is canonicalised so it matches the path the substrate records.
 * @param {string} input - what was typed.
 * @param {{base?: string, home?: string}} [opts] - resolution base (default: the process cwd) and home.
 * @returns {{dir: string}|{error: string}} the absolute directory, or why it was refused.
 */
export function resolveWorkspace(input, { base = process.cwd(), home = homedir() } = {}) {
  const raw = String(input ?? '').trim().replace(/^(["'])(.*)\1$/, '$2')
  if (raw === '') return { error: 'no directory given' }
  const expanded = raw === '~' ? home : /^~[\\/]/.test(raw) ? resolve(home, raw.slice(2)) : raw
  const abs = resolve(base, expanded)
  if (!isDir(abs)) return { error: `not a directory: ${abs}` }
  let dir = abs
  try { dir = realpathSync.native(abs) } catch { /* keep the resolved path */ }
  return { dir }
}

/**
 * Where the next task runs. A persisted directory that no longer exists falls back to the repo.
 * @param {object} [state] - launcher state; `.finess/state.json` unless a test passes one.
 * @param {string} [repo] - this repository.
 * @returns {{dir: string, isRepo: boolean, missing?: string}} the directory; `missing` names a
 *   persisted one that is gone.
 */
export function activeWorkspace(state = readState(), repo = REPO) {
  const want = state.workspace
  if (typeof want !== 'string' || want === '') return { dir: repo, isRepo: true }
  if (!isDir(want)) return { dir: repo, isRepo: true, missing: want }
  return { dir: want, isRepo: samePath(want, repo) }
}

/**
 * @param {string} a - a path. @param {string} b - another path.
 * @returns {boolean} whether both name the same directory (case-insensitive on Windows and macOS).
 */
export function samePath(a, b) {
  // Realpath first: macOS temp and home paths can sit behind a symlink (/var -> /private/var).
  const norm = p => { try { return realpathSync.native(p) } catch { return resolve(p).replace(/[\\/]+$/, '') } }
  return process.platform === 'linux' ? norm(a) === norm(b) : norm(a).toLowerCase() === norm(b).toLowerCase()
}

/** @param {{dir: string, isRepo: boolean}} ws - a workspace. @returns {string} a short label for status lines. */
export const workspaceLabel = ws => (ws.isRepo ? 'this repo' : basename(ws.dir) || ws.dir)

/**
 * Pull a leading `--workspace <dir>` (or `--workspace=<dir>`) off the launcher's argv. Only leading
 * flags are looked at, so the words of a task are never touched.
 * @param {string[]} argv - the launcher's words.
 * @returns {{argv: string[], workspace?: string}} the remaining words and the requested directory.
 */
export function takeWorkspaceFlag(argv) {
  const out = [...argv]
  let workspace
  for (let i = 0; i < out.length && out[i]?.startsWith('--');) {
    if (out[i] === '--workspace') { workspace = out[i + 1] ?? ''; out.splice(i, 2); continue }
    if (out[i].startsWith('--workspace=')) { workspace = out[i].slice('--workspace='.length); out.splice(i, 1); continue }
    i++
  }
  return workspace === undefined ? { argv: out } : { argv: out, workspace }
}

/**
 * Persist the workspace (undefined = back to the repo). A different directory also drops the
 * remembered session: the substrate refuses to adopt a session recorded in another cwd.
 * @param {string|undefined} dir - the new directory, already validated.
 * @returns {{changed: boolean, ws: {dir: string, isRepo: boolean}}} whether it moved, and where to.
 */
export function switchWorkspace(dir) {
  const before = activeWorkspace()
  const next = dir === undefined || samePath(dir, REPO) ? undefined : dir
  const changed = !samePath(before.dir, next ?? REPO)
  writeState(changed ? { workspace: next, session: undefined } : { workspace: next })
  return { changed, ws: activeWorkspace() }
}
