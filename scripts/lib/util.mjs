/**
 * Shared primitives for the launcher, its commands and the team runner: paths, JSONC parsing,
 * process spawning, and the small output vocabulary every surface uses.
 * @module scripts/lib/util
 */

import { spawn, spawnSync } from 'node:child_process'
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
 * Spawn a process without blocking the event loop, so several can run at once. Mirrors `spawnSync`'s
 * contract: stdin is closed (a child reading a non-TTY stdin would otherwise wait forever), a spawn
 * failure resolves with code 1 instead of rejecting, and the promise settles on `close`, after the
 * output streams are drained.
 * @param {string} file - executable (or a whole command line when `opts.shell` is set).
 * @param {string[]} args - arguments.
 * @param {{capture?: boolean, env?: Record<string,string>, cwd?: string, shell?: boolean}} [opts] - options.
 * @returns {Promise<{code: number, out: string}>} exit status and captured output.
 */
export function spawnAsync(file, args, opts = {}) {
  return new Promise(res => {
    const chunks = []
    let settled = false
    const done = code => {
      if (settled) return
      settled = true
      res({ code, out: Buffer.concat(chunks).toString('utf8').trim() })
    }
    let child
    try {
      child = spawn(file, args, {
        cwd: opts.cwd ?? REPO,
        env: { ...process.env, ...opts.env },
        stdio: opts.capture === true ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
        shell: opts.shell === true,
      })
    } catch (e) {
      chunks.push(Buffer.from(String(e.message)))
      done(1)
      return
    }
    child.stdout?.on('data', c => chunks.push(c))
    child.stderr?.on('data', c => chunks.push(c))
    child.on('error', e => { chunks.push(Buffer.from(String(e.message))); done(1) })
    child.on('close', code => done(code ?? 1))
  })
}

/**
 * The asynchronous `sh`: same quoting, same shell rule on Windows, but it does not block.
 * @param {string} cmd - executable name.
 * @param {string[]} args - arguments.
 * @param {{capture?: boolean, env?: Record<string,string>, cwd?: string}} [opts] - options.
 * @returns {Promise<{code: number, out: string}>} exit status and captured output.
 */
export function shAsync(cmd, args, opts = {}) {
  return WIN
    ? spawnAsync([cmd, ...args.map(winQuote)].join(' '), [], { ...opts, shell: true })
    : spawnAsync(cmd, args, opts)
}

/**
 * The PowerShell line that starts a background server in a hidden console and prints its PID.
 * Each argument is quoted for the Windows command line, then the whole thing is single-quoted for
 * PowerShell (`'` doubled), so neither layer can split or expand it.
 * @param {string} file - the executable.
 * @param {string[]} args - its arguments.
 * @returns {string} the `-Command` text.
 */
export function hiddenStartCommand(file, args) {
  const ps = s => `'${String(s).replaceAll("'", "''")}'`
  const argv = args.map(a => (a === '' || /[\s"]/.test(a) ? `"${String(a).replaceAll('"', '\\"')}"` : a)).join(' ')
  return `(Start-Process -FilePath ${ps(file)}${argv === '' ? '' : ` -ArgumentList ${ps(argv)}`} -WindowStyle Hidden -PassThru).Id`
}

/**
 * Start a long-lived server that outlives the launcher (the model engine, the decision sidecar).
 *
 * On Windows this cannot be `spawn(..., {detached: true})`. That creates the child with
 * `DETACHED_PROCESS`, i.e. with no console at all, and every console helper the server launches
 * (Ollama's GPU discovery and runners, Python subprocesses) then gets a brand-new visible console:
 * a burst of terminal windows flashing open and shut. `windowsHide` cannot help, because Windows
 * ignores `CREATE_NO_WINDOW` alongside `DETACHED_PROCESS`; and a non-detached child is killed with
 * the launcher (libuv's kill-on-close job). `Start-Process -WindowStyle Hidden` gives the server a
 * console of its own that is hidden, which its helpers inherit, and it survives the launcher.
 * @param {string} file - the executable (on Windows, resolved through PATH by PowerShell).
 * @param {string[]} args - its arguments.
 * @param {{env?: Record<string,string>, cwd?: string}} [opts] - extra environment and working directory.
 * @returns {{pid?: number, error?: string}} the server's PID, or why it did not start.
 */
export function startBackground(file, args, opts = {}) {
  const env = { ...process.env, ...opts.env }
  const cwd = opts.cwd ?? REPO
  if (!WIN) {
    try {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', env, cwd })
      child.on('error', () => { /* callers probe readiness and report it */ })
      child.unref()
      return { pid: child.pid }
    } catch (e) { return { error: String(e.message ?? e) } }
  }
  // Start-Process inherits this PowerShell's environment, which is `env`.
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', hiddenStartCommand(file, args)], {
    env, cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  const pid = Number.parseInt(String(r.stdout ?? '').trim(), 10)
  return Number.isInteger(pid) && pid > 0 ? { pid } : { error: String(r.stderr || r.error?.message || 'Start-Process failed').trim() }
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
