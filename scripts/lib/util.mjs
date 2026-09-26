/**
 * Shared primitives for the launcher, its commands and the team runner: paths, JSONC parsing,
 * process spawning, and the small output vocabulary every surface uses.
 * @module scripts/lib/util
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const WIN = process.platform === 'win32'
/** Launcher-local state and per-run artifacts; gitignored, safe to delete. */
export const RUN_DIR = join(REPO, '.verness', 'run')

const C = {
  dim: '[2m', red: '[31m', green: '[32m',
  yellow: '[33m', cyan: '[36m', bold: '[1m', off: '[0m',
}
/**
 * @param {keyof C} name - a colour name.
 * @param {string} s - the text.
 * @returns {string} the text, coloured only when stdout is a terminal.
 */
export const paint = (name, s) => (process.stdout.isTTY ? C[name] + s + C.off : s)
export const head = s => console.log(paint('cyan', s))
export const step = s => console.log(`${paint('cyan', '==> ')}${s}`)
export const ok = s => console.log(`${paint('green', '  ok ')}${s}`)
export const warn = s => console.log(`${paint('yellow', '  !! ')}${s}`)
export const info = s => console.log(paint('dim', `     ${s}`))
export const line = s => console.log(s)

/**
 * Strip `//` and `/* *​/` comments outside strings, drop trailing commas, then parse. Keeps the
 * config and persona files hand-editable.
 * @param {string} text - the raw file contents.
 * @returns {any} the parsed value.
 */
export function parseJsonc(text) {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      out += ch
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; out += ch; continue }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue }
    if (ch === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue }
    out += ch
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/**
 * Quote one argument for `cmd.exe`: Node cannot spawn a Windows `.cmd` shim without a shell, so the
 * quoting has to happen here rather than being left to the shell.
 * @param {string} a - the raw argument.
 * @returns {string} the quoted argument.
 */
export function winQuote(a) {
  const s = String(a)
  if (s === '') return '""'
  return `"${s.replaceAll('"', '\\"').replaceAll('%', '%^')}"`
}

/**
 * Run a command synchronously.
 * @param {string} cmd - executable name.
 * @param {string[]} args - arguments.
 * @param {{capture?: boolean, env?: Record<string,string>, cwd?: string}} [opts] - options.
 * @returns {{code: number, out: string}} exit status and captured output.
 */
export function sh(cmd, args, opts = {}) {
  const base = {
    cwd: opts.cwd ?? REPO,
    env: { ...process.env, ...opts.env },
    stdio: opts.capture === true ? 'pipe' : 'inherit',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }
  const r = WIN
    ? spawnSync([cmd, ...args.map(winQuote)].join(' '), { ...base, shell: true })
    : spawnSync(cmd, args, base)
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

/**
 * @param {number} bytes - a byte count.
 * @returns {string} a human-readable size.
 */
export function human(bytes) {
  const n = Number(bytes ?? 0)
  if (n <= 0) return '0'
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`
}

/**
 * @param {number} n - a count.
 * @returns {string} the count with thousands separators.
 */
export const num = n => Number(n ?? 0).toLocaleString('en-US')

/**
 * Render a simple aligned table.
 * @param {string[]} headers - column headers.
 * @param {(string|number)[][]} rows - row cells.
 * @returns {string[]} the rendered lines.
 */
export function table(headers, rows) {
  const all = [headers, ...rows.map(r => r.map(String))]
  const w = headers.map((_, i) => Math.max(...all.map(r => (r[i] ?? '').length)))
  const render = r => r.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ').trimEnd()
  return [paint('dim', render(headers)), ...rows.map(r => render(r.map(String)))]
}
