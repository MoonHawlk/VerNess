/**
 * Startup guard (T-312): warn when a `scripts/lib/*.mjs` the launcher imports is not tracked by git.
 * A local checkout runs fine with an untracked module, but a clone does not start at all — exactly
 * how all of `scripts/lib/` once went unshipped behind a `.gitignore` match (05-CONVENTIONS).
 * Cheap and silent when it cannot tell: no git, not a repository, or git too slow.
 * @module scripts/lib/tracked
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)'(\.{1,2}\/[^']+\.mjs)'/gm

/**
 * Every repo-relative `scripts/lib/*.mjs` reachable through relative `.mjs` imports from `entry`.
 * @param {string} entry - absolute path of the starting module.
 * @param {string} [repo] - repository root the returned paths are relative to.
 * @returns {string[]} forward-slash paths such as `scripts/lib/util.mjs`, sorted.
 */
export function libImports(entry, repo = REPO) {
  const seen = new Set()
  const libs = new Set()
  const queue = [resolve(entry)]
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(IMPORT)) {
      const target = resolve(dirname(file), m[1])
      const rel = relative(repo, target).replace(/\\/g, '/')
      if (!rel.startsWith('scripts/')) continue // e.g. packages/*: not the launcher's own modules
      if (/^scripts\/lib\/[^/]+\.mjs$/.test(rel)) libs.add(rel)
      queue.push(target) // follow scripts/model.mjs etc. too: they import lib modules of their own
    }
  }
  return [...libs].sort()
}

/**
 * @param {string[]} imported - repo-relative paths the launcher needs.
 * @param {Iterable<string>} tracked - repo-relative paths git tracks.
 * @returns {string[]} the imported paths git does not track.
 */
export function untrackedImports(imported, tracked) {
  const set = new Set([...tracked].map(p => p.replace(/\\/g, '/')))
  return imported.filter(p => !set.has(p))
}

/**
 * @param {string} [repo] - directory to ask.
 * @returns {Promise<Set<string>|undefined>} files git tracks under `scripts/lib`, or undefined when git is
 *   absent, the directory is not a repository, or git does not answer within two seconds.
 */
export function trackedLibFiles(repo = REPO) {
  return new Promise(done => {
    let out = ''
    let child
    try {
      child = spawn('git', ['ls-files', '--', 'scripts/lib'], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { done(undefined); return }
    const timer = setTimeout(() => { child.kill(); done(undefined) }, 2000)
    timer.unref()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', d => { out += d })
    child.on('error', () => { clearTimeout(timer); done(undefined) })
    child.on('close', code => {
      clearTimeout(timer)
      done(code === 0 ? new Set(out.split('\n').map(s => s.trim()).filter(Boolean)) : undefined)
    })
  })
}

/**
 * Print one stderr warning per untracked launcher module (stdout stays clean for callers that parse it).
 * Async so `scripts/cli.mjs` can overlap the git call with loading the launcher.
 * @param {string} [repo] - repository root.
 * @returns {Promise<string[]>} the untracked paths found (empty when none, or when git cannot tell).
 */
export async function warnUntrackedImports(repo = REPO) {
  const tracked = await trackedLibFiles(repo)
  if (tracked === undefined) return []
  const missing = untrackedImports(libImports(join(repo, 'scripts', 'finess.mjs'), repo), tracked)
  for (const p of missing) {
    process.stderr.write(`  !! ${p} is imported by the launcher but not tracked by git — a clone will not start (git add it, check .gitignore)\n`)
  }
  return missing
}
