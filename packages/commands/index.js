/**
 * Web commands bridge (ADR-0011). Registers the launcher's quick-tools (`/cost`, `/usage`,
 * `/persona`, persona commands, ...) as slash commands of the web UI's message bar. It implements no
 * command itself: each handler runs `node scripts/finess.mjs /<name> <args>` in the checkout, so a
 * command keeps its one implementation and the launcher-built context it expects.
 *
 * Plain ESM with only `node:` imports on purpose: no build step, no substrate package to link, and
 * the tests run without dsh. The web profile only (`surfaces: ["web"]` in `finess.config.json`).
 * @module @finess/commands
 */

import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'

export const name = 'finess-commands'
export const inject = ['commands']

/** Names the substrate owns on the web and a host registration cannot detect (ADR-0011, spike b). */
export const RESERVED = new Set([
  // Client contributions: a host command of the same name makes the web `/` menu throw.
  'model', 'file',
  // Substrate host commands, some registered per agent (a global one of ours would be shadowed).
  'compact', 'export', 'feedback', 'goal', 'permission', 'plan',
])

/** Commands that change state the running web server read at boot. */
export const RESTART_HINT = new Set(['persona', 'api', 'models', 'access'])

/** The line added to a state-changing command's reply. */
export const RESTART_LINE = 'restart the web UI to apply (./turn_on.sh off, then web)'

/** The registry's own name rule (`dsh-commands`); anything else would throw at register. */
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/

/** Environment for every launcher child: no colour codes, no pet banner. */
const childEnv = () => ({ ...process.env, NO_COLOR: '1', FINESS_NO_PET: '1' })

/**
 * Remove ANSI escape sequences (colour, cursor movement) from launcher output.
 * @param {string} s - raw output.
 * @returns {string} the plain text.
 */
export const stripAnsi = s => s.replace(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g, '')

/**
 * Split command input into words on whitespace, the rule the REPL uses. Quotes do not group words:
 * the launcher joins its arguments and splits them again, so grouping could not survive anyway.
 * @param {string} rawInput - the text after the command name.
 * @returns {string[]} the words.
 */
export const words = rawInput => rawInput.trim().split(/\s+/).filter(w => w !== '')

/**
 * The input hint for a usage line: what follows the command name (`/cost [--all]` -> `[--all]`).
 * @param {string} usage - the usage line.
 * @returns {string} the hint, empty when the command takes no input.
 */
export const hintOf = usage => usage.trim().replace(/^\/?\S+\s*/, '').trim()

/**
 * Run `finess.mjs --list-commands` once, synchronously (5 s cap).
 * @param {string} repo - absolute path of the FiNess checkout.
 * @param {{run?: typeof spawnSync}} [opts] - injectable spawner, for tests.
 * @returns {{list: object[]} | {error: string}} the command list, or why it could not be read.
 */
export function listCommands(repo, { run = spawnSync } = {}) {
  const r = run(process.execPath, [join(repo, 'scripts', 'finess.mjs'), '--list-commands'], {
    cwd: repo, encoding: 'utf8', timeout: 5000, windowsHide: true, env: childEnv(),
  })
  if (r.error !== undefined) return { error: r.error.message }
  if (r.status !== 0) return { error: `exit ${r.status}: ${stripAnsi(`${r.stderr ?? ''}`).trim().split('\n')[0]}` }
  try {
    const list = JSON.parse(`${r.stdout}`.replace(/^﻿/, ''))
    if (!Array.isArray(list)) return { error: 'the command list is not a JSON array' }
    return { list }
  } catch (e) { return { error: `the command list is not JSON: ${e.message}` } }
}

/**
 * Run one launcher command and map the outcome to a command result: exit 0 is `success`, anything
 * else `error`; stdout and stderr in the order they arrived, ANSI stripped, blank edges removed
 * (indentation kept). The UI's abort
 * signal kills the child; there is no fixed timeout (`/team` and `/loop-task` are long by design).
 * @param {object} opts - options.
 * @param {string} opts.repo - absolute path of the FiNess checkout.
 * @param {string} opts.command - the canonical command name (an alias is resolved by the caller).
 * @param {string} opts.rawInput - the text after the command name.
 * @param {AbortSignal} [opts.signal] - cancellation owned by the UI request.
 * @param {typeof spawn} [opts.spawnImpl] - injectable spawner, for tests.
 * @param {string} [opts.script] - the launcher entry; defaults to `<repo>/scripts/finess.mjs`.
 * @returns {Promise<{kind: 'success', text?: string} | {kind: 'error', text: string}>} the result.
 */
export function runCommand({ repo, command, rawInput, signal, spawnImpl = spawn, script }) {
  if (signal?.aborted === true) return Promise.resolve({ kind: 'error', text: `/${command} cancelled` })
  const args = words(rawInput)
  return new Promise(resolve => {
    const child = spawnImpl(process.execPath, [script ?? join(repo, 'scripts', 'finess.mjs'), `/${command}`, ...args], {
      cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv(),
    })
    let out = ''
    let aborted = false
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', d => { out += d })
    child.stderr?.on('data', d => { out += d })
    const onAbort = () => { aborted = true; child.kill() }
    signal?.addEventListener('abort', onAbort, { once: true })
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    child.on('error', e => finish({ kind: 'error', text: `/${command} could not start: ${e.message}` }))
    child.on('close', code => {
      // Leading blank lines and trailing whitespace go; indentation stays, so tables line up as in the REPL.
      const text = stripAnsi(out).replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd()
      if (aborted) return finish({ kind: 'error', text: `/${command} cancelled` })
      if (code === 0) {
        const hint = RESTART_HINT.has(command) && args.length > 0 ? RESTART_LINE : ''
        const body = [text, hint].filter(s => s !== '').join('\n\n')
        return finish(body === '' ? { kind: 'success' } : { kind: 'success', text: body })
      }
      finish({ kind: 'error', text: text === '' ? `exit ${code}` : text })
    })
  })
}

/**
 * Register every web-enabled command (and alias) with the web UI's command registry. A reserved
 * name, or one the substrate already registered ("already registered"), is skipped and logged.
 * @param {{register: (definition: object) => () => void}} commands - `ctx.commands`.
 * @param {object[]} list - the `--list-commands` entries.
 * @param {object} opts - options.
 * @param {string} opts.repo - absolute path of the FiNess checkout.
 * @param {(message: string) => void} opts.log - one-line logger.
 * @param {typeof runCommand} [opts.run] - the handler body, injectable for tests.
 * @returns {(() => void)[]} the disposers of every registration made.
 */
export function registerCommands(commands, list, { repo, log, run = runCommand }) {
  const disposers = []
  for (const cmd of list) {
    if (cmd?.web === false || typeof cmd?.name !== 'string') continue
    for (const n of [cmd.name, ...(cmd.aliases ?? [])]) {
      if (!COMMAND_NAME.test(n)) continue
      if (RESERVED.has(n)) { log(`/${n} left to the substrate`); continue }
      const summary = typeof cmd.summary === 'string' && cmd.summary.trim() !== '' ? cmd.summary : `FiNess quick-tool /${cmd.name}`
      const hint = hintOf(cmd.usage ?? '')
      try {
        disposers.push(commands.register({
          definitionId: `@finess/commands:${n}`,
          name: n,
          description: n === cmd.name ? summary : `${summary} (alias of /${cmd.name})`,
          ...(hint === '' ? {} : { input: { hint } }),
          recordInput: true,
          handler: invocation => run({ repo, command: cmd.name, rawInput: invocation.rawInput, signal: invocation.signal }),
        }))
      } catch (e) {
        log(/already registered/.test(e.message) ? `/${n} left to the substrate` : `/${n} not registered: ${e.message}`)
      }
    }
  }
  return disposers
}

/**
 * Mount the bridge: read the command list once, then register after the application's startup is
 * committed (`appReady`), so every substrate command plugin has registered first. Without a list
 * nothing is registered and the web UI still boots.
 * @param {import('@deepseek-ai/cordis').Context} ctx - context carrying `ctx.commands`.
 * @param {{repo?: string}} config - `repo`: the checkout path, written by `sync` (`repoConfig`).
 * @param {{log?: (message: string) => void, list?: typeof listCommands, run?: typeof runCommand}} [deps] -
 *   injectable pieces, for tests.
 */
export function apply(ctx, config, deps = {}) {
  const log = deps.log ?? (m => console.error(`finess-commands: ${m}`))
  const repo = config?.repo
  if (typeof repo !== 'string' || repo === '') { log('no config.repo; run ./turn_on.sh sync'); return }
  const got = (deps.list ?? listCommands)(repo)
  if ('error' in got) { log(`no commands registered: ${got.error}`); return }
  const ready = ctx.get('appReady')
  ctx.effect(() => {
    let disposers = []
    const registerAll = () => { disposers = registerCommands(ctx.commands, got.list, { repo, log, run: deps.run }) }
    const cancel = ready === undefined ? (registerAll(), () => {}) : ready.onReady(registerAll)
    return () => {
      cancel()
      for (const dispose of disposers) { try { dispose() } catch { /* already disposed with the fiber */ } }
      disposers = []
    }
  })
}
