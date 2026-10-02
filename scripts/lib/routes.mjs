/**
 * Model routes — the one place that decides which route and model the next run uses.
 *
 * Three kinds of route exist:
 *   local     the `model` block of the config: an OpenAI-compatible engine on this machine (Ollama),
 *             serving every model registered with `/models add` plus the configured one
 *   catalog   a provider the route adapter (pi-ai) ships a catalog for: its endpoint, protocol and
 *             model list come from the installed adapter, so FiNess only names the key variable
 *   declared  an `extraRoutes` entry with its own `api` + `baseURL` (any OpenAI-compatible gateway)
 *
 * Precedence, highest first: an explicit `/api use` or `/model` choice (`.finess/state.json`), then
 * the active persona's preference, then `activeRoute` in the config, then the local route. A model
 * chosen for one route is never sent to another — that is what used to produce `UNKNOWN_MODEL`.
 *
 * No provider is named in this file: the catalog and each provider's key variable are read from the
 * adapter installed in the profile, so a newer adapter brings its new providers with it.
 * @module scripts/lib/routes
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { activePersonaId, loadPersonas, readState } from './personas.mjs'
import { REPO, warn } from './util.mjs'

/** Sandbox modes the substrate understands, keyed by the short names `/access` accepts. */
export const ACCESS_MODES = {
  'read-only': 'read-only',
  read: 'read-only',
  'workspace-write': 'workspace-write',
  workspace: 'workspace-write',
  'danger-full-access': 'danger-full-access',
  full: 'danger-full-access',
}

/** @returns {string} `$DSH_HOME`, honouring the environment override. */
const dshHome = () => process.env.DSH_HOME ?? join(homedir(), '.dsh')

/**
 * @param {object} cfg - the FiNess configuration.
 * @returns {string} the installed route adapter's `dist` directory inside the profile.
 */
const adapterDist = cfg => join(dshHome(), 'profiles', cfg.profile.name, 'node_modules', '@earendil-works', 'pi-ai', 'dist')

/**
 * Load `KEY=value` lines from the repo's `.env` into `process.env`, never overriding a variable the
 * shell already set. `.env` is gitignored, so this is where provider keys live.
 * @param {string} [file] - the file to read; the repo's `.env` unless a test names another.
 * @param {Record<string, string|undefined>} [env] - the environment to fill; `process.env` by default.
 * @returns {string[]} the names that were loaded (never the values).
 */
export function loadDotEnv(file = join(REPO, '.env'), env = process.env) {
  if (!existsSync(file)) return []
  return applyDotEnv(readFileSync(file, 'utf8'), env)
}

/**
 * Apply `.env` text to an environment: `export` prefixes, quoted values and trailing comments are
 * understood; a variable that is already set, or an empty value, is left alone.
 * @param {string} text - the file's contents.
 * @param {Record<string, string|undefined>} env - the environment to fill.
 * @returns {string[]} the names that were set (never the values).
 */
export function applyDotEnv(text, env) {
  const loaded = []
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(raw)
    if (m === null) continue
    // `(.*)` is greedy, so trailing blanks land in the capture: a key pasted as `KEY=sk-...  ` must
    // not carry them, and a quoted value may be followed by blanks or a comment.
    const quoted = /^(['"])(.*?)\1(?:\s+#.*)?$/.exec(m[2].trim())
    const value = quoted !== null ? quoted[2] : m[2].replace(/\s+#.*$/, '').trim()
    if (env[m[1]] !== undefined || value === '') continue
    env[m[1]] = value
    loaded.push(m[1])
  }
  return loaded
}

/** Catalog cache: it is read from disk once per process. */
let catalogCache

/**
 * The providers the installed adapter ships a catalog for.
 * @param {object} cfg - the FiNess configuration.
 * @returns {Map<string, {models: string[], apis: string[]}>} provider id -> model ids; empty before setup.
 */
export function catalogProviders(cfg) {
  if (catalogCache !== undefined) return catalogCache
  const dir = join(adapterDist(cfg), 'providers', 'data')
  const out = new Map()
  if (existsSync(dir)) {
    const ids = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.')).map(f => f.replace(/\.json$/, ''))
    for (const f of ids.sort().map(id => `${id}.json`)) {
      try {
        // Shape: { <wire protocol>: { <model id>: {...} } } — a provider may speak several protocols.
        const data = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        const models = new Set()
        for (const byId of Object.values(data)) for (const id of Object.keys(byId ?? {})) models.add(id)
        if (models.size > 0) out.set(f.replace(/\.json$/, ''), { models: [...models], apis: Object.keys(data) })
      } catch { /* an unreadable catalog file is skipped, not fatal */ }
    }
  }
  catalogCache = out
  return out
}

/** Key-variable cache, per provider. */
const keyCache = new Map()

/**
 * The environment variable a provider's key is read from, as the installed adapter defines it.
 * Asking the adapter with an environment where every variable "exists" makes it list them all.
 * @param {object} cfg - the FiNess configuration.
 * @param {string} provider - catalog provider id.
 * @returns {Promise<string|undefined>} the variable name; undefined for providers using ambient
 *   credentials (cloud SDK logins) rather than a key.
 */
export async function keyEnvFor(cfg, provider) {
  if (keyCache.has(provider)) return keyCache.get(provider)
  let names
  try {
    const mod = await import(pathToFileURL(join(adapterDist(cfg), 'env-api-keys.js')).href)
    const everything = new Proxy({}, { get: () => 'present', has: () => true })
    names = mod.findEnvKeys?.(provider, everything)
  } catch { /* adapter not installed yet: fall through to the naming convention */ }
  const pick = Array.isArray(names)
    ? names.find(n => n.endsWith('_API_KEY')) ?? names[0]
    : (catalogProviders(cfg).has(provider) ? undefined : `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`)
  keyCache.set(provider, pick)
  return pick
}

/**
 * One-token probe (T-358): ask the provider's model for a single token, to confirm key and model
 * before a long task. This spends real tokens; callers confirm first.
 * @param {object} cfg - the FiNess configuration.
 * @param {string} provider - catalog provider id.
 * @param {string} model - model id.
 * @param {{complete?: Function}} [opts] - `complete(model, context, options)`; defaults to the adapter's
 *   `completeSimple`. Tests pass a stub, so no network is touched.
 * @returns {Promise<{ok: boolean, ms: number, inputTokens?: number, outputTokens?: number, error?: string}>} outcome.
 */
export async function probeModel(cfg, provider, model, opts = {}) {
  const t0 = Date.now()
  try {
    let complete = opts.complete
    let spec = { provider, id: model }
    if (complete === undefined) {
      const mod = await import(pathToFileURL(join(adapterDist(cfg), 'compat.js')).href)
      complete = mod.completeSimple
      spec = mod.getModel(provider, model)
      if (spec === undefined) return { ok: false, ms: 0, error: `the adapter has no model ${provider}/${model}` }
    }
    const keyEnv = await keyEnvFor(cfg, provider)
    const apiKey = keyEnv === undefined ? undefined : process.env[keyEnv]
    const msg = await complete(spec, { messages: [{ role: 'user', content: 'Reply with the single word: ok', timestamp: Date.now() }] }, { maxTokens: 1, apiKey })
    const ms = Date.now() - t0
    if (msg?.stopReason === 'error' || msg?.stopReason === 'aborted') return { ok: false, ms, error: msg.errorMessage ?? msg.stopReason }
    return { ok: true, ms, inputTokens: msg?.usage?.input ?? 0, outputTokens: msg?.usage?.output ?? 0 }
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e.message ?? e) }
  }
}

/**
 * Every route the configuration and state know about, by name.
 * @param {object} cfg - the FiNess configuration.
 * @param {{state?: object}} [opts] - the launcher state; `.finess/state.json` unless a test passes one.
 * @returns {Record<string, object>} route specs, each with a `kind`.
 */
export function knownRoutes(cfg, { state = readState() } = {}) {
  const routes = {}
  routes[cfg.model.route] = { ...cfg.model, kind: 'local', api: 'openai-completions' }
  for (const [name, r] of Object.entries(cfg.extraRoutes ?? {})) {
    routes[name] = { ...r, kind: r.api !== undefined || r.baseURL !== undefined ? 'declared' : 'catalog' }
  }
  // Routes added with `/api use` live in state, so enabling a provider never rewrites the commented
  // config file. A config entry of the same name wins.
  for (const [name, r] of Object.entries(state.apiRoutes ?? {})) {
    if (routes[name] === undefined) routes[name] = { ...r, kind: 'catalog' }
  }
  return routes
}

/**
 * Model ids the local engine is registered to serve: the configured one plus every `/models add`.
 * @param {object} cfg - the FiNess configuration.
 * @param {{state?: object}} [opts] - the launcher state; `.finess/state.json` unless a test passes one.
 * @returns {string[]} model ids, configured one first.
 */
export function localModels(cfg, { state = readState() } = {}) {
  const ids = [cfg.model.source ?? cfg.model.id, cfg.model.id, ...(state.localModels ?? [])]
  // A `/model <id>` override on the local route is served too, or the adapter refuses it.
  if (state.model !== undefined && (state.modelRoute ?? cfg.model.route) === cfg.model.route) ids.push(state.model)
  return [...new Set(ids.filter(x => typeof x === 'string' && x !== ''))]
}

/**
 * Smallest model size (billions of parameters) we expect to call tools reliably. A heuristic, not a
 * measurement: the one data point (T-438) is Qwen3 0.6B failing 20 of 33 tool calls.
 */
export const MIN_TOOL_MODEL_B = 4

/**
 * The parameter count a model id states (`qwen3:0.6b`, `hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0`, `llama3.1:8b`).
 * @param {string|undefined} id - the model id.
 * @returns {number|undefined} billions of parameters, or undefined when the id names none.
 */
export function modelSizeB(id) {
  // A size token stands alone between separators; "e4b"-style MoE tags and "1b5" are not matched.
  const m = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/i.exec(String(id ?? ''))
  return m === null ? undefined : Number(m[1])
}

/**
 * A warning when the model is too small to use tools reliably, else undefined.
 * @param {string|undefined} id - the model id.
 * @returns {string|undefined} the note.
 */
export function smallModelNote(id) {
  const b = modelSizeB(id)
  if (b === undefined || b >= MIN_TOOL_MODEL_B) return undefined
  return `${b}B is too small for reliable tool calls - expect wrong arguments; use ${MIN_TOOL_MODEL_B}B+ (or an API route) for real work`
}

/**
 * Resolve the route and model the next run uses. Every surface (patch, run, doctor, prompt status)
 * reads this, so they can never disagree.
 * @param {object} cfg - the FiNess configuration.
 * @param {{state?: object, persona?: object|string, env?: object}} [opts] - the launcher state
 *   (`.finess/state.json` unless a test passes one); the persona to resolve for (an id or a normalized
 *   persona; the active one by default, a team task passes its own); the environment keys are checked in.
 * @returns {{name: string, route: object, model: string|undefined, source: string, preset?: boolean, warning?: string, error?: string}}
 */
export function effectiveRoute(cfg, { state = readState(), persona: who, env = process.env } = {}) {
  const routes = knownRoutes(cfg, { state })
  const persona = typeof who === 'object' && who !== null ? who : loadPersonas(cfg).get(who ?? activePersonaId(cfg, state))
  const configured = cfg.activeRoute === '' || cfg.activeRoute === undefined ? cfg.model.route : cfg.activeRoute
  // Precedence (T-361): explicit session choice (`/api use`, `/model`) > persona preset > config default.
  // A preset that cannot run (unknown route, key not set) is dropped with one warning, never a crash.
  const bad = state.route === undefined ? presetProblem(persona, routes, env) : undefined
  const preset = bad === undefined && state.route === undefined ? persona?.model : undefined
  const name = state.route ?? preset?.route ?? configured
  const warned = bad === undefined ? {} : { warning: bad }
  const route = routes[name]
  if (route === undefined) {
    return { name, route: routes[cfg.model.route], model: undefined, source: 'none', ...warned, error: `route "${name}" is not declared (config model.route, extraRoutes, or /api use)` }
  }
  // An override is bound to the route it was chosen for. A legacy override without a route predates
  // API routes, so it can only have meant the local one.
  const overrideRoute = state.modelRoute ?? (state.model === undefined ? undefined : cfg.model.route)
  if (state.model !== undefined && overrideRoute === name) return { name, route, model: state.model, source: '/model override', ...warned }
  const presetRoute = preset?.route ?? cfg.model.route
  if (preset?.id !== undefined && presetRoute === name) return { name, route, model: preset.id, source: `persona ${persona.id}`, preset: true, ...warned }
  const model = route.kind === 'local' ? route.id : (route.id ?? route.model)
  return { name, route, model, source: 'route default', ...(preset?.route === name ? { preset: true } : {}), ...warned, ...(model === undefined ? { error: `route "${name}" has no model selected — run /api use ${name} <model>` } : {}) }
}

/**
 * Why a persona's `model` preset cannot run, if it cannot.
 * @param {object|undefined} persona - a normalized persona.
 * @param {Record<string, object>} routes - from `knownRoutes`.
 * @param {Record<string, string|undefined>} env - the environment keys are looked up in.
 * @returns {string|undefined} the warning text, undefined when the preset is absent or usable.
 */
function presetProblem(persona, routes, env) {
  const m = persona?.model
  if (m?.route === undefined) return undefined
  const r = routes[m.route]
  if (r === undefined) return `persona ${persona.id}: model route "${m.route}" is not declared; using the default`
  if (r.apiKeyEnv !== undefined && env[r.apiKeyEnv] === undefined && r.apiKeyValue === undefined) {
    return `persona ${persona.id}: route "${m.route}" needs ${r.apiKeyEnv}, which is not set; using the default`
  }
  return undefined
}

/** Preset warnings already shown, so a persona that cannot use its preset says so once per process. */
const warnedPresets = new Set()

/**
 * Print a resolution's preset warning, once per distinct text.
 * @param {{warning?: string}} eff - from `effectiveRoute`.
 * @returns {void}
 */
export function warnPreset(eff) {
  if (eff.warning === undefined || warnedPresets.has(eff.warning)) return
  warnedPresets.add(eff.warning)
  warn(eff.warning)
}

/**
 * The environment a run needs for the effective route and access mode.
 * @param {object} cfg - the FiNess configuration.
 * @param {{persona?: object|string}} [opts] - resolve for this persona instead of the active one.
 * @returns {{env: Record<string,string>, missingKey?: string}} extra variables, and the
 *   name of a required key that is not set, if any.
 */
export function routeEnvironment(cfg, { persona } = {}) {
  const { route } = effectiveRoute(cfg, { persona })
  const env = {}
  const access = readState().access
  if (access !== undefined && process.env.DSH_PERMISSION_MODE === undefined) env.DSH_PERMISSION_MODE = access
  const keyEnv = route.apiKeyEnv
  if (keyEnv !== undefined && process.env[keyEnv] === undefined) {
    // The local engine ignores bearer auth but the adapter demands a key, hence a placeholder value.
    if (route.apiKeyValue !== undefined) env[keyEnv] = route.apiKeyValue
    else return { env, missingKey: keyEnv }
  }
  return { env }
}

/**
 * @returns {string} the effective sandbox mode: `/access` choice, else the shell's variable, else
 *   the substrate default.
 */
export function accessMode() {
  return process.env.DSH_PERMISSION_MODE ?? readState().access ?? 'workspace-write'
}
