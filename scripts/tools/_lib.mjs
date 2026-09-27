/**
 * Shared helpers for `scripts/tools/*`: small, read-only repo tools whose output is the answer an
 * agent would otherwise assemble from grep, git and file reads. Node only (no shell syntax), so
 * every tool behaves the same on macOS, Linux and Windows.
 * @module scripts/tools/_lib
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO } from '../lib/util.mjs'

export { REPO }

/**
 * Run git in the repo (no shell; `git` resolves through PATH on every OS).
 * @param {string[]} args - git arguments.
 * @returns {{code: number, out: string}} exit status and trimmed stdout.
 */
export function git(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status ?? 1, out: String(r.stdout ?? '').trimEnd() }
}

/**
 * Files git tracks, repo-relative with forward slashes. The `upstream/` submodule is excluded:
 * it is read-only and would drown every search.
 * @param {RegExp} [only] - keep only paths matching this.
 * @returns {string[]} the paths.
 */
export function trackedFiles(only) {
  return git(['ls-files']).out.split('\n').filter(f => f !== '' && !f.startsWith('upstream/') && (only === undefined || only.test(f)))
}

/**
 * @param {string} rel - a repo-relative path.
 * @returns {string} its text ('' when unreadable), with CRLF normalised.
 */
export function readText(rel) {
  try { return readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n') } catch { return '' }
}

/**
 * Parse `--flag value` and `--flag` options; everything else is positional.
 * @param {string[]} argv - process.argv.slice(2).
 * @returns {{_: string[], [k: string]: string|boolean|string[]}} the options.
 */
export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++ } else out[key] = true
  }
  return out
}

/**
 * Print a usage block and exit 0 when `--help` was given.
 * @param {object} args - parsed arguments.
 * @param {string} text - the usage text.
 */
export function helpIf(args, text) {
  if (args.help !== true && args.h !== true) return
  console.log(text.trim())
  process.exit(0)
}

/**
 * Left-aligned plain-text table.
 * @param {string[]} head - the header cells.
 * @param {string[][]} rows - the rows.
 * @returns {string} the table.
 */
export function table(head, rows) {
  const all = [head, ...rows].map(r => r.map(c => String(c ?? '')))
  const w = head.map((_, i) => Math.max(...all.map(r => r[i]?.length ?? 0)))
  return all.map(r => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join('  ')).join('\n')
}

/** @returns {object|undefined} the Engram graph, if it has been built. */
export function loadGraph() {
  const f = join(REPO, '.engram', 'graph.json')
  if (!existsSync(f)) return undefined
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return undefined }
}
