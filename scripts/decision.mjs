#!/usr/bin/env node
/**
 * Decision-engine lifecycle — the same `up` / `stats` / `down` contract the model engine has
 * (ADR-0007), applied to the decision sidecar (ADR-0009).
 *
 * The sidecar is a Python process speaking the SystemOne wire protocol (`POST /v1/systemone`), kept
 * out of our runtime on purpose: our process stays Node-only, and a broken sidecar degrades the
 * decision layer instead of breaking the harness.
 *
 * Security: `laya-serve` binds `0.0.0.0` with no authentication unless `LAYA_API_KEY` is set, so
 * `up` always binds loopback AND generates a key. A decision service reachable from the LAN is an
 * unauthenticated classifier anyone can drive.
 * @module scripts/decision
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ROUTING_QUESTIONS, askDecision, decisionConfig, decisionHealth, readAnswer } from './lib/decisions.mjs'
import { REPO, RUN_DIR, WIN, head, info, ok, paint, step, table, warn } from './lib/util.mjs'

const RUN_FILE = join(RUN_DIR, 'decision.json')
const KEY_FILE = join(RUN_DIR, 'laya.key')

/**
 * @param {object} dc - the resolved decisions config.
 * @returns {{py: string, serve: string}} paths to the venv interpreter and the server entry point.
 */
function venvPaths(dc) {
  const base = resolve(REPO, dc.venv ?? '.verness/py')
  return WIN
    ? { py: join(base, 'Scripts', 'python.exe'), serve: join(base, 'Scripts', 'laya-serve.exe'), pip: join(base, 'Scripts', 'pip.exe') }
    : { py: join(base, 'bin', 'python'), serve: join(base, 'bin', 'laya-serve'), pip: join(base, 'bin', 'pip') }
}

/** @returns {object|undefined} the recorded run state. */
const readRun = () => { try { return JSON.parse(readFileSync(RUN_FILE, 'utf8')) } catch { return undefined } }

/** @returns {string} the sidecar key, generating and storing one on first use. */
function ensureKey() {
  mkdirSync(RUN_DIR, { recursive: true })
  try { const k = readFileSync(KEY_FILE, 'utf8').trim(); if (k !== '') return k } catch { /* generate below */ }
  const key = randomBytes(24).toString('hex')
  writeFileSync(KEY_FILE, `${key}\n`, 'utf8')
  return key
}

/**
 * Install the sidecar into its own virtual environment. Python is a *development* prerequisite for
 * the decision layer only; the harness stays fully usable without it.
 * @param {object} dc - the resolved decisions config.
 * @returns {boolean} whether `laya-serve` is present afterwards.
 */
function install(dc) {
  const { py, serve, pip } = venvPaths(dc)
  if (existsSync(serve)) return true
  const base = resolve(REPO, dc.venv ?? '.verness/py')
  if (!existsSync(py)) {
    step(`creating the virtual environment at ${dc.venv ?? '.verness/py'}`)
    const r = spawnSync(WIN ? 'python' : 'python3', ['-m', 'venv', base], { stdio: 'inherit', shell: WIN })
    if (r.status !== 0) { warn('could not create the virtual environment (is Python 3.10+ installed?)'); return false }
  }
  step('installing laya[serve] - this pulls torch and transformers, so it is a large first download')
  const r = spawnSync(pip, ['install', 'laya[serve]'], { stdio: 'inherit' })
  if (r.status !== 0) { warn('pip install failed'); return false }
  return existsSync(serve)
}

/**
 * Bring the decision sidecar up: install if missing, start on loopback with a key, wait for health.
 * @param {object} cfg - the VerNess configuration.
 * @returns {Promise<boolean>} whether the service is ready.
 */
export async function decisionUp(cfg) {
  const dc = decisionConfig(cfg)
  const { serve } = venvPaths(dc)
  if (!existsSync(serve) && !install(dc)) return false
  ok('laya[serve] installed')

  if (await decisionHealth(dc)) {
    ok(`decision service already answering on ${dc.baseURL}`)
  } else {
    const key = ensureKey()
    const url = new URL(dc.baseURL)
    step(`starting the sidecar on ${url.hostname}:${url.port || 8000} (loopback, key required)`)
    mkdirSync(RUN_DIR, { recursive: true })
    const log = join(RUN_DIR, 'laya-serve.log')
    const child = spawn(serve, [], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, LAYA_HOST: url.hostname, LAYA_PORT: url.port || '8000', [dc.apiKeyEnv]: key },
    })
    child.on('error', () => { /* the readiness probe reports this */ })
    child.unref()
    writeFileSync(RUN_FILE, `${JSON.stringify({ pid: child.pid, startedByUs: true, baseURL: dc.baseURL, at: new Date().toISOString() }, null, 2)}\n`, 'utf8')
    info(`first start downloads the checkpoints; log: ${log}`)
    for (let i = 0; i < 120 && !(await decisionHealth(dc)); i++) await new Promise(r => setTimeout(r, 1000))
    if (!(await decisionHealth(dc))) { warn('the sidecar did not become healthy in time'); return false }
    ok(`sidecar up (pid ${child.pid})`)
  }

  process.env[dc.apiKeyEnv] ??= ensureKey()
  const probe = await askDecision(dc, 'List the files in this directory.', { level: ROUTING_QUESTIONS.level })
  if (!probe.ok) { warn(`health passed but a decision failed: ${probe.error ?? probe.status}`); return false }
  ok(`answering typed questions (${probe.ms} ms for one question)`)
  info('route a task with /decide <text>; shadow logging turns on with decisions.enabled in the config')
  return true
}

/**
 * Report what the decision service is doing and how fast.
 * @param {object} cfg - the VerNess configuration.
 * @returns {Promise<boolean>} whether the service answered.
 */
export async function decisionStats(cfg) {
  const dc = decisionConfig(cfg)
  process.env[dc.apiKeyEnv] ??= (() => { try { return readFileSync(KEY_FILE, 'utf8').trim() } catch { return undefined } })()
  let health
  try {
    const r = await fetch(`${dc.baseURL}/health`, { signal: AbortSignal.timeout(3000) })
    health = r.ok ? await r.json() : undefined
  } catch { health = undefined }
  if (health === undefined) { warn(`no decision service on ${dc.baseURL}`); info('start it with /decision up'); return false }

  head('decision engine')
  info(`${dc.baseURL}  status ${health.status}  device ${health.device ?? 'unknown'}`)
  info(`checkpoints loaded: ${(health.loaded ?? []).join(', ') || 'none reported'}`)
  const run = readRun()
  info(run === undefined ? 'run state: none recorded (not started by VerNess)' : `run state: pid ${run.pid}, started by ${run.startedByUs ? 'VerNess' : 'someone else'} at ${run.at}`)

  head('latency (all three routing questions in one call)')
  const samples = []
  for (let i = 0; i < 5; i++) {
    const r = await askDecision(dc, 'Add a --verbose flag to the launcher and document it in the runbook.', ROUTING_QUESTIONS)
    if (r.ok) samples.push(r.ms)
  }
  if (samples.length === 0) { warn('every probe failed'); return true }
  samples.sort((a, b) => a - b)
  info(`p50 ${samples[Math.floor(samples.length / 2)]} ms   min ${samples[0]} ms   max ${samples[samples.length - 1]} ms   (n=${samples.length})`)
  info('published figures: 32.8 ms on a T4, 193-464 ms on CPU - measure, do not assume')

  const last = await askDecision(dc, 'Add a --verbose flag to the launcher and document it in the runbook.', ROUTING_QUESTIONS)
  if (last.ok) {
    head('sample answer')
    for (const l of table(['question', 'answer', 'confidence'], Object.keys(ROUTING_QUESTIONS).map(k => {
      const a = readAnswer(last.body, k)
      return [k, String(a.answer), (a.confidence ?? 0).toFixed(3)]
    }))) console.log(`  ${l}`)
    info(paint('dim', 'confidence is answer_confidence; act_probability is ignored (no usable signal)'))
  }
  return true
}

/**
 * Stop the sidecar we started and free its memory. A service VerNess merely adopted is left alone
 * unless forced — the same rule the model engine follows.
 * @param {object} cfg - the VerNess configuration.
 * @param {{force?: boolean}} [opts] - `force` stops a service we did not start.
 * @returns {Promise<boolean>} whether the shutdown path completed.
 */
export async function decisionDown(cfg, opts = {}) {
  const dc = decisionConfig(cfg)
  if (!(await decisionHealth(dc))) {
    ok('no decision service running')
    if (existsSync(RUN_FILE)) { rmSync(RUN_FILE, { force: true }); info('cleared stale run state') }
    return true
  }
  const run = readRun()
  const mine = run?.startedByUs === true && typeof run.pid === 'number'
  if (!mine && opts.force !== true) {
    info('service left running: VerNess did not start it (use /decision down --force to stop it anyway)')
    return true
  }
  step(`stopping the sidecar${run?.pid === undefined ? '' : ` (pid ${run.pid})`}`)
  if (WIN) {
    if (typeof run?.pid === 'number') spawnSync('taskkill', ['/PID', String(run.pid), '/T', '/F'], { stdio: 'ignore' })
    if (opts.force === true) spawnSync('taskkill', ['/IM', 'laya-serve.exe', '/F'], { stdio: 'ignore' })
  } else if (typeof run?.pid === 'number') {
    try { process.kill(run.pid, 'SIGTERM') } catch { warn(`pid ${run.pid} was already gone`) }
  }
  for (let i = 0; i < 20 && (await decisionHealth(dc)); i++) await new Promise(r => setTimeout(r, 300))
  if (await decisionHealth(dc)) warn('the service is still answering')
  else ok('sidecar stopped, its checkpoints released')
  if (existsSync(RUN_FILE)) { rmSync(RUN_FILE, { force: true }); ok('run state cleared') }
  return true
}

// Standalone CLI: `node scripts/decision.mjs up|stats|down [--force]`.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { loadConfigForCli } = await import('./verness.mjs')
  const cfg = loadConfigForCli()
  const cmd = process.argv[2]
  const force = process.argv.includes('--force')
  if (cmd === 'up') process.exit((await decisionUp(cfg)) ? 0 : 1)
  else if (cmd === 'stats') process.exit((await decisionStats(cfg)) ? 0 : 1)
  else if (cmd === 'down') process.exit((await decisionDown(cfg, { force })) ? 0 : 1)
  else { console.log('usage: node scripts/decision.mjs up | stats | down [--force]'); process.exit(cmd === undefined ? 0 : 1) }
}
