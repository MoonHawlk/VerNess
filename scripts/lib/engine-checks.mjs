/**
 * Why the local engine cannot start (T-452). Every check is a pure function over injected facts
 * (env, a tiny fs facade, probe results), so none needs a real engine. `gatherFacts` is the one
 * place that touches the machine; `/doctor` and `modelUp` call `runChecks(await gatherFacts(...))`.
 * A finding is `{id, message, fix}`; no finding means the check passed.
 * @module scripts/lib/engine-checks
 */

import { accessSync, constants, existsSync, statfsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, parse } from 'node:path'

import { modelSizeB } from './routes.mjs'

/** @typedef {{id: string, message: string, fix: string}} Finding */
/** @typedef {{exists: (p: string) => boolean, writable: (p: string) => boolean}} FsFacade */

const GB = 1024 ** 3

/** @param {string} baseURL - a route base URL. @returns {{host: string, port: number}} where it points. */
export function hostPort(baseURL) {
  try {
    const u = new URL(String(baseURL))
    return { host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) }
  } catch { return { host: '127.0.0.1', port: 11434 } }
}

/** @param {string} value - an OLLAMA_HOST value (`host`, `host:port`, `http://host:port`). @returns {{host: string, port: number}} parsed. */
export function parseOllamaHost(value) {
  const v = String(value).trim()
  const withScheme = /^[a-z]+:\/\//i.test(v) ? v : `http://${v}`
  try {
    const u = new URL(withScheme)
    return { host: u.hostname === '' ? '127.0.0.1' : u.hostname, port: Number(u.port || 11434) }
  } catch { return { host: v, port: 11434 } }
}

/** @param {string} h - a host name. @returns {boolean} whether it is the local machine. */
const isLocalHost = h => ['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', ''].includes(h)

/**
 * The directory models are stored in: `OLLAMA_MODELS`, else `~/.ollama/models`.
 * @param {Record<string, string|undefined>} env - environment.
 * @param {string} home - the home directory.
 * @returns {string} the path.
 */
export const modelsDir = (env, home) => (env.OLLAMA_MODELS ?? '').trim() || join(home, '.ollama', 'models')

/**
 * Nearest existing ancestor of a path (itself included), or undefined when even the root is gone.
 * @param {string} p - a path.
 * @param {FsFacade} fs - the fs facade.
 * @returns {string|undefined} the ancestor.
 */
export function existingAncestor(p, fs) {
  for (let cur = p; ; cur = dirname(cur)) {
    if (fs.exists(cur)) return cur
    if (dirname(cur) === cur) return undefined
  }
}

/**
 * OLLAMA_MODELS set but its drive/parent is missing or not writable. This is what killed `ollama serve`.
 * @param {{env: Record<string, string|undefined>, fs: FsFacade}} f - facts.
 * @returns {Finding|undefined} the finding.
 */
export function checkModelsDir({ env, fs }) {
  const dir = (env.OLLAMA_MODELS ?? '').trim()
  if (dir === '') return undefined
  const fix = 'set OLLAMA_MODELS to an existing folder (setx on Windows, your shell profile on macOS), or remove it to use ~/.ollama/models'
  const root = parse(dir).root
  if (root !== '' && !fs.exists(root)) {
    return { id: 'models-dir', message: `OLLAMA_MODELS=${dir} points at drive ${root}, which does not exist`, fix: `plug the drive in, or ${fix}` }
  }
  if (fs.exists(dir)) {
    return fs.writable(dir) ? undefined : { id: 'models-dir', message: `OLLAMA_MODELS=${dir} is not writable`, fix: `give your user write access to it, or ${fix}` }
  }
  const parent = existingAncestor(dir, fs)
  if (parent === undefined) return { id: 'models-dir', message: `OLLAMA_MODELS=${dir} has no existing parent folder`, fix }
  return fs.writable(parent)
    ? undefined // the engine will create it
    : { id: 'models-dir', message: `OLLAMA_MODELS=${dir} does not exist and ${parent} is not writable, so it cannot be created`, fix: `create the folder yourself, or ${fix}` }
}

/**
 * OLLAMA_HOST sends the engine (and `ollama pull`) somewhere other than the route's base URL.
 * @param {{env: Record<string, string|undefined>, baseURL: string}} f - facts.
 * @returns {Finding|undefined} the finding.
 */
export function checkHostEnv({ env, baseURL }) {
  const raw = (env.OLLAMA_HOST ?? '').trim()
  if (raw === '') return undefined
  const want = hostPort(baseURL)
  const got = parseOllamaHost(raw)
  const same = got.port === want.port && (got.host === want.host || (isLocalHost(got.host) && isLocalHost(want.host)))
  if (same) return undefined
  return {
    id: 'host-env',
    message: `OLLAMA_HOST=${raw} differs from the route (${want.host}:${want.port}), so the engine listens elsewhere`,
    fix: `unset OLLAMA_HOST, or point the local route's baseURL at http://${got.host}:${got.port}/v1`,
  }
}

/**
 * The route's port is taken by something that does not answer as the engine.
 * @param {{port: number, portOpen: boolean|undefined, engineAnswering: boolean}} f - facts.
 * @returns {Finding|undefined} the finding.
 */
export function checkPort({ port, portOpen, engineAnswering }) {
  if (engineAnswering || portOpen !== true) return undefined
  return {
    id: 'port',
    message: `port ${port} is taken by another process that is not the engine`,
    fix: process.platform === 'win32'
      ? `find it with: netstat -ano | findstr :${port}  (then stop it), or use another port in the route's baseURL`
      : `find it with: lsof -i :${port}  (then stop it), or use another port in the route's baseURL`,
  }
}

/**
 * The engine binary is not callable.
 * @param {{binary: string|undefined}} f - facts; `binary` is the version string, undefined when missing.
 * @returns {Finding|undefined} the finding.
 */
export function checkBinary({ binary }) {
  if (binary !== undefined) return undefined
  return { id: 'binary', message: 'the engine binary (ollama) is not on PATH', fix: 'install it from https://ollama.com/download (winget install Ollama.Ollama / brew install ollama), then reopen the terminal' }
}

/**
 * Rough size of a model's weights: ~0.6 GB per billion parameters at 4-bit, plus headroom.
 * @param {string|undefined} model - the model id.
 * @returns {number|undefined} bytes, or undefined when the id states no size.
 */
export function estimateModelBytes(model) {
  const b = modelSizeB(model)
  return b === undefined ? undefined : Math.round((b * 0.6 + 0.3) * GB)
}

/**
 * Free disk where models live is below what the chosen model needs.
 * @param {{model: string|undefined, modelInstalled: boolean, freeBytes: number|undefined, dir: string}} f - facts.
 * @returns {Finding|undefined} the finding.
 */
export function checkDisk({ model, modelInstalled, freeBytes, dir }) {
  const need = estimateModelBytes(model)
  if (modelInstalled || need === undefined || freeBytes === undefined || freeBytes >= need) return undefined
  const g = n => `${(n / GB).toFixed(1)} GB`
  return {
    id: 'disk',
    message: `${g(freeBytes)} free where models live (${dir}); ${model} needs about ${g(need)}`,
    fix: 'free some disk space, point OLLAMA_MODELS at a bigger drive, or pick a smaller model (/model)',
  }
}

/**
 * Run every check over the facts.
 * @param {object} facts - the output of `gatherFacts` (or a test's own).
 * @returns {Finding[]} findings, most likely cause first.
 */
export function runChecks(facts) {
  return [checkBinary(facts), checkModelsDir(facts), checkHostEnv(facts), checkPort(facts), checkDisk(facts)].filter(x => x !== undefined)
}

/**
 * Map the last line of the engine's stderr to the matching fix.
 * @param {string} line - the line.
 * @param {Record<string, string|undefined>} [env] - environment, to name the variable at fault.
 * @returns {string|undefined} a fix hint.
 */
export function hintForLog(line, env = {}) {
  const models = (env.OLLAMA_MODELS ?? '').trim()
  if (/address already in use|only one usage of each socket|bind:/i.test(line)) return 'another process holds the port: stop it, or use another port (OLLAMA_HOST / the route baseURL)'
  if (/no space left|not enough space|disk full/i.test(line)) return 'the disk is full: free some space or move OLLAMA_MODELS to a bigger drive'
  if (/cannot find the path|no such file or directory|mkdir|not a directory|permission denied|access is denied/i.test(line)) {
    return models === '' ? 'the engine cannot create or write its models folder: check ~/.ollama permissions' : `OLLAMA_MODELS=${models} is missing or not writable: create it, or unset OLLAMA_MODELS`
  }
  return undefined
}

/**
 * The last meaningful line of a server log (ANSI and blank lines dropped); errors win over noise.
 * @param {string} text - the log.
 * @returns {string|undefined} the line.
 */
export function lastErrorLine(text) {
  // eslint-disable-next-line no-control-regex
  const lines = String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const err = [...lines].reverse().find(l => /error|fatal|fail|cannot|denied|in use|no such|not enough|panic/i.test(l))
  return err ?? lines.at(-1)
}

/** @param {string} p - a path. @returns {boolean} whether this user can write it. */
const canWrite = p => { try { accessSync(p, constants.W_OK); return true } catch { return false } }

/**
 * TCP connect probe.
 * @param {string} host - host.
 * @param {number} port - port.
 * @param {number} [ms] - timeout.
 * @returns {Promise<boolean>} whether something accepts connections there.
 */
export function probePort(host, port, ms = 400) {
  return new Promise(resolve => {
    const s = createConnection({ host, port })
    const done = v => { s.destroy(); resolve(v) }
    s.setTimeout(ms, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

/**
 * Collect the facts on this machine (each probe is bounded well under a second).
 * @param {{env?: Record<string, string|undefined>, baseURL: string, model?: string, engineAnswering: boolean,
 *   binary: string|undefined, modelInstalled?: boolean}} o - what the caller already knows.
 * @returns {Promise<object>} facts for `runChecks`.
 */
export async function gatherFacts(o) {
  const env = o.env ?? process.env
  const fs = { exists: existsSync, writable: canWrite }
  const { host, port } = hostPort(o.baseURL)
  const dir = modelsDir(env, homedir())
  const anchor = existingAncestor(dir, fs)
  let freeBytes
  try { if (anchor !== undefined) { const s = statfsSync(anchor); freeBytes = Number(s.bavail) * Number(s.bsize) } } catch { /* unknown */ }
  const portOpen = o.engineAnswering ? undefined : await probePort(host === 'localhost' ? '127.0.0.1' : host, port)
  return { env, fs, baseURL: o.baseURL, port, portOpen, engineAnswering: o.engineAnswering, binary: o.binary, model: o.model, modelInstalled: o.modelInstalled === true, freeBytes, dir }
}
