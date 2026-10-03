/**
 * How a task reaches the substrate (T-448). A short task rides as the last argv element. A long one
 * would hit the Windows command-line cap (32,767 UTF-16 units; ~8191 through the `cmd.exe` shim),
 * so it goes to a temp file under `.finess/run/`, opened as the child's stdin, and the argument
 * becomes `-`: the headless app reads the task from stdin then
 * (`@deepseek-ai/dsh-headless` startup.ts:45,96-103, index.ts:325-327). Same text, no size limit.
 * @module scripts/lib/taskarg
 */

import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Longest task kept on argv; past it the task goes through stdin. Well under both Windows caps. */
export const ARGV_TASK_MAX = 8000

/**
 * Whether the trailing argument (the task) should go through stdin.
 * @param {string[]} args - dsh arguments, the task last.
 * @param {{max?: number, always?: boolean}} [opts] - `always` for the `cmd.exe` shim, which also
 *   breaks newlines and expands `%`; `max` overrides {@link ARGV_TASK_MAX}.
 * @returns {boolean} true to stage it.
 */
export function wantsStdin(args, opts = {}) {
  const last = args.at(-1)
  if (typeof last !== 'string' || last === '' || last === '-') return false
  return opts.always === true || last.length > (opts.max ?? ARGV_TASK_MAX)
}

/**
 * Stage the trailing task on a temp file when {@link wantsStdin} says so. Call once per spawn: the
 * fd is read to EOF by the child, so a retry needs a fresh one.
 * @param {string[]} args - dsh arguments, the task last.
 * @param {string} dir - where the temp file goes (`.finess/run/` in the launcher, a temp dir in tests).
 * @param {{max?: number, always?: boolean, enabled?: boolean}} [opts] - see {@link wantsStdin}; `enabled: false` never stages.
 * @returns {{args: string[], stdin?: number, file?: string, cleanup: () => void}} the arguments to
 *   spawn with, the fd to use as stdin (absent: keep the default), and an idempotent cleanup.
 */
export function stageTask(args, dir, opts = {}) {
  if (opts.enabled === false || !wantsStdin(args, opts)) return { args, cleanup: () => {} }
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `task-${process.pid}-${randomUUID()}.txt`)
  writeFileSync(file, args.at(-1), 'utf8')
  let fd = openSync(file, 'r')
  const cleanup = () => {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* already closed */ } fd = undefined }
    rmSync(file, { force: true })
  }
  return { args: [...args.slice(0, -1), '-'], stdin: fd, file, cleanup }
}
