/**
 * Command guard (T-473): an irreversible shell command never runs on the model's say-so. On
 * `tools/pre-execute` for the tools that run command text (`bash`, `pwsh`, `terminal_send`; `run_code`
 * reaches them as nested calls, which pass the same gate), a line `classifyCommand` flags is shown to
 * the user in full with its reasons and must be confirmed TWICE before it runs.
 *
 * Channels, in order: the substrate's approval service (two sequential asks; the web UI's approval
 * panel answers them), then, when no answerer exists (`unavailable`, the headless run) or the session
 * policy is `never`, the controlling terminal (`\\.\CONIN$`/`CONOUT$` on Windows, `/dev/tty` on
 * POSIX, read synchronously): "type yes", then "type DELETE (or the command's first word)". The web
 * surface never falls back to a terminal. No channel = deny. Never auto-approves.
 *
 * Config (the plugin row): `irreversible: "confirm-twice"` (default; any other value but `"deny"`
 * means this too) or `"deny"` (refuse without asking); `surface` (written by the launcher).
 * Separate from `@finess/tool-policy` on purpose: that plugin is per persona, mounts nothing when the
 * persona is unrestricted, and every persona switch rewrites its config. The guard holds for all.
 * Plain ESM, `node:` built-ins only: the profile installs a copy of this package.
 * @module @finess/guard
 */

import { closeSync, openSync, readSync, writeSync } from 'node:fs'

import { classifyCommand } from './classify.js'

export { classifyCommand } from './classify.js'

export const name = 'finess-guard'

/** The plugin row id in `finess.config.json`. */
export const GUARD_ID = 'finess-guard'

/** Allowed values of `irreversible`. */
export const MODES = ['confirm-twice', 'deny']

/** The reason the model reads when the user did not confirm. */
export const DENIED = 'blocked: irreversible command not confirmed by the user'

/** Tools that run command text, and the argument that holds it. */
export const COMMAND_TOOLS = { bash: 'command', pwsh: 'command', terminal_send: 'text' }

/**
 * @param {unknown} config - the row config. @returns {'confirm-twice'|'deny'} the mode; anything but
 *   an explicit `"deny"` is the default, never something weaker.
 */
export const modeOf = config => (config !== null && typeof config === 'object' && /** @type {any} */ (config).irreversible === 'deny' ? 'deny' : 'confirm-twice')

/**
 * The guard's row in a launcher config.
 * @param {{settings?: {plugins?: object[]}}} cfg - the merged `finess.config.json`.
 * @returns {{id: string, enabled?: boolean, config?: object}|undefined} the row.
 */
export const rowOf = cfg => /** @type {any} */ (cfg?.settings?.plugins ?? []).find(p => p?.id === GUARD_ID)

/**
 * The command text of a tool call, when the tool runs one.
 * @param {{name?: string, arguments?: unknown}} exec - the execution. @returns {string|undefined} the text.
 */
export function commandOf(exec) {
  const key = COMMAND_TOOLS[String(exec?.name ?? '')]
  const args = /** @type {any} */ (exec?.arguments)
  if (key === undefined || args === null || typeof args !== 'object') return undefined
  return typeof args[key] === 'string' ? args[key] : undefined
}

/**
 * A command made safe to print: control characters, ANSI escapes and bidi overrides become visible
 * escapes, so a destructive line cannot be drawn as a harmless one. Never truncated.
 * @param {string} text - the raw command. @returns {string} the printable form.
 */
export const shown = text => String(text).replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, c => (c === '\n' ? '\\n' : c === '\t' ? '\\t' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`))

/** @param {string} command @returns {string} the command's first word (an accepted second answer). */
export const firstWord = command => String(command).trim().split(/\s+/)[0] ?? ''

/**
 * @typedef {object} TtyIO
 * @property {(s: string) => void} write - write to the terminal.
 * @property {() => string|null} readLine - one line, blocking; null at end of input or on error.
 * @property {() => void} close - release the device.
 */

/**
 * Open the controlling terminal, bypassing stdin/stdout (which may be pipes or a captured run).
 * `FINESS_GUARD_TTY=none` forces "no terminal", which can only make the guard deny.
 * @param {{platform?: string, env?: Record<string, string|undefined>}} [opts] - for tests.
 * @returns {TtyIO|null} the terminal, or null when there is none.
 */
export function openTty({ platform = process.platform, env = process.env } = {}) {
  if (env.FINESS_GUARD_TTY === 'none') return null
  const [inPath, outPath] = platform === 'win32' ? ['\\\\.\\CONIN$', '\\\\.\\CONOUT$'] : ['/dev/tty', '/dev/tty']
  let fin
  let fout
  try {
    fin = openSync(inPath, 'r')
    fout = openSync(outPath, 'w')
  } catch {
    for (const fd of [fin, fout]) if (fd !== undefined) try { closeSync(fd) } catch { /* already closed */ }
    return null
  }
  return {
    write: s => { writeSync(fout, s) },
    readLine: () => {
      const buf = Buffer.alloc(256)
      const bytes = []
      while (bytes.length < 4096) {
        let n
        try { n = readSync(fin, buf, 0, buf.length, null) } catch { return null }
        if (n === 0) return bytes.length > 0 ? Buffer.from(bytes).toString('utf8') : null
        const chunk = [...buf.subarray(0, n)]
        const nl = chunk.indexOf(10)
        bytes.push(...(nl < 0 ? chunk : chunk.slice(0, nl)))
        if (nl >= 0) break
      }
      return Buffer.from(bytes).toString('utf8').replace(/\r$/, '')
    },
    close: () => { for (const fd of [fin, fout]) try { closeSync(fd) } catch { /* already closed */ } },
  }
}

/**
 * Ask twice on a terminal: "yes", then "DELETE" (or the command's first word). Synchronous, so two
 * prompts in one process never interleave.
 * @param {TtyIO} io - the terminal. @param {string} command - the full command.
 * @param {string[]} reasons - why it is irreversible. @param {string} [origin] - who wants it ("the model wants", "you want").
 * @returns {boolean} whether both answers were given.
 */
export function confirmOnTty(io, command, reasons, origin = 'the model wants') {
  const word = firstWord(command)
  const lines = [
    '',
    `!! FiNess guard: ${origin} to run an IRREVERSIBLE command`,
    `   ${shown(command)}`,
    ...reasons.map(r => `   - ${shown(r)}`),
    '',
  ]
  try {
    io.write(lines.join('\n') + '\n')
    io.write('type yes to continue (anything else blocks it): ')
    const a = io.readLine()
    if (a === null || a.trim().toLowerCase() !== 'yes') { io.write('blocked - not confirmed\n'); return false }
    io.write(`type DELETE${word !== '' && word !== 'DELETE' ? ` (or ${shown(word)})` : ''} to confirm: `)
    const b = io.readLine()
    if (b === null || (b.trim() !== 'DELETE' && (word === '' || b.trim() !== word))) { io.write('blocked - not confirmed\n'); return false }
    io.write('confirmed twice - running it\n')
    return true
  } catch { return false }
}

/**
 * Ask twice through the substrate's approval service.
 * @param {any} approval - `ctx.get('approval')`, possibly undefined.
 * @param {any} exec - the tool execution (agent, name, callId, signal).
 * @param {string} command - the full command. @param {string[]} reasons - why.
 * @returns {Promise<'allowed'|'denied'|'unavailable'>} `unavailable` when nobody can answer, so the
 *   caller may try the terminal; a human "no" or a cancel is `denied`.
 */
export async function confirmViaApproval(approval, exec, command, reasons) {
  if (approval === null || typeof approval?.request !== 'function' || exec?.agent === undefined) return 'unavailable'
  // `never` rejects without asking anyone: that is not the user's answer, so use the terminal.
  try {
    const policy = approval.overrideOf?.(exec.agent.session) ?? approval.config?.policy ?? 'ask'
    if (policy === 'never') return 'unavailable'
  } catch { /* unreadable policy: just ask */ }
  const why = reasons.join('; ')
  const ask = text => approval.request({
    agent: exec.agent,
    toolName: String(exec.name),
    ...(exec.callId === undefined ? {} : { callId: exec.callId }),
    reason: text,
    displayReason: { en: text },
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  })
  let first
  try { first = await ask(`IRREVERSIBLE command (confirmation 1 of 2): ${shown(command)} - ${why}. Approve only if you mean it.`) } catch { return 'unavailable' }
  if (first === 'unavailable') return 'unavailable'
  if (first !== 'allowed-once') return 'denied'
  let second
  try { second = await ask(`Confirm AGAIN (2 of 2) - this cannot be undone: ${shown(command)}`) } catch { return 'denied' }
  return second === 'allowed-once' ? 'allowed' : 'denied'
}

/**
 * The `tools/pre-execute` listener.
 * @param {{mode?: string, surface?: string, getApproval?: () => any, openTty?: () => TtyIO|null}} [opts]
 *   mode and surface from the row config; the approval lookup and the terminal, injectable for tests.
 * @returns {(exec: any, next: () => Promise<any>) => Promise<any>} the listener.
 */
export function createGuard(opts = {}) {
  const mode = opts.mode === 'deny' ? 'deny' : 'confirm-twice'
  const terminal = opts.surface !== 'web'
  const getApproval = opts.getApproval ?? (() => undefined)
  const open = opts.openTty ?? (() => openTty())
  let chain = Promise.resolve()
  /** One confirmation at a time: parallel calls queue rather than interleave prompts. */
  const serial = fn => { const p = chain.then(fn, fn); chain = p.then(() => {}, () => {}); return p }
  const confirm = async (exec, command, reasons) => {
    let approval
    try { approval = getApproval() } catch { approval = undefined }
    const r = await confirmViaApproval(approval, exec, command, reasons)
    if (r !== 'unavailable') return r === 'allowed'
    if (!terminal || exec?.signal?.aborted === true) return false
    const io = open()
    if (io === null) return false
    try { return confirmOnTty(io, command, reasons) } finally { io.close() }
  }
  return async (exec, next) => {
    const command = commandOf(exec)
    if (command === undefined) return next()
    const verdict = classifyCommand(command)
    if (!verdict.irreversible) return next()
    // Other gates first: a call they deny never prompts; their allow/ask is kept after confirming.
    const d = await next()
    if (d?.kind !== 'allow' && d?.kind !== 'ask') return d
    const why = verdict.reasons.join('; ')
    if (mode === 'deny') return { kind: 'deny', reason: `blocked: irreversible command refused (guard.irreversible is "deny"): ${why}. Do not retry it; tell the user what you wanted to run.` }
    const ok = await serial(() => confirm(exec, command, verdict.reasons))
    return ok ? d : { kind: 'deny', reason: `${DENIED} (${why}). Do not retry it; tell the user what you wanted to run and why.` }
  }
}

/**
 * The REPL's own `!cmd`/`!!cmd`: the same classifier and the same two confirmations.
 * @param {string} line - the command as typed.
 * @param {{mode?: string, io?: TtyIO|null}} opts - the mode, and the terminal (null when the REPL is
 *   piped: then an irreversible line is refused).
 * @returns {{run: boolean, reasons: string[], message?: string}} whether to run it.
 */
export function guardShellLine(line, { mode, io }) {
  const { irreversible, reasons } = classifyCommand(line)
  if (!irreversible) return { run: true, reasons }
  if (mode === 'deny') return { run: false, reasons, message: 'refused: irreversible command and guard.irreversible is "deny"' }
  if (io === null || io === undefined) return { run: false, reasons, message: 'refused: irreversible command and no terminal to confirm it on' }
  return confirmOnTty(io, line, reasons, 'you want') ? { run: true, reasons } : { run: false, reasons, message: DENIED }
}

/**
 * Mount the guard on `tools/pre-execute`.
 * @param {{on: Function, get?: Function}} ctx - registrant context.
 * @param {unknown} config - the row config (`irreversible`, `surface`).
 * @param {{getApproval?: () => any, openTty?: () => TtyIO|null}} [deps] - test seams.
 */
export function apply(ctx, config, deps = {}) {
  const c = /** @type {any} */ (config ?? {})
  ctx.on('tools/pre-execute', createGuard({
    mode: modeOf(c),
    surface: typeof c.surface === 'string' ? c.surface : undefined,
    getApproval: () => ctx.get?.('approval'),
    ...deps,
  }))
}
