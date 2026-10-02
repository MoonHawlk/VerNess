#!/usr/bin/env node
/**
 * `check-clean-clone` — prove the committed tree starts, not just the working directory (see
 * docs/05-CONVENTIONS.md "Verify from a clean clone"). Clones the repo into a temp dir, checks out
 * the commit(s) under test, runs `node scripts/verness.mjs help` there, reports pass/fail and
 * removes the clone. Node only, so it behaves the same on macOS, Linux and Windows.
 *
 *   node scripts/check-clean-clone.mjs              check HEAD
 *   node scripts/check-clean-clone.mjs <rev>...     check these commits
 *   node scripts/check-clean-clone.mjs --hook       pre-push mode: read the pushed refs from stdin
 *
 * Opt-in hook: `git config core.hooksPath scripts/hooks` (runs scripts/hooks/pre-push).
 * Skip once: VERNESS_SKIP_CLEAN_CLONE=1 git push   (or `git push --no-verify`).
 * @module scripts/check-clean-clone
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..')
const ZERO = /^0+$/

export const USAGE = `
check-clean-clone [rev...] [--hook]
  clones this repo into a temp dir, checks out each rev (default HEAD), runs
  "node scripts/verness.mjs help" there and reports pass/fail; the clone is removed afterwards.
  --hook   pre-push mode: reads "<local ref> <local sha> <remote ref> <remote sha>" lines from stdin
           and checks every pushed (non-deleted) commit
  env VERNESS_SKIP_CLEAN_CLONE=1 skips the check (exit 0)
  install the hook (opt-in): git config core.hooksPath scripts/hooks`

/**
 * The commits a pre-push hook must check: the local sha of each pushed ref, minus deletions
 * (all-zero sha), de-duplicated in order.
 * @param {string} text - the hook's stdin.
 * @returns {string[]} the shas.
 */
export function pushedCommits(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const [, sha] = line.trim().split(/\s+/)
    if (sha !== undefined && !ZERO.test(sha) && !out.includes(sha)) out.push(sha)
  }
  return out
}

/** @param {string} cmd @param {string[]} args @param {string} cwd @returns {{code: number, out: string}} */
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`.trim() }
}

/**
 * Clone, check out each rev, run `help`. Never throws; always removes the temp dir.
 * @param {string[]} revs - commits to check (resolvable in the source repo).
 * @param {string} [repo] - the source repository.
 * @returns {{ok: boolean, lines: string[]}} the verdict and a report.
 */
export function checkCleanClone(revs, repo = REPO) {
  const lines = []
  const base = mkdtempSync(join(tmpdir(), 'verness-clean-clone-'))
  const dir = join(base, 'fresh')
  try {
    // --no-checkout: we choose the commit; a plain clone would only take the current branch tip.
    const c = run('git', ['clone', '--quiet', '--no-checkout', repo, dir], base)
    if (c.code !== 0) return { ok: false, lines: [`FAIL clone: ${c.out}`] }
    let ok = true
    for (const rev of revs) {
      // Resolve in the source: an unpushed local sha or a symbolic rev like HEAD means the source's.
      const sha = run('git', ['rev-parse', '--verify', `${rev}^{commit}`], repo)
      if (sha.code !== 0) { ok = false; lines.push(`FAIL ${rev}: not a commit`); continue }
      const co = run('git', ['checkout', '--quiet', '--force', '--detach', sha.out], dir)
      if (co.code !== 0) { ok = false; lines.push(`FAIL ${rev}: checkout: ${co.out}`); continue }
      const h = run(process.execPath, ['scripts/verness.mjs', 'help'], dir)
      if (h.code === 0) lines.push(`ok   ${rev} (${sha.out.slice(0, 7)}): verness help runs from a clean clone`)
      else { ok = false; lines.push(`FAIL ${rev} (${sha.out.slice(0, 7)}): verness help exited ${h.code}\n${h.out.split('\n').slice(-15).join('\n')}`) }
    }
    return { ok, lines }
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/** @param {string[]} argv - process.argv.slice(2). @returns {number} the exit code. */
function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE.trim()); return 0 }
  if (process.env.VERNESS_SKIP_CLEAN_CLONE === '1') { console.log('clean-clone check skipped (VERNESS_SKIP_CLEAN_CLONE=1)'); return 0 }
  const hook = argv.includes('--hook')
  let revs = argv.filter(a => !a.startsWith('--'))
  if (hook) {
    let stdin = ''
    try { stdin = readFileSync(0, 'utf8') } catch { /* no stdin: nothing pushed */ }
    revs = pushedCommits(stdin)
    if (revs.length === 0) return 0
  } else if (revs.length === 0) revs = ['HEAD']
  const { ok, lines } = checkCleanClone(revs)
  for (const l of lines) console.log(l)
  if (!ok) console.error('clean-clone check failed: the committed tree does not start (skip once: VERNESS_SKIP_CLEAN_CLONE=1 or --no-verify)')
  return ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2))
