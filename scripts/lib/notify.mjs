/**
 * Finish notices (T-445): when long work ends (a REPL task, `/loop-task`, `/team run`), ring the
 * terminal bell, retitle the window, and optionally raise a native desktop notification, so the
 * user can leave FiNess running. The decision and the text are pure; the desktop spawn is injected.
 * @module scripts/lib/notify
 */

import { spawn } from 'node:child_process'

const BEL = '\x07'
// Title and body travel in env vars, never spliced into the script, so no quoting can break out.
const PS_TOAST = [
  '$null=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]',
  '$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(1)',
  '$t=$x.GetElementsByTagName("text")',
  '$null=$t.Item(0).AppendChild($x.CreateTextNode($env:FINESS_N_TITLE))',
  '$null=$t.Item(1).AppendChild($x.CreateTextNode($env:FINESS_N_BODY))',
  '$id="{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"',
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
].join(';')

/**
 * Whether a finished piece of work earns a notice.
 * @param {{elapsedMs: number, cfg?: object, isTTY?: boolean, env?: Record<string,string|undefined>}} p - run facts.
 * @returns {boolean} true on a TTY, outside CI, past `notify.afterSeconds` (default 30; 0 = always).
 */
export function shouldNotify({ elapsedMs, cfg = {}, isTTY = false, env = {} }) {
  if (!isTTY || (env.CI !== undefined && env.CI !== '' && env.CI !== '0' && env.CI !== 'false')) return false
  const after = Number(cfg.notify?.afterSeconds ?? 30)
  return Number.isFinite(elapsedMs) && elapsedMs >= (Number.isFinite(after) ? after : 30) * 1000
}

/**
 * The one-line text of a notice.
 * @param {{what: string, ok: boolean, elapsedMs?: number}} p - what ran and how it ended.
 * @returns {string} `done: <what> (12s)` or `failed: ...`; the label is cut to 50 chars.
 */
export function notifyText({ what, ok, elapsedMs }) {
  const one = String(what ?? '').replace(/\s+/g, ' ').trim()
  const short = one.length > 50 ? `${one.slice(0, 49)}…` : one
  let dur = ''
  if (elapsedMs !== undefined) {
    const s = Math.round(elapsedMs / 1000)
    dur = ` (${s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`})`
  }
  return `${ok ? 'done' : 'failed'}: ${short || 'task'}${dur}`
}

/**
 * The native-notification command for a platform.
 * @param {string} platform - `process.platform`.
 * @param {string} title - notice title.
 * @param {string} body - notice body.
 * @returns {{cmd: string, args: string[], env?: Record<string,string>}} spawn spec (args array, no shell).
 */
export function desktopCommand(platform, title, body) {
  if (platform === 'win32') {
    return { cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', PS_TOAST], env: { FINESS_N_TITLE: title, FINESS_N_BODY: body } }
  }
  if (platform === 'darwin') {
    return { cmd: 'osascript', args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body] }
  }
  return { cmd: 'notify-send', args: [title, body] }
}

/** Detached, silent spawn; a missing binary is swallowed. */
function defaultSpawn(cmd, args, env) {
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, env: { ...process.env, ...env } })
  child.on('error', () => {})
  child.unref()
}

/**
 * Emit the notice for finished work, if it earns one.
 * @param {{what: string, ok: boolean, elapsedMs: number}} run - what ran.
 * @param {object} cfg - configuration (`notify` section).
 * @param {{write?: (s: string) => void, spawnFn?: Function, isTTY?: boolean, env?: object, platform?: string}} [io] - injectable I/O.
 * @returns {boolean} whether a notice was sent.
 */
export function notifyDone(run, cfg, io = {}) {
  const isTTY = io.isTTY ?? process.stdout.isTTY === true
  const env = io.env ?? process.env
  if (!shouldNotify({ elapsedMs: run.elapsedMs, cfg, isTTY, env })) return false
  const text = notifyText(run)
  try { (io.write ?? (s => process.stdout.write(s)))(`${BEL}\x1b]0;FiNess ${text}${BEL}`) } catch { /* ignore */ }
  if (cfg?.notify?.desktop === true) {
    try {
      const spec = desktopCommand(io.platform ?? process.platform, 'FiNess', text)
      ;(io.spawnFn ?? defaultSpawn)(spec.cmd, spec.args, spec.env)
    } catch { /* silent */ }
  }
  return true
}

/**
 * Run `fn`, then notify. The result passes through; an exception notifies as failed and rethrows.
 * @template T
 * @param {object} cfg - configuration.
 * @param {string} what - short label.
 * @param {() => Promise<T>|T} fn - the work.
 * @param {(r: T) => boolean} [isOk] - success test on the result (default: always true).
 * @param {object} [io] - passed to `notifyDone`.
 * @returns {Promise<T>} fn's result.
 */
export async function withNotify(cfg, what, fn, isOk = () => true, io = {}) {
  const t0 = Date.now()
  let r
  try { r = await fn() } catch (e) { notifyDone({ what, ok: false, elapsedMs: Date.now() - t0 }, cfg, io); throw e }
  notifyDone({ what, ok: isOk(r), elapsedMs: Date.now() - t0 }, cfg, io)
  return r
}
