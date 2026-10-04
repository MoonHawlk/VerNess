/**
 * Blocking spawn whose timeout kills the whole process tree (T-472). `spawnSync` kills only its direct
 * child, and a dead parent can no longer anchor `taskkill /T` or a process group, so the blocking
 * caller runs a tiny wrapper that owns the child with the async `spawnAsync` (tree kill on timeout).
 * @module scripts/lib/treerun
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { spawnAsync } from './util.mjs'

const SELF = fileURLToPath(import.meta.url)

/**
 * Run a command to completion, blocking; on `timeoutMs` the child and everything it started die.
 * @param {string} file - executable.
 * @param {string[]} args - arguments.
 * @param {{cwd?: string, env?: Record<string,string>, capture?: boolean, timeoutMs: number, stdin?: number, maxBuffer?: number}} opts - options; `stdin` is an open fd fed to the child.
 * @returns {{code: number, out: string, timedOut: boolean, error?: Error}} exit status and merged output.
 */
export function runSyncTree(file, args, opts) {
  const dir = mkdtempSync(join(tmpdir(), 'finess-treerun-'))
  const spec = join(dir, 'spec.json')
  try {
    // The spec rides in a file: a long task would otherwise double the argv and hit the Windows limit.
    writeFileSync(spec, JSON.stringify({ file, args, timeoutMs: opts.timeoutMs, capture: opts.capture === true, hasStdin: opts.stdin !== undefined }))
    const io = opts.capture === true ? 'pipe' : 'inherit'
    const r = spawnSync(process.execPath, [SELF, spec], {
      cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: 'utf8', windowsHide: opts.capture === true || process.stdout.isTTY !== true,
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      stdio: [opts.stdin ?? 'ignore', io, io, 'pipe'],
    })
    const timedOut = String(r.output?.[3] ?? '').includes('timeout')
    return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), timedOut, ...(r.error === undefined ? {} : { error: r.error }) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// Wrapper mode: argv[2] is the spec file. fd 3 reports the timeout back to the blocked parent.
if (process.argv[1] === SELF && process.argv[2] !== undefined) {
  const s = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  const r = await spawnAsync(s.file, s.args, { cwd: process.cwd(), capture: s.capture, timeoutMs: s.timeoutMs, ...(s.hasStdin ? { stdin: 0 } : {}) })
  if (s.capture) process.stdout.write(r.out)
  if (r.timedOut === true) writeSync(3, 'timeout')
  process.exit(r.code)
}
