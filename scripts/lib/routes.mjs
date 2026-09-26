/**
 * Model routes — the one place that decides which route and model the next run uses.
 *
 * Three kinds of route exist:
 *   local     the `model` block of the config: an OpenAI-compatible engine on this machine (Ollama),
 *             serving every model registered with `/models add` plus the configured one
 *   catalog   a provider the route adapter (pi-ai) ships a catalog for: its endpoint, protocol and
 *             model list come from the installed adapter, so VerNess only names the key variable
 *   declared  an `extraRoutes` entry with its own `api` + `baseURL` (any OpenAI-compatible gateway)
 *
 * Precedence, highest first: an explicit `/api use` or `/model` choice (`.verness/state.json`), then
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
import { REPO } from './util.mjs'

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
 * @param {object} cfg - the VerNess configuration.
 * @returns {string} the installed route adapter's `dist` directory inside the profile.
 */
const adapterDist = cfg => join(dshHome(), 'profiles', cfg.profile.name, 'node_modules', '@earendil-works', 'pi-ai', 'dist')

/**
 * Load `KEY=value` lines from the repo's `.env` into `process.env`, never overriding a variable the
 * shell already set. `.env` is gitignored, so this is where provider keys live.
 * @returns {string[]} the names that were loaded (never the values).
 */
export function loadDotEnv() {
  const file = join(REPO, '.env')
  if (!existsSync(file)) return []
  const loaded = []
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(raw)
    if (m === null) continue
    let value = m[2]
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, '')
    if (process.env[m[1]] !== undefined || value === '') continue
    process.env[m[1]] = value
    loaded.push(m[1])
  }
  return loaded
}

/** Catalog cache: it is read from disk once per process. */
let catalogCache

/**
 * The providers the installed adapter ships a catalog for.
 * @param {object} cfg - the VerNess configuration.
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
 * @param {object} cfg - the VerNess configuration.
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
 * Every route the configuration and state know about, by name.
 * @param {object} cfg - the VerNess configuration.
 * @returns {Record<string, object>} route specs, each with a `kind`.
 */
export function knownRoutes(cfg) {
  const state = readState()
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
 * @param {object} cfg - the VerNess configuration.
 * @returns {string[]} model ids, configured one first.
 */
export function localModels(cfg) {
  const state = readState()
  const ids = [cfg.model.source ?? cfg.model.id, cfg.model.id, ...(state.localModels ?? [])]
  // A `/model <id>` override on the local route is served too, or the adapter refuses it.
  if (state.model !== undefined && (state.modelRoute ?? cfg.model.route) === cfg.model.route) ids.push(state.model)
  return [...new Set(ids.filter(x => typeof x === 'string' && x !== ''))]
}

/**
 * Resolve the route and model the next run uses. Every surface (patch, run, doctor, prompt status)
 * reads this, so they can never disagree.
 * @param {object} cfg - the VerNess configuration.
 * @returns {{name: string, route: object, model: string|undefined, source: string, error?: string}}
 */
export function effectiveRoute(cfg) {
  const state = readState()
  const routes = knownRoutes(cfg)
  const persona = loadPersonas(cfg).get(activePersonaId(cfg))
  const configured = cfg.activeRoute === '' || cfg.activeRoute === undefined ? cfg.model.route : cfg.activeRoute
  const name = state.route ?? persona?.model?.route ?? configured
  const route = routes[name]
  if (route === undefined) {
    return { name, route: routes[cfg.model.route], model: undefined, source: 'none', error: `route "${name}" is not declared (config model.route, extraRoutes, or /api use)` }
  }
  // An override is bound to the route it was chosen for. A legacy override without a route predates
  // API routes, so it can only have meant the local one.
  const overrideRoute = state.modelRoute ?? (state.model === undefined ? undefined : cfg.model.route)
  if (state.model !== undefined && overrideRoute === name) return { name, route, model: state.model, source: '/model override' }
  const personaRoute = persona?.model?.route ?? cfg.model.route
  if (persona?.model?.id !== undefined && personaRoute === name) return { name, route, model: persona.model.id, source: `persona ${persona.id}` }
  const model = route.kind === 'local' ? route.id : (route.id ?? route.model)
  return { name, route, model, source: 'route default', ...(model === undefined ? { error: `route "${name}" has no model selected — run /api use ${name} <model>` } : {}) }
}

/**
 * The environment a run needs for the effective route and access mode.
 * @param {object} cfg - the VerNess configuration.
 * @returns {{env: Record<string,string>, missingKey?: string}} extra variables, and the
 *   name of a required key that is not set, if any.
 */
export function routeEnvironment(cfg) {
  const { route } = effectiveRoute(cfg)
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
