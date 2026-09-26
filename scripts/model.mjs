#!/usr/bin/env node
/**
 * Model lifecycle for VerNess — the three things a local model needs, on any OS:
 *
 *   up      install the engine if missing, start it, fetch the model (from Hugging Face), warm it
 *   stats   telemetry: what is loaded, how much memory it holds, latency, who owns the process
 *   down    unload the model, stop the engine if we started it, free the memory, clean run state
 *
 * The engine is Ollama, which ships native builds for Windows, macOS and Linux and can pull any GGUF
 * straight from Hugging Face (`hf.co/<repo>:<quant>`) — so one code path covers all three platforms
 * and the weights come from Hugging Face rather than a vendor-specific registry.
 *
 * Run state lives in `.verness/run/model.json` so `down` can tell a server WE started from one that
 * was already running (and must not be killed).
 * @module scripts/model
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WIN = process.platform === 'win32'
const RUN_DIR = join(REPO, '.verness', 'run')
const RUN_FILE = join(RUN_DIR, 'model.json')

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
 * @returns {Promise<unknown|undefined>} the parsed body, or undefined when unreachable.
 */
async function getJson(url, ms = 3000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
    return r.ok ? await r.json() : undefined
  } catch { return undefined }
}

/** @param {string} baseURL - route base URL. @returns {Promise<string|undefined>} the engine version. */
async function engineVersion(baseURL) {
  const v = await getJson(`${apiRoot(baseURL)}/api/version`)
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
 * Bring the model up: engine present, server running, weights fetched, weights warm.
 * @param {object} cfg - the VerNess configuration.
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
    const child = spawn(WIN ? 'ollama.exe' : 'ollama', ['serve'], { detached: true, stdio: 'ignore' })
    child.on('error', () => { /* the readiness probe below reports this */ })
    child.unref()
    pid = child.pid
    startedByUs = true
    for (let i = 0; i < 24 && (await engineVersion(base)) === undefined; i++) await new Promise(r => setTimeout(r, 500))
  }
  const ver = await engineVersion(base)
  if (ver === undefined) { fail(`no engine server answering on ${apiRoot(base)}`); return false }
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
          options: { num_predict: 1 },
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

/**
 * Print model telemetry: loaded models with their memory, catalogue, latency, and ownership.
 * @param {object} cfg - the VerNess configuration.
 * @returns {Promise<boolean>} whether the engine answered at all.
 */
export async function modelStats(cfg) {
  const base = cfg.model.baseURL
  const ref = cfg.model.source ?? cfg.model.id
  const ver = await engineVersion(base)
  if (ver === undefined) { fail(`no engine server on ${apiRoot(base)}`); info('start it with: ./turn_on.sh up'); return false }

  console.log(paint(C.cyan, 'engine'))
  info(`ollama api ${ver} on ${apiRoot(base)}`)
  const run = readRunState()
  if (run === undefined) info('run state: none recorded — this server was not brought up by VerNess')
  else if (run.startedByUs === true) info(`run state: started by VerNess at ${run.at}, pid ${run.pid}`)
  else info(`run state: adopted at ${run.at} — the server was already running, so \`down\` will not stop it`)

  const ps = await getJson(`${apiRoot(base)}/api/ps`)
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

  const tags = await getJson(`${apiRoot(base)}/api/tags`)
  const all = tags?.models ?? []
  console.log(paint(C.cyan, `catalogue (${all.length})`))
  for (const x of all.slice(0, 12)) info(`${x.name}  ${human(x.size)}${x.name.startsWith('hf.co/') ? '  (hugging face)' : ''}`)
  if (all.length > 12) info(`... and ${all.length - 12} more`)

  console.log(paint(C.cyan, 'latency probe'))
  const t0 = Date.now()
  const probe = await (async () => {
    try {
      const r = await fetch(`${apiRoot(base)}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: ref, prompt: 'ping', stream: false, options: { num_predict: 8 } }),
        signal: AbortSignal.timeout(120000),
      })
      return r.ok ? await r.json() : undefined
    } catch { return undefined }
  })()
  if (probe === undefined) { warn(`${ref} did not answer a probe request`); return true }
  const ms = Date.now() - t0
  const tok = Number(probe.eval_count ?? 0)
  const evalNs = Number(probe.eval_duration ?? 0)
  info(`round trip ${ms} ms for ${tok} token(s)`)
  if (evalNs > 0 && tok > 0) info(`generation ${(tok / (evalNs / 1e9)).toFixed(1)} tok/s, prompt eval ${((Number(probe.prompt_eval_duration ?? 0)) / 1e6).toFixed(0)} ms, load ${((Number(probe.load_duration ?? 0)) / 1e6).toFixed(0)} ms`)
  return true
}

/**
 * Take the model down: unload weights (freeing RAM/VRAM), stop the server if VerNess started it, and
 * clear the run state. A server we did not start is left running unless `force` is set.
 * @param {object} cfg - the VerNess configuration.
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
    info('server left running: VerNess did not start it (use `down --force` to stop it anyway)')
  }

  if (existsSync(RUN_FILE)) { rmSync(RUN_FILE, { force: true }); ok('run state cleared') }
  return true
}

/**
 * Load the VerNess configuration through the launcher, so both entry points read the same file.
 * @returns {Promise<object>} the merged configuration.
 */
async function standaloneConfig() {
  const { loadConfigForCli } = await import('./verness.mjs')
  return loadConfigForCli()
}

// Standalone CLI: `node scripts/model.mjs up|stats|down [--force]`.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const cmd = process.argv[2]
  const force = process.argv.includes('--force')
  const cfg = await standaloneConfig()
  if (cmd === 'up') process.exit((await modelUp(cfg)) ? 0 : 1)
  else if (cmd === 'stats') process.exit((await modelStats(cfg)) ? 0 : 1)
  else if (cmd === 'down') process.exit((await modelDown(cfg, { force })) ? 0 : 1)
  else {
    console.log('usage: node scripts/model.mjs up | stats | down [--force]')
    process.exit(cmd === undefined ? 0 : 1)
  }
}
