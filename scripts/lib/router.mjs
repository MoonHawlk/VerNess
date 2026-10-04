/**
 * Capability router (T-253): persona requirements + model capabilities -> eligible models ->
 * cost / latency / policy -> one ranked choice with its reasons.
 *
 * The tier (`local_small | local_large | frontier`, docs/09 "Model tier") is an INPUT that adds
 * minimum requirements; it never names a model. The persona's `models.requirements` (validated at
 * load by the contracts) are the other input. Each candidate's capabilities come from, in order:
 * `models.capabilities` in the config, the installed adapter's catalog, then a size heuristic. Every
 * value carries where it came from, so a reason never overclaims.
 *
 * ADVISORY ONLY. The router never touches state, overlays, env or argv: T-361 (session > persona
 * preset > config) and T-453 (fallback) still decide what runs. The REPL logs the pick next to the
 * actual route (`.finess/decisions/router/`) until a later gated rollout.
 * @module scripts/lib/router
 */

import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { capabilityGaps, mergeRequirements, validateCapabilities } from '../../packages/contracts/src/capabilities.ts'
import { formatPath } from '../../packages/contracts/src/issue.ts'
import { decisionsDir } from './decisions.mjs'
import { knownRoutes, localModels, MIN_TOOL_MODEL_B, modelSizeB, unavailableReason } from './routes.mjs'

/** Minimums each tier adds. Overridable per tier with `models.tiers.<tier>` (same capability shape). */
export const TIER_REQUIREMENTS = {
  local_small: { tool_calling: 'low' },
  local_large: { tool_calling: 'medium', reasoning: 'medium' },
  frontier: { tool_calling: 'high', reasoning: 'high' },
}

/** Context window the launcher writes for a local route that declares none (finess.mjs DEFAULTS). */
export const LOCAL_CONTEXT_DEFAULT = 32768

/** Size (B params) from which a local model counts as `high` by the heuristic. */
export const LARGE_LOCAL_B = 30

/** Fields a `models.capabilities` entry may carry besides the capability keys. */
const EXTRA_FIELDS = ['latencyMs']

/**
 * Validate one `models.capabilities` entry: capability keys (contracts) plus `latencyMs`.
 * @param {unknown} v - the entry.
 * @param {string} key - its config key, for the issue path.
 * @returns {{caps?: object, latencyMs?: number, error?: string}} the parsed entry or one error line.
 */
export function parseCapabilityEntry(v, key) {
  const path = ['models', 'capabilities', key]
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return { error: `${formatPath(path)}: expected an object` }
  const rest = Object.fromEntries(Object.entries(v).filter(([k]) => !EXTRA_FIELDS.includes(k)))
  const r = validateCapabilities(rest, path)
  if (!r.ok) return { error: r.errors.map(e => `${formatPath(e.path)}: ${e.message}`).join('; ') }
  const lat = v.latencyMs
  if (lat !== undefined && (typeof lat !== 'number' || !Number.isFinite(lat) || lat < 0)) return { error: `${formatPath([...path, 'latencyMs'])}: expected a non-negative number` }
  return { caps: r.value, ...(lat === undefined ? {} : { latencyMs: lat }) }
}

/**
 * Capabilities a catalog spec states. `context`, `vision` and cost are read; the levels are guesses
 * (a catalog says `reasoning: true`, never how good), labelled `heuristic`.
 * @param {object|undefined} spec - an adapter catalog entry.
 * @returns {{caps: object, from: Record<string, string>, costPer1M?: number}} capabilities and provenance.
 */
export function capabilitiesFromSpec(spec) {
  if (spec === null || typeof spec !== 'object') return { caps: {}, from: {} }
  const caps = {}
  const from = {}
  const set = (k, v, src) => { caps[k] = v; from[k] = src }
  if (Number.isInteger(spec.contextWindow) && spec.contextWindow > 0) set('context', spec.contextWindow, 'catalog')
  if (Array.isArray(spec.input)) set('vision', spec.input.includes('image') ? 'high' : 'none', 'catalog')
  const level = spec.reasoning === true ? 'high' : 'medium'
  set('reasoning', level, 'heuristic')
  set('code', level, 'heuristic')
  set('tool_calling', 'high', 'heuristic')
  set('structured_output', 'high', 'heuristic')
  const c = spec.cost
  const costPer1M = c !== null && typeof c === 'object' && Number.isFinite(c.input) && Number.isFinite(c.output) ? c.input + c.output : undefined
  return { caps, from, ...(costPer1M === undefined ? {} : { costPer1M }) }
}

/**
 * Capabilities a local model is assumed to have, from the parameter count in its id. Agrees with
 * `smallModelNote`: under `MIN_TOOL_MODEL_B` is `low`.
 * @param {string} model - the model id.
 * @param {object} route - the local route spec (`contextWindow`).
 * @returns {{caps: object, from: Record<string, string>}} capabilities and provenance.
 */
export function localCapabilities(model, route) {
  const b = modelSizeB(model)
  const level = b === undefined ? 'medium' : b < MIN_TOOL_MODEL_B ? 'low' : b < LARGE_LOCAL_B ? 'medium' : 'high'
  const caps = { tool_calling: level, reasoning: level, code: level, structured_output: level, vision: 'none' }
  const from = Object.fromEntries(Object.keys(caps).map(k => [k, 'heuristic']))
  caps.context = Number.isInteger(route?.contextWindow) ? route.contextWindow : LOCAL_CONTEXT_DEFAULT
  from.context = Number.isInteger(route?.contextWindow) ? 'route' : 'default'
  return { caps, from }
}

/**
 * Every (route, model) the router may consider: each local model, each route's selected model, the
 * fallback list and the persona preset. Never the whole catalog: only what the operator enabled.
 * @param {object} cfg - the FiNess configuration.
 * @param {{state: object, persona?: object}} opts - launcher state and the normalized persona.
 * @returns {{route: string, model: string, spec: object}[]} candidates, deduplicated, in discovery order.
 */
export function routerCandidates(cfg, { state, persona }) {
  const routes = knownRoutes(cfg, { state })
  const out = new Map()
  const add = (route, model) => {
    if (typeof model !== 'string' || model === '' || routes[route] === undefined) return
    const key = `${route}/${model}`
    if (!out.has(key)) out.set(key, { route, model, spec: routes[route] })
  }
  for (const m of localModels(cfg, { state })) add(cfg.model.route, m)
  for (const [name, r] of Object.entries(routes)) if (r.kind !== 'local') add(name, r.id ?? r.model)
  if (state.route !== undefined && state.model !== undefined && (state.modelRoute ?? state.route) === state.route) add(state.route, state.model)
  for (const f of Array.isArray(cfg.model?.fallback) ? cfg.model.fallback : []) if (f !== null && typeof f === 'object') add(f.route, f.id)
  if (persona?.model?.route !== undefined || persona?.model?.id !== undefined) add(persona.model.route ?? cfg.model.route, persona.model.id)
  return [...out.values()]
}

/**
 * Cost per million tokens (input + output): the `pricing` table (`route/model` over `route`) wins,
 * then the catalog; a local route is free.
 * @param {object} cfg - the FiNess configuration.
 * @param {{route: string, model: string, spec: object}} c - the candidate.
 * @param {number|undefined} catalogCost - from the catalog spec.
 * @returns {{cost?: number, from?: string}} the cost and its source.
 */
export function candidateCost(cfg, c, catalogCost) {
  const p = cfg.pricing?.[`${c.route}/${c.model}`] ?? cfg.pricing?.[c.route]
  if (p !== undefined && p !== null && typeof p === 'object') {
    const n = Number(p.inputPer1M ?? 0) + Number(p.outputPer1M ?? 0)
    if (Number.isFinite(n)) return { cost: n, from: 'pricing' }
  }
  if (catalogCost !== undefined) return { cost: catalogCost, from: 'catalog' }
  if (c.spec.kind === 'local') return { cost: 0, from: 'local' }
  return {}
}

/**
 * The requirement the persona and the tier together impose (stricter value per key).
 * @param {object} cfg - the FiNess configuration.
 * @param {object|undefined} persona - normalized persona (`requirements` from `models.requirements`).
 * @param {string|undefined} tier - the tier input.
 * @returns {{need: object, warnings: string[]}} the merged requirement and any problem with the inputs.
 */
export function routerRequirements(cfg, persona, tier) {
  const warnings = []
  let tierNeed = {}
  if (tier !== undefined) {
    const override = cfg.models?.tiers?.[tier]
    if (Object.hasOwn(TIER_REQUIREMENTS, tier)) tierNeed = TIER_REQUIREMENTS[tier]
    else if (override === undefined) warnings.push(`unknown tier "${tier}" - only the persona's requirements apply`)
    if (override !== undefined) {
      const r = validateCapabilities(override, ['models', 'tiers', tier])
      if (r.ok) tierNeed = r.value
      else warnings.push(...r.errors.map(e => `${formatPath(e.path)}: ${e.message} - tier default used`))
    }
  }
  return { need: mergeRequirements(persona?.requirements ?? {}, tierNeed), warnings }
}

/** @param {number|undefined} a - left. @param {number|undefined} b - right. @returns {number} ascending, undefined last. */
const asc = (a, b) => (a === undefined ? (b === undefined ? 0 : 1) : b === undefined ? -1 : a - b)

/**
 * @typedef {object} RouterChoice
 * @property {string} key - `route/model`.
 * @property {string} route - route name.
 * @property {string} model - model id.
 * @property {object} caps - effective capabilities.
 * @property {Record<string, string>} from - per capability: `config | catalog | route | default | heuristic`.
 * @property {number} [cost] - per million tokens, input + output.
 * @property {number} [latencyMs] - configured latency.
 * @property {string[]} reasons - why it ranks where it does.
 */

/**
 * Rank every candidate for a tier and persona. Pure: state, env, availability and catalog specs are
 * all passed in.
 * @param {object} cfg - the FiNess configuration (`models.capabilities`, `models.pin`, `models.deny`, `pricing`).
 * @param {object} opts - inputs.
 * @param {object} opts.state - launcher state.
 * @param {object} [opts.persona] - normalized persona.
 * @param {string} [opts.tier] - the tier input (from the rules or the decision model).
 * @param {(route: string, model: string, spec: object) => object|undefined} [opts.specFor] - catalog spec lookup.
 * @param {{env?: Record<string, string|undefined>, engineUp?: boolean}} [opts.facts] - availability; omitted = not checked.
 * @param {string} [opts.actual] - `route/model` that actually runs, used only as the last tie-break.
 * @returns {{tier?: string, need: object, pick?: RouterChoice, ranked: RouterChoice[], ineligible: {key: string, why: string[]}[], warnings: string[]}} the ranking.
 */
export function routeByCapability(cfg, { state, persona, tier, specFor = () => undefined, facts, actual }) {
  const { need, warnings } = routerRequirements(cfg, persona, tier)
  const table = cfg.models?.capabilities ?? {}
  const deny = new Set(Array.isArray(cfg.models?.deny) ? cfg.models.deny : [])
  const pin = typeof cfg.models?.pin === 'string' ? cfg.models.pin : undefined
  const ranked = []
  const ineligible = []
  const all = []
  for (const c of routerCandidates(cfg, { state, persona })) {
    const key = `${c.route}/${c.model}`
    const local = c.spec.kind === 'local'
    const base = local ? localCapabilities(c.model, c.spec) : capabilitiesFromSpec(specFor(c.route, c.model, c.spec))
    const caps = { ...base.caps }
    const from = { ...base.from }
    if (!local && caps.context === undefined && Number.isInteger(c.spec.contextWindow)) { caps.context = c.spec.contextWindow; from.context = 'route' }
    let latencyMs
    const entryKey = table[key] !== undefined ? key : table[c.model] !== undefined ? c.model : undefined
    if (entryKey !== undefined) {
      const e = parseCapabilityEntry(table[entryKey], entryKey)
      if (e.error !== undefined) warnings.push(`${e.error} - entry ignored`)
      else {
        for (const [k, v] of Object.entries(e.caps)) { caps[k] = v; from[k] = 'config' }
        latencyMs = e.latencyMs
      }
    }
    const { cost, from: costFrom } = candidateCost(cfg, c, base.costPer1M)
    const choice = { key, route: c.route, model: c.model, caps, from, ...(cost === undefined ? {} : { cost, costFrom }), ...(latencyMs === undefined ? {} : { latencyMs }), reasons: [] }
    all.push(choice)
    const why = []
    if (deny.has(key) || deny.has(c.route)) why.push('denied by models.deny')
    const down = facts?.env === undefined ? undefined : unavailableReason(c.spec, { engineUp: facts.engineUp ?? true, env: facts.env })
    if (down !== undefined) why.push(`unavailable: ${down}`)
    for (const g of capabilityGaps(caps, need)) {
      const k = g.split(':')[0]
      why.push(`${g} (${from[k] ?? 'unknown'})`)
    }
    if (why.length > 0) { ineligible.push({ key, why }); continue }
    ranked.push(choice)
  }
  ranked.sort((a, b) => asc(a.cost, b.cost) || asc(a.latencyMs, b.latencyMs)
    || asc(modelSizeB(a.model), modelSizeB(b.model)) || (a.key === actual ? -1 : b.key === actual ? 1 : 0)
    || a.key.localeCompare(b.key))
  const met = Object.keys(need)
  for (const [i, c] of ranked.entries()) {
    c.reasons.push(met.length === 0 ? 'no requirements' : `meets ${met.map(k => `${k} ${need[k]} (${c.caps[k]}, ${c.from[k]})`).join(', ')}`)
    c.reasons.push(c.cost === undefined ? 'cost unknown' : `cost ${c.cost}/1M (${c.costFrom})`)
    if (c.latencyMs !== undefined) c.reasons.push(`latency ${c.latencyMs} ms (config)`)
    if (i === 0 && ranked.length > 1) c.reasons.push(`ranked first of ${ranked.length} eligible`)
  }
  let pick = ranked[0]
  if (pin !== undefined) {
    const pinned = all.find(c => c.key === pin)
    if (pinned === undefined) warnings.push(`models.pin "${pin}" is not a known route/model - ignored`)
    else {
      pick = pinned
      const gaps = ineligible.find(x => x.key === pin)?.why ?? []
      pick.reasons = [`pinned by models.pin${gaps.length > 0 ? `, despite: ${gaps.join('; ')}` : ''}`, ...pick.reasons]
    }
  }
  return { ...(tier === undefined ? {} : { tier }), need, ...(pick === undefined ? {} : { pick }), ranked, ineligible, warnings }
}

/**
 * The shadow record for one task: what the router would pick next to what actually runs.
 * @param {ReturnType<typeof routeByCapability>} r - the ranking.
 * @param {{task: string, actual: string, persona?: string, tierFrom?: string}} ctx - the task.
 * @returns {object} the record body.
 */
export function routerRecord(r, { task, actual, persona, tierFrom = 'rules' }) {
  return {
    source: 'repl',
    task: String(task).slice(0, 500),
    ...(persona === undefined ? {} : { persona }),
    tier: r.tier,
    tierFrom,
    need: r.need,
    pick: r.pick?.key ?? null,
    reasons: r.pick?.reasons ?? [],
    actual,
    agree: r.pick?.key === actual,
    eligible: r.ranked.length,
    ineligible: r.ineligible.length,
    ...(r.warnings.length > 0 ? { warnings: r.warnings } : {}),
  }
}

/** Router shadow log: a subdirectory, so the Laya readers (`^\d{4}-\d{2}-\d{2}\.jsonl$`) never see it. */
export const routerDir = (dir = decisionsDir()) => join(dir, 'router')

/**
 * Append one router shadow record.
 * @param {object} record - from `routerRecord`.
 * @param {string} [dir] - the router log directory.
 * @returns {string} the record id.
 */
export function logRouterShadow(record, dir = routerDir()) {
  mkdirSync(dir, { recursive: true })
  const id = randomBytes(6).toString('hex')
  const at = new Date().toISOString()
  appendFileSync(join(dir, `${at.slice(0, 10)}.jsonl`), `${JSON.stringify({ v: 1, id, at, ...record })}\n`, 'utf8')
  return id
}

/**
 * @param {string} [dir] - the router log directory.
 * @returns {object[]} every router record, oldest first; torn lines skipped.
 */
export function readRouterRecords(dir = routerDir()) {
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      try { const r = JSON.parse(line); if (r !== null && typeof r === 'object') out.push(r) } catch { /* blank or torn line */ }
    }
  }
  return out
}

/**
 * @param {object[]} records - router records.
 * @returns {{agree: number, n: number, rate: number|null, noPick: number}} how often the pick equals what ran.
 */
export function routerAgreement(records) {
  const withPick = records.filter(r => typeof r.pick === 'string')
  const agree = withPick.filter(r => r.pick === r.actual).length
  return { agree, n: withPick.length, rate: withPick.length === 0 ? null : agree / withPick.length, noPick: records.length - withPick.length }
}
