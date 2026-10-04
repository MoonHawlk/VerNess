#!/usr/bin/env node
/**
 * Model lifecycle for FiNess — the three things a local model needs, on any OS:
 *
 *   up      install the engine if missing, start it, fetch the model (from Hugging Face), warm it
 *   stats   telemetry: what is loaded, how much memory it holds, latency, who owns the process
 *           (--watch repeats it; every probe is appended to .finess/probes.jsonl)
 *   down    unload the model, stop the engine if we started it, free the memory, clean run state
 *
 * The engine is Ollama, which ships native builds for Windows, macOS and Linux and can pull any GGUF
 * straight from Hugging Face (`hf.co/<repo>:<quant>`) — so one code path covers all three platforms
 * and the weights come from Hugging Face rather than a vendor-specific registry.
 *
 * Run state lives in `.finess/run/model.json` so `down` can tell a server WE started from one that
 * was already running (and must not be killed).
 * @module scripts/model
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { gatherFacts, hintForLog, lastErrorLine, runChecks } from './lib/engine-checks.mjs'
import { startBackground } from './lib/util.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WIN = process.platform === 'win32'
const RUN_DIR = join(REPO, '.finess', 'run')
const RUN_FILE = join(RUN_DIR, 'model.json')
/** The engine server's stderr from the start we made (T-452); read back when it never answers. */
export const ENGINE_LOG = join(RUN_DIR, 'engine.log')

const C = {
  dim: '[2m', red: '[31m', green: '[32m',
  yellow: '[33m', cyan: '[36m', off: '[0m',
}
const paint = (c, s) => (process.stdout.isTTY ? c + s + C.off : s)
const step = s => console.log(paint(C.cyan, '==> ') + s)
const ok = s => console.log(paint(C.green, '  ok ') + s)
const warn = s => console.log(paint(C.yellow, '  !! ') + s)
const info = s => console.log(paint(C.dim, '     ' + s))
const fail = s => console.error(paint(C.red, 'error: ') + s)

/**
 * Run a command. Windows shims (`.cmd`) cannot be spawned without a shell, so arguments are quoted
 * here rather than concatenated by the shell.
 * @param {string} cmd - executable name.
 * @param {string[]} args - arguments.
 * @param {{capture?: boolean, allowFail?: boolean}} [opts] - options.
 * @returns {{code: number, out: string}} exit status and captured output.
 */
function sh(cmd, args, opts = {}) {
  const base = { cwd: REPO, stdio: opts.capture === true ? 'pipe' : 'inherit', encoding: 'utf8' }
  const q = a => (a === '' ? '""' : `"${String(a).replaceAll('"', '\\"').replaceAll('%', '%^')}"`)
  const r = WIN
    ? spawnSync([cmd, ...args.map(q)].join(' '), { ...base, shell: true })
    : spawnSync(cmd, args, base)
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

/** @param {string} baseURL - an OpenAI-style base URL. @returns {string} the engine's API root. */
const apiRoot = baseURL => String(baseURL).replace(/\/v1\/?$/, '')

/**
 * GET a JSON endpoint of the engine.
 * @param {string} url - absolute URL.
 * @param {number} [ms] - timeout in milliseconds.
 * @param {typeof fetch} [fetchFn] - injectable for tests.
 * @returns {Promise<unknown|undefined>} the parsed body, or undefined when unreachable.
 */
async function getJson(url, ms = 3000, fetchFn = fetch) {
  try {
    const r = await fetchFn(url, { signal: AbortSignal.timeout(ms) })
    return r.ok ? await r.json() : undefined
  } catch { return undefined }
}

/** @param {string} baseURL - route base URL. @returns {Promise<string|undefined>} the engine version. */
async function engineVersion(baseURL, fetchFn = fetch) {
  const v = await getJson(`${apiRoot(baseURL)}/api/version`, 3000, fetchFn)
  return v?.version
}

/** @param {number} bytes - a byte count. @returns {string} a human-readable size. */
function human(bytes) {
  const n = Number(bytes ?? 0)
  if (n <= 0) return '0'
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`
}

/** @returns {{pid: number, startedByUs: boolean, model: string, baseURL: string}|undefined} saved run state. */
function readRunState() {
  try { return JSON.parse(readFileSync(RUN_FILE, 'utf8')) } catch { return undefined }
}

/** @param {object} state - state to persist for a later `down`. */
function writeRunState(state) {
  mkdirSync(RUN_DIR, { recursive: true })
  writeFileSync(RUN_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/**
 * Install the engine with the platform's own package manager. Best-effort: on failure the manual
 * one-liner is printed rather than guessed at again.
 * @returns {boolean} whether the engine is callable afterwards.
 */
function installEngine() {
  step('installing the model engine (ollama)')
  if (WIN) {
    sh('winget', ['install', '--id', 'Ollama.Ollama', '-e', '--accept-package-agreements', '--accept-source-agreements'], { allowFail: true })
  } else if (process.platform === 'darwin') {
    if (sh('brew', ['--version'], { capture: true, allowFail: true }).code === 0) sh('brew', ['install', 'ollama'], { allowFail: true })
    else warn('Homebrew not found')
  } else {
    sh('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], { allowFail: true })
  }
  if (sh('ollama', ['--version'], { capture: true, allowFail: true }).code === 0) return true
  fail('could not install the engine automatically')
  info('install it manually from https://ollama.com/download, then re-run `up`')
  return false
}

/**
 * Say why the engine server did not come up: the last error of its own log (when we started it)
 * with the matching fix, then whatever the environment checks find.
 * @param {string} base - the route base URL.
 * @param {string} ref - the model that was to run.
 * @param {boolean} startedByUs - whether this call started the server (its log is then fresh).
 */
async function explainStartFailure(base, ref, startedByUs) {
  let logged
  if (startedByUs) {
    try { logged = lastErrorLine(readFileSync(ENGINE_LOG, 'utf8')) } catch { /* no log */ }
  }
  if (logged !== undefined) {
    info(`the server said: ${logged}`)
    const hint = hintForLog(logged, process.env)
    if (hint !== undefined) info(`fix: ${hint}`)
    info(`full log: ${ENGINE_LOG}`)
  }
  const binary = sh('ollama', ['--version'], { capture: true, allowFail: true })
  const facts = await gatherFacts({ baseURL: base, model: ref, engineAnswering: false, binary: binary.code === 0 ? binary.out : undefined })
  for (const f of runChecks(facts)) { warn(f.message); info(`fix: ${f.fix}`) }
}

/**
 * Environment for an engine FiNess starts: the route's context window as the default for every
 * request (the OpenAI-compatible endpoint the substrate uses cannot send `num_ctx`), flash attention
 * (needed for a quantized KV cache) unless `model.flashAttention` is false, and `model.kvCache`
 * (`f16`, `q8_0`, `q4_0`) when set. An engine started elsewhere keeps its own settings.
 * @param {{contextWindow?: number, flashAttention?: boolean, kvCache?: string}} m - the model config.
 * @returns {Record<string, string>} variables for `ollama serve`.
 */
export function engineEnv(m) {
  const env = {}
  if (Number(m.contextWindow) > 0) env.OLLAMA_CONTEXT_LENGTH = String(Math.floor(Number(m.contextWindow)))
  if (m.flashAttention !== false) env.OLLAMA_FLASH_ATTENTION = '1'
  if (typeof m.kvCache === 'string' && /^(f16|q8_0|q4_0)$/.test(m.kvCache)) env.OLLAMA_KV_CACHE_TYPE = m.kvCache
  return env
}

/**
 * Bring the model up: engine present, server running, weights fetched, weights warm.
 * @param {object} cfg - the FiNess configuration.
 * @param {string} [model] - the model to bring up; defaults to the configured one.
 * @returns {Promise<boolean>} whether the model is ready to serve requests.
 */
export async function modelUp(cfg, model) {
  const m = cfg.model
  const base = m.baseURL
  // The model the run will actually use (a /model or /models choice), else the configured one.
  const ref = model ?? m.source ?? m.id

  if (sh('ollama', ['--version'], { capture: true, allowFail: true }).code !== 0) {
    if (m.autoInstallEngine === false) { fail('the engine is not installed (model.autoInstallEngine is false)'); return false }
    if (!installEngine()) return false
  }
  ok(`engine ollama ${sh('ollama', ['--version'], { capture: true, allowFail: true }).out.split(' ').pop()}`)

  let startedByUs = false
  let pid = readRunState()?.pid
  if ((await engineVersion(base)) === undefined) {
    step(`starting the engine server on ${apiRoot(base)}`)
    // Hidden console on Windows: a detached start makes each Ollama helper flash a terminal window.
    const started = startBackground(WIN ? 'ollama.exe' : 'ollama', ['serve'], { errFile: ENGINE_LOG, env: engineEnv(m) })
    if (started.error !== undefined) info(started.error.split(/\r?\n/)[0])
    pid = started.pid
    startedByUs = true
    for (let i = 0; i < 24 && (await engineVersion(base)) === undefined; i++) await new Promise(r => setTimeout(r, 500))
  }
  const ver = await engineVersion(base)
  if (ver === undefined) {
    fail(`no engine server answering on ${apiRoot(base)}`)
    await explainStartFailure(base, ref, startedByUs)
    return false
  }
  ok(`server up (api ${ver})${startedByUs ? ` pid ${pid}` : ' — was already running'}`)

  const tags = await getJson(`${apiRoot(base)}/api/tags`)
  const have = (tags?.models ?? []).some(x => x.name === ref || x.model === ref || x.name === `${ref}:latest`)
  if (!have) {
    step(`fetching ${ref}`)
    info(ref.startsWith('hf.co/') ? 'weights come straight from Hugging Face (GGUF)' : 'weights come from the ollama registry')
    if (sh('ollama', ['pull', ref]).code !== 0) { fail(`could not fetch ${ref}`); return false }
  }
  ok(`weights present: ${ref}`)

  step('warming the model (first load reads weights into RAM)')
  const t0 = Date.now()
  const warm = await (async () => {
    try {
      const r = await fetch(`${apiRoot(base)}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ref, prompt: 'ok', stream: false,
          keep_alive: `${m.keepAliveMinutes ?? 10}m`,
          // Load with the route's window, or the engine loads its own default and reloads later.
          options: { num_predict: 1, ...(m.contextWindow > 0 ? { num_ctx: m.contextWindow } : {}) },
        }),
        signal: AbortSignal.timeout(180000),
      })
      return r.ok ? await r.json() : undefined
    } catch { return undefined }
  })()
  if (warm === undefined) { fail('the model did not answer a warm-up request'); return false }
  ok(`warm in ${((Date.now() - t0) / 1000).toFixed(1)}s, resident for ${m.keepAliveMinutes ?? 10}m of idleness`)

  writeRunState({ pid, startedByUs, model: ref, baseURL: base, at: new Date().toISOString() })
  step('model is ready')
  info(`endpoint ${base}   model ${ref}`)
  info(`telemetry: ./turn_on.sh stats      shutdown: ./turn_on.sh down`)
  return true
}

/** Append-only probe history: one JSON object per line, for regression tracking over time. */
export const PROBE_LOG = join(REPO, '.finess', 'probes.jsonl')

/**
 * Time one generation against the engine.
 * @param {string} base - the route base URL.
 * @param {string} ref - the model to probe.
 * @param {typeof fetch} [fetchFn] - injectable for tests.
 * @param {AbortSignal} [signal] - aborts the request (watch shutdown).
 * @returns {Promise<object>} the probe record; `ok` is false when the model did not answer.
 */
export async function runProbe(base, ref, fetchFn = fetch, signal) {
  const t0 = Date.now()
  const at = new Date(t0).toISOString()
  try {
    const timeout = AbortSignal.timeout(120000)
    const r = await fetchFn(`${apiRoot(base)}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ref, prompt: 'ping', stream: false, options: { num_predict: 8 } }),
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
    })
    if (!r.ok) return { at, model: ref, ok: false, ms: Date.now() - t0 }
    const p = await r.json()
    const ms = Date.now() - t0
    const tokens = Number(p.eval_count ?? 0)
    const evalNs = Number(p.eval_duration ?? 0)
    return {
      at, model: ref, ok: true, ms, tokens,
      tokPerSec: evalNs > 0 && tokens > 0 ? Number((tokens / (evalNs / 1e9)).toFixed(1)) : undefined,
      promptEvalMs: Math.round(Number(p.prompt_eval_duration ?? 0) / 1e6),
      loadMs: Math.round(Number(p.load_duration ?? 0) / 1e6),
    }
  } catch { return { at, model: ref, ok: false, ms: Date.now() - t0 } }
}

/**
 * @param {object} rec - a probe record.
 * @param {string} [file] - the history file.
 */
export function appendProbe(rec, file = PROBE_LOG) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8')
  } catch { /* history is best-effort; telemetry must not fail on a read-only disk */ }
}

/**
 * @param {string} [file] - the history file.
 * @returns {object[]} recorded probes, oldest first; bad lines are skipped.
 */
export function readProbes(file = PROBE_LOG) {
  let text
  try { text = readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { out.push(JSON.parse(line)) } catch { /* partial line */ }
  }
  return out
}

/**
 * Compare a probe with the recent history of the same model.
 * @param {object[]} history - earlier probes, oldest first.
 * @param {object} rec - the new probe.
 * @param {{window?: number, drop?: number}} [opts] - how many earlier probes, and the tok/s fraction lost that counts.
 * @returns {string|undefined} a warning, or undefined when there is no regression (or too little history).
 */
export function probeRegression(history, rec, opts = {}) {
  const prior = history.filter(h => h.ok === true && h.model === rec.model && typeof h.tokPerSec === 'number').slice(-(opts.window ?? 10))
  if (rec.ok !== true || typeof rec.tokPerSec !== 'number' || prior.length < 3) return undefined
  const sorted = prior.map(h => h.tokPerSec).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  if (rec.tokPerSec >= median * (1 - (opts.drop ?? 0.3))) return undefined
  return `generation ${rec.tokPerSec} tok/s is below the recent median ${median} tok/s (last ${prior.length} probes)`
}

/**
 * @param {number} ms - a delay.
 * @param {AbortSignal} [signal] - resolves early when aborted.
 * @returns {Promise<void>} resolves after the delay or the abort.
 */
const sleep = (ms, signal) => new Promise(res => {
  if (signal?.aborted === true) return res()
  const t = setTimeout(res, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); res() }, { once: true })
})

/**
 * Print model telemetry: loaded models with their memory, catalogue, latency, and ownership. Every
 * probe is appended to the history file. With `watch`, repeat as one line per tick until aborted.
 * @param {object} cfg - the FiNess configuration.
 * @param {{watch?: boolean, intervalMs?: number, signal?: AbortSignal, fetch?: typeof fetch, probeLog?: string, maxTicks?: number}} [opts] - `fetch` and `probeLog` are test seams.
 * @returns {Promise<boolean>} whether the engine answered at all.
 */
export async function modelStats(cfg, opts = {}) {
  const base = cfg.model.baseURL
  const ref = cfg.model.source ?? cfg.model.id
  const f = opts.fetch ?? fetch
  const log = opts.probeLog ?? PROBE_LOG
  const ver = await engineVersion(base, f)
  if (ver === undefined) { fail(`no engine server on ${apiRoot(base)}`); info('start it with: ./turn_on.sh up'); return false }

  console.log(paint(C.cyan, 'engine'))
  info(`ollama api ${ver} on ${apiRoot(base)}`)
  const run = readRunState()
  if (run === undefined) info('run state: none recorded — this server was not brought up by FiNess')
  else if (run.startedByUs === true) info(`run state: started by FiNess at ${run.at}, pid ${run.pid}`)
  else info(`run state: adopted at ${run.at} — the server was already running, so \`down\` will not stop it`)

  const ps = await getJson(`${apiRoot(base)}/api/ps`, 3000, f)
  const loaded = ps?.models ?? []
  console.log(paint(C.cyan, 'loaded in memory'))
  if (loaded.length === 0) info('nothing loaded — the first request will pay the load cost')
  for (const x of loaded) {
    const vram = Number(x.size_vram ?? 0)
    const total = Number(x.size ?? 0)
    const where = vram === 0 ? 'cpu/ram' : vram >= total ? 'gpu' : `gpu ${human(vram)} + cpu ${human(total - vram)}`
    info(`${x.name}  ${human(total)}  ${where}  expires ${x.expires_at ?? 'unknown'}`)
    if (x.details !== undefined) info(`  ${x.details.parameter_size ?? '?'} params, ${x.details.quantization_level ?? '?'}, family ${x.details.family ?? '?'}`)
  }

  const tags = await getJson(`${apiRoot(base)}/api/tags`, 3000, f)
  const all = tags?.models ?? []
  console.log(paint(C.cyan, `catalogue (${all.length})`))
  for (const x of all.slice(0, 12)) info(`${x.name}  ${human(x.size)}${x.name.startsWith('hf.co/') ? '  (hugging face)' : ''}`)
  if (all.length > 12) info(`... and ${all.length - 12} more`)

  console.log(paint(C.cyan, 'latency probe'))
  /** @returns {Promise<object>} one probe, recorded, with a warning when it regressed against earlier runs. */
  const probeOnce = async () => {
    const history = readProbes(log)
    const rec = await runProbe(base, ref, f, opts.signal)
    if (opts.signal?.aborted !== true) appendProbe(rec, log)
    const slow = probeRegression(history, rec)
    if (slow !== undefined) warn(slow)
    return rec
  }
  const first = await probeOnce()
  if (!first.ok) {
    if (opts.signal?.aborted !== true) warn(`${ref} did not answer a probe request`)
  } else {
    info(`round trip ${first.ms} ms for ${first.tokens} token(s)`)
    if (first.tokPerSec !== undefined) info(`generation ${first.tokPerSec.toFixed(1)} tok/s, prompt eval ${first.promptEvalMs} ms, load ${first.loadMs} ms`)
  }
  if (opts.watch !== true) return true

  const every = opts.intervalMs ?? 5000
  info(`watching every ${every / 1000}s, history in ${log} — ctrl+c to stop`)
  for (let tick = 1; opts.signal?.aborted !== true && tick < (opts.maxTicks ?? Infinity);) {
    await sleep(every, opts.signal)
    if (opts.signal?.aborted === true) break
    tick++
    const now = (await getJson(`${apiRoot(base)}/api/ps`, 3000, f))?.models ?? []
    const rec = await probeOnce()
    if (opts.signal?.aborted === true) break
    const mem = now.length === 0 ? 'nothing loaded' : now.map(x => `${x.name} ${human(x.size)}`).join(', ')
    const speed = rec.ok ? `${rec.ms} ms${rec.tokPerSec === undefined ? '' : `, ${rec.tokPerSec.toFixed(1)} tok/s`}` : 'no answer'
    info(`${rec.at.slice(11, 19)}  ${speed}  |  ${mem}`)
  }
  info('stopped watching')
  return true
}

/**
 * Parse `stats` flags and wire ctrl+c to a clean stop of `--watch`.
 * @param {string[]} args - arguments after `stats`.
 * @returns {{watch: boolean, intervalMs: number, signal: AbortSignal}} options for {@link modelStats}.
 */
export function statsOpts(args) {
  const at = args.indexOf('--interval')
  const secs = at >= 0 ? Number(args[at + 1]) : 5
  const ctl = new AbortController()
  process.once('SIGINT', () => ctl.abort())
  return { watch: args.includes('--watch'), intervalMs: Math.max(1, Number.isFinite(secs) ? secs : 5) * 1000, signal: ctl.signal }
}

/**
 * Take the model down: unload weights (freeing RAM/VRAM), stop the server if FiNess started it, and
 * clear the run state. A server we did not start is left running unless `force` is set.
 * @param {object} cfg - the FiNess configuration.
 * @param {{force?: boolean}} [opts] - `force` stops the server even if someone else started it.
 * @returns {Promise<boolean>} whether the shutdown path completed.
 */
export async function modelDown(cfg, opts = {}) {
  const base = cfg.model.baseURL
  const run = readRunState()
  if ((await engineVersion(base)) === undefined) {
    ok('no engine server running')
    if (existsSync(RUN_FILE)) { rmSync(RUN_FILE, { force: true }); info('cleared stale run state') }
    return true
  }

  const before = await getJson(`${apiRoot(base)}/api/ps`)
  const loaded = before?.models ?? []
  let freed = 0
  for (const x of loaded) {
    // keep_alive: 0 tells the engine to evict the model now — this is what actually frees memory.
    step(`unloading ${x.name} (${human(x.size)})`)
    try {
      await fetch(`${apiRoot(base)}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: x.name, keep_alive: 0 }),
        signal: AbortSignal.timeout(30000),
      })
      freed += Number(x.size ?? 0)
    } catch { warn(`could not unload ${x.name}`) }
  }
  const after = await getJson(`${apiRoot(base)}/api/ps`)
  ok(`memory released: ${human(freed)} (${(after?.models ?? []).length} model(s) still resident)`)

  const stopOwn = run?.startedByUs === true && typeof run.pid === 'number'
  if (stopOwn || opts.force === true) {
    const pid = run?.pid
    step(opts.force === true && !stopOwn ? 'stopping the engine server (forced)' : `stopping the engine server (pid ${pid})`)
    if (WIN) {
      if (typeof pid === 'number') sh('taskkill', ['/PID', String(pid), '/T', '/F'], { capture: true, allowFail: true })
      if (opts.force === true) sh('taskkill', ['/IM', 'ollama.exe', '/F'], { capture: true, allowFail: true })
    } else if (typeof pid === 'number') {
      try { process.kill(pid, 'SIGTERM') } catch { warn(`pid ${pid} was already gone`) }
    } else {
      sh('pkill', ['-f', 'ollama serve'], { capture: true, allowFail: true })
    }
    for (let i = 0; i < 10 && (await engineVersion(base)) !== undefined; i++) await new Promise(r => setTimeout(r, 300))
    if ((await engineVersion(base)) === undefined) ok('server stopped')
    else warn('the server is still answering — it may be managed by the OS (service or menu-bar app)')
  } else {
    info('server left running: FiNess did not start it (use `down --force` to stop it anyway)')
  }

  if (existsSync(RUN_FILE)) { rmSync(RUN_FILE, { force: true }); ok('run state cleared') }
  return true
}

// Standalone CLI: `node scripts/model.mjs up|stats|down [--force]`. It hands off to the launcher in a
// child process: importing `finess.mjs` from here would be an import cycle (it imports this module),
// and with this file as the entry that cycle deadlocks on its top-level await.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const cmd = process.argv[2]
  if (!['up', 'stats', 'down'].includes(cmd ?? '')) {
    console.log('usage: node scripts/model.mjs up | stats [--watch] [--interval <s>] | down [--force]')
    process.exit(cmd === undefined ? 0 : 1)
  }
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'cli.mjs'), ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true })
  process.exit(r.status ?? 1)
}
