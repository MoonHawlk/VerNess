/**
 * Capability router (T-253): requirements, capability sources, eligibility, tie-breaks, policy and the
 * shadow log. Every test passes its own config, state, persona, env and catalog lookup, so neither
 * `.finess/state.json`, the real `.env` nor the installed adapter catalog is read. Logs go to temp dirs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readDecisionRecords } from '../lib/decisions.mjs'
import { readShadow } from '../lib/labels.mjs'
import { loadPersonas } from '../lib/personas.mjs'
import {
  LOCAL_CONTEXT_DEFAULT, TIER_REQUIREMENTS, candidateCost, capabilitiesFromSpec, localCapabilities, logRouterShadow,
  parseCapabilityEntry, readRouterRecords, routeByCapability, routerAgreement, routerCandidates, routerDir, routerRecord,
  routerRequirements,
} from '../lib/router.mjs'
import { rankingLines, routerRows } from '../commands/routing.mjs'

/**
 * @param {object} [over] - top-level overrides.
 * @returns {object} a config: a local route with two models, a catalog route and a declared gateway.
 */
const makeCfg = (over = {}) => ({
  profile: { name: 'router-test', template: 'headless' },
  model: { route: 'local', id: 'qwen3:8b', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'LOCAL_KEY', apiKeyValue: 'placeholder', fallback: [] },
  extraRoutes: {
    hosted: { apiKeyEnv: 'HOSTED_API_KEY', model: 'big-model' },
    gateway: { api: 'openai-completions', baseURL: 'https://gw.example/v1', id: 'gw-model', apiKeyEnv: 'GW_API_KEY', contextWindow: 65536 },
  },
  activeRoute: '',
  personas: { active: 'p', definitions: {} },
  pricing: {},
  ...over,
})
const state = { localModels: ['qwen3:0.6b'] }
const persona = { id: 'p', requirements: {}, model: {} }
const SPECS = {
  'hosted/big-model': { contextWindow: 200000, input: ['text', 'image'], reasoning: true, cost: { input: 3, output: 15 } },
  'hosted/cheap-model': { contextWindow: 128000, input: ['text'], reasoning: false, cost: { input: 0.1, output: 0.4 } },
}
const specFor = (route, model) => SPECS[`${route}/${model}`]
const keys = r => r.ranked.map(c => c.key)
const tmp = () => mkdtempSync(join(tmpdir(), 'finess-router-'))

// ------------------------------------------------------------------------------ requirements

test('tier is an input: it adds minimums and never names a model', () => {
  for (const need of Object.values(TIER_REQUIREMENTS)) {
    for (const v of Object.values(need)) assert.ok(['none', 'low', 'medium', 'high'].includes(v))
  }
  assert.deepEqual(routerRequirements(makeCfg(), persona, 'frontier').need, { reasoning: 'high', tool_calling: 'high' })
  assert.deepEqual(routerRequirements(makeCfg(), persona, undefined), { need: {}, warnings: [] })
})

test('requirements: persona and tier merge to the stricter value per key', () => {
  const p = { ...persona, requirements: { tool_calling: 'high', context: 100000, vision: 'low' } }
  assert.deepEqual(routerRequirements(makeCfg(), p, 'local_large').need, { tool_calling: 'high', reasoning: 'medium', context: 100000, vision: 'low' })
})

test('requirements: an unknown tier warns and applies only the persona', () => {
  const r = routerRequirements(makeCfg(), { ...persona, requirements: { code: 'low' } }, 'galactic')
  assert.deepEqual(r.need, { code: 'low' })
  assert.match(r.warnings[0], /unknown tier "galactic"/)
})

test('requirements: models.tiers overrides a tier; an invalid override keeps the default with a warning', () => {
  assert.deepEqual(routerRequirements(makeCfg({ models: { tiers: { local_small: { code: 'medium' } } } }), persona, 'local_small').need, { code: 'medium' })
  const bad = routerRequirements(makeCfg({ models: { tiers: { local_small: { codee: 'medium' } } } }), persona, 'local_small')
  assert.deepEqual(bad.need, TIER_REQUIREMENTS.local_small)
  assert.match(bad.warnings[0], /models\.tiers\.local_small\.codee: unknown capability "codee" — did you mean "code"\?/)
})

test('persona models.requirements reach the router through loadPersonas (validated at load)', () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'vis.json'), JSON.stringify({ id: 'vis', models: { requirements: { vision: 'medium', context: 100000 } } }))
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ id: 'bad', models: { requirements: { vison: 'high' } } }))
    const ps = loadPersonas({ personas: {} }, { dir })
    assert.deepEqual(ps.get('vis').requirements, { vision: 'medium', context: 100000 })
    assert.match(ps.get('bad').broken, /unknown capability "vison" — did you mean "vision"\?/)
    const r = routeByCapability(makeCfg(), { state, persona: ps.get('vis'), specFor, tier: 'local_small' })
    assert.deepEqual(keys(r), ['hosted/big-model'], 'only the catalog model with image input and 200k context')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ------------------------------------------------------------------------------ capabilities

test('capabilitiesFromSpec: context, vision and cost from the catalog; levels are labelled heuristic', () => {
  const c = capabilitiesFromSpec(SPECS['hosted/big-model'])
  assert.deepEqual(c.caps, { context: 200000, vision: 'high', reasoning: 'high', code: 'high', tool_calling: 'high', structured_output: 'high' })
  assert.deepEqual([c.from.context, c.from.vision, c.from.reasoning, c.from.tool_calling], ['catalog', 'catalog', 'heuristic', 'heuristic'])
  assert.equal(c.costPer1M, 18)
  assert.equal(capabilitiesFromSpec(SPECS['hosted/cheap-model']).caps.reasoning, 'medium')
  assert.deepEqual(capabilitiesFromSpec(undefined), { caps: {}, from: {} })
  assert.equal(capabilitiesFromSpec({ cost: { input: 'x' } }).costPer1M, undefined)
})

test('localCapabilities: by parameter count, agreeing with the small-model note', () => {
  assert.equal(localCapabilities('qwen3:0.6b', {}).caps.tool_calling, 'low')
  assert.equal(localCapabilities('qwen3:8b', {}).caps.tool_calling, 'medium')
  assert.equal(localCapabilities('llama3.1:70b', {}).caps.reasoning, 'high')
  assert.equal(localCapabilities('mystery', {}).caps.code, 'medium')
  assert.equal(localCapabilities('qwen3:8b', {}).caps.vision, 'none')
  assert.deepEqual([localCapabilities('x', {}).caps.context, localCapabilities('x', {}).from.context], [LOCAL_CONTEXT_DEFAULT, 'default'])
  assert.deepEqual([localCapabilities('x', { contextWindow: 8192 }).caps.context, localCapabilities('x', { contextWindow: 8192 }).from.context], [8192, 'route'])
})

test('parseCapabilityEntry: capability keys plus latencyMs; errors carry the config path', () => {
  assert.deepEqual(parseCapabilityEntry({ code: 'high', context: 1000, latencyMs: 300 }, 'a/b'), { caps: { code: 'high', context: 1000 }, latencyMs: 300 })
  assert.match(parseCapabilityEntry({ code: 'great' }, 'a/b').error, /^models\.capabilities\.a\/b\.code: expected one of/)
  assert.match(parseCapabilityEntry({ latencyMs: -1 }, 'k').error, /latencyMs: expected a non-negative number/)
  assert.match(parseCapabilityEntry([], 'k').error, /expected an object/)
})

test('models.capabilities wins over catalog and heuristic, `route/model` over `model`', () => {
  const cfg = makeCfg({ models: { capabilities: { 'qwen3:0.6b': { tool_calling: 'high', reasoning: 'high' }, 'local/qwen3:0.6b': { tool_calling: 'medium' } } } })
  const r = routeByCapability(cfg, { state, persona, specFor, tier: 'local_small' })
  const small = r.ranked.find(c => c.key === 'local/qwen3:0.6b')
  assert.equal(small.caps.tool_calling, 'medium')
  assert.equal(small.from.tool_calling, 'config')
  assert.equal(small.caps.reasoning, 'low', 'the model-only entry is not merged when a route/model entry exists')
})

test('an invalid models.capabilities entry is ignored with a warning, never a throw', () => {
  const r = routeByCapability(makeCfg({ models: { capabilities: { 'qwen3:8b': { reasonng: 'high' } } } }), { state, persona, specFor, tier: 'local_small' })
  assert.match(r.warnings.join('\n'), /models\.capabilities\.qwen3:8b\.reasonng: unknown capability .* - entry ignored/)
  assert.ok(keys(r).includes('local/qwen3:8b'))
})

// ------------------------------------------------------------------------------ candidates and cost

test('candidates: local models, each route\'s selected model, session model, fallbacks and persona preset, deduplicated', () => {
  const cfg = makeCfg({ model: { ...makeCfg().model, fallback: [{ route: 'hosted', id: 'cheap-model' }, { route: 'nowhere', id: 'x' }, { route: 'local', id: 'qwen3:8b' }] } })
  const p = { ...persona, model: { route: 'gateway', id: 'gw-strong' } }
  const c = routerCandidates(cfg, { state: { ...state, route: 'hosted', model: 'pinned', modelRoute: 'hosted' }, persona: p }).map(x => `${x.route}/${x.model}`)
  assert.deepEqual(c, ['local/qwen3:8b', 'local/qwen3:0.6b', 'hosted/big-model', 'gateway/gw-model', 'hosted/pinned', 'hosted/cheap-model', 'gateway/gw-strong'])
})

test('candidateCost: pricing route/model over route over catalog; local is free; unknown otherwise', () => {
  const cfg = makeCfg({ pricing: { hosted: { inputPer1M: 1, outputPer1M: 2 }, 'hosted/big-model': { inputPer1M: 5, outputPer1M: 5 } } })
  const routes = { hosted: { kind: 'catalog' }, local: { kind: 'local' }, gateway: { kind: 'declared' } }
  assert.deepEqual(candidateCost(cfg, { route: 'hosted', model: 'big-model', spec: routes.hosted }, 18), { cost: 10, from: 'pricing' })
  assert.deepEqual(candidateCost(cfg, { route: 'hosted', model: 'other', spec: routes.hosted }, 18), { cost: 3, from: 'pricing' })
  assert.deepEqual(candidateCost(makeCfg(), { route: 'hosted', model: 'x', spec: routes.hosted }, 0.5), { cost: 0.5, from: 'catalog' })
  assert.deepEqual(candidateCost(makeCfg(), { route: 'local', model: 'x', spec: routes.local }, undefined), { cost: 0, from: 'local' })
  assert.deepEqual(candidateCost(makeCfg(), { route: 'gateway', model: 'x', spec: routes.gateway }, undefined), {})
})

// ------------------------------------------------------------------------------ ranking

test('eligibility: capability gaps name the shortfall and where the value came from', () => {
  const r = routeByCapability(makeCfg(), { state, persona, specFor, tier: 'frontier' })
  assert.deepEqual(keys(r), ['hosted/big-model'])
  const why = Object.fromEntries(r.ineligible.map(x => [x.key, x.why]))
  assert.deepEqual(why['local/qwen3:8b'], ['reasoning: medium < high (heuristic)', 'tool_calling: medium < high (heuristic)'])
  assert.deepEqual(why['gateway/gw-model'], ['reasoning: none < high (unknown)', 'tool_calling: none < high (unknown)'], 'a declared route without capabilities is never assumed capable')
})

test('a context minimum uses the declared route window when no catalog spec exists', () => {
  const p = { ...persona, requirements: { context: 60000 } }
  const cfg = makeCfg({ models: { capabilities: { 'gateway/gw-model': { tool_calling: 'high' } } } })
  const r = routeByCapability(cfg, { state, persona: p, specFor, tier: 'local_small' })
  assert.deepEqual(keys(r), ['hosted/big-model', 'gateway/gw-model'], 'local 32k is too small; gateway 64k and hosted 200k qualify; unknown cost sorts last')
  assert.equal(r.ranked[1].from.context, 'route')
})

test('tie-break: cheapest first, then configured latency, then smaller model, then what already runs', () => {
  const r = routeByCapability(makeCfg(), { state, persona, specFor, tier: 'local_small' })
  assert.deepEqual(keys(r), ['local/qwen3:0.6b', 'local/qwen3:8b', 'hosted/big-model'])
  assert.equal(r.pick.key, 'local/qwen3:0.6b')
  assert.match(r.pick.reasons.join('|'), /meets tool_calling low \(low, heuristic\)\|cost 0\/1M \(local\)\|ranked first of 3 eligible/)

  const lat = makeCfg({ models: { capabilities: { 'qwen3:0.6b': { latencyMs: 900 }, 'qwen3:8b': { latencyMs: 200 } } } })
  assert.deepEqual(keys(routeByCapability(lat, { state, persona, specFor, tier: 'local_small' })).slice(0, 2), ['local/qwen3:8b', 'local/qwen3:0.6b'])

  const same = makeCfg({ model: { ...makeCfg().model, id: 'alpha' } })
  const s2 = { localModels: ['beta'] }
  assert.equal(routeByCapability(same, { state: s2, persona, specFor, tier: 'local_small' }).pick.key, 'local/alpha')
  assert.equal(routeByCapability(same, { state: s2, persona, specFor, tier: 'local_small', actual: 'local/beta' }).pick.key, 'local/beta')
})

test('no requirements at all: every candidate is eligible', () => {
  const r = routeByCapability(makeCfg(), { state, persona, specFor })
  assert.equal(r.ineligible.length, 0)
  assert.equal(r.tier, undefined)
  assert.equal(r.ranked[0].reasons[0], 'no requirements')
})

test('availability facts: a missing key or a down engine makes a model ineligible; no facts = not checked', () => {
  const r = routeByCapability(makeCfg(), { state, persona, specFor, tier: 'local_small', facts: { env: {}, engineUp: false } })
  assert.equal(r.pick, undefined)
  const why = Object.fromEntries(r.ineligible.map(x => [x.key, x.why[0]]))
  assert.equal(why['local/qwen3:8b'], 'unavailable: local engine not answering')
  assert.equal(why['hosted/big-model'], 'unavailable: HOSTED_API_KEY not set')
  const up = routeByCapability(makeCfg(), { state, persona, specFor, tier: 'frontier', facts: { env: { HOSTED_API_KEY: 'k' } } })
  assert.equal(up.pick.key, 'hosted/big-model')
})

test('policy: models.deny removes a route or a model; models.pin is obeyed and says what it overrides', () => {
  const denied = routeByCapability(makeCfg({ models: { deny: ['local/qwen3:0.6b', 'hosted'] } }), { state, persona, specFor, tier: 'local_small' })
  assert.deepEqual(keys(denied), ['local/qwen3:8b'])
  assert.deepEqual(denied.ineligible.filter(x => x.key !== 'gateway/gw-model').map(x => x.why), [['denied by models.deny'], ['denied by models.deny']])

  const pinned = routeByCapability(makeCfg({ models: { pin: 'local/qwen3:0.6b' } }), { state, persona, specFor, tier: 'frontier' })
  assert.equal(pinned.pick.key, 'local/qwen3:0.6b')
  assert.match(pinned.pick.reasons[0], /^pinned by models\.pin, despite: reasoning: low < high/)

  const ghost = routeByCapability(makeCfg({ models: { pin: 'nowhere/x' } }), { state, persona, specFor, tier: 'local_small' })
  assert.equal(ghost.pick.key, 'local/qwen3:0.6b')
  assert.match(ghost.warnings[0], /models\.pin "nowhere\/x" is not a known route\/model - ignored/)
})

test('advisory: the router is pure - config and state come back untouched', () => {
  const cfg = makeCfg({ models: { pin: 'hosted/big-model', capabilities: { 'qwen3:8b': { code: 'high' } } } })
  const st = structuredClone(state)
  const before = JSON.stringify([cfg, st, persona])
  routeByCapability(cfg, { state: st, persona, specFor, tier: 'frontier', facts: { env: {} } })
  assert.equal(JSON.stringify([cfg, st, persona]), before)
})

// ------------------------------------------------------------------------------ shadow log and /routing

test('routerRecord: pick next to actual, agreement flag, warnings only when present', () => {
  const r = routeByCapability(makeCfg(), { state, persona, specFor, tier: 'local_small' })
  const rec = routerRecord(r, { task: 'x'.repeat(600), actual: 'local/qwen3:8b', persona: 'p' })
  assert.deepEqual([rec.source, rec.tier, rec.tierFrom, rec.pick, rec.actual, rec.agree, rec.eligible, rec.ineligible, rec.persona], ['repl', 'local_small', 'rules', 'local/qwen3:0.6b', 'local/qwen3:8b', false, 3, 1, 'p'])
  assert.equal(rec.task.length, 500)
  assert.equal(rec.warnings, undefined)
  const none = routerRecord(routeByCapability(makeCfg(), { state, persona, tier: 'frontier' }), { task: 't', actual: 'local/qwen3:8b' })
  assert.deepEqual([none.pick, none.agree, none.reasons], [null, false, []])
})

test('shadow log: lives under decisions/router, invisible to the Laya readers and labeller', () => {
  const dir = tmp()
  try {
    const rdir = routerDir(dir)
    assert.equal(rdir, join(dir, 'router'))
    const r = routeByCapability(makeCfg(), { state, persona, specFor, tier: 'local_small' })
    logRouterShadow(routerRecord(r, { task: 'a', actual: 'local/qwen3:0.6b' }), rdir)
    logRouterShadow(routerRecord(r, { task: 'b', actual: 'local/qwen3:8b' }), rdir)
    mkdirSync(rdir, { recursive: true })
    writeFileSync(join(rdir, '2000-01-01.jsonl'), '{torn\n', { flag: 'a' })
    const recs = readRouterRecords(rdir)
    assert.equal(recs.length, 2)
    assert.equal(recs[0].v, 1)
    assert.match(recs[0].id, /^[0-9a-f]{12}$/)
    assert.deepEqual(readDecisionRecords(dir), [])
    assert.deepEqual(readShadow(dir), [])
    assert.deepEqual(readRouterRecords(join(dir, 'missing')), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('routerAgreement and routerRows: pick vs ran, newest first, * marks a difference', () => {
  const recs = [
    { at: '2026-10-01T10:00:00Z', task: 'one', tier: 'local_small', pick: 'l/a', actual: 'l/a', agree: true },
    { at: '2026-10-02T11:00:00Z', task: 'two', tier: 'frontier', pick: null, actual: 'l/a', agree: false },
    { at: '2026-10-03T12:00:00Z', task: 'three', tier: 'local_large', pick: 'h/b', actual: 'l/a', agree: false },
  ]
  assert.deepEqual(routerAgreement(recs), { agree: 1, n: 2, rate: 0.5, noPick: 1 })
  assert.deepEqual(routerAgreement([]), { agree: 0, n: 0, rate: null, noPick: 0 })
  assert.deepEqual(routerRows(recs, 2), [
    ['2026-10-03 12:00', 'three', 'local_large', 'h/b', 'l/a *'],
    ['2026-10-02 11:00', 'two', 'frontier', 'none eligible', 'l/a *'],
  ])
})

test('rankingLines: requirement, warnings, pick vs actual, eligible with reasons, then the rest', () => {
  const r = routeByCapability(makeCfg({ models: { capabilities: { 'qwen3:8b': { codee: 'x' } } } }), { state, persona, specFor, tier: 'frontier' })
  const L = rankingLines(r, 'local/qwen3:8b')
  assert.equal(L[0], 'tier frontier; needs reasoning high, tool_calling high (persona requirements are declared, advisory)')
  assert.match(L[1], /^warning: models\.capabilities\.qwen3:8b\.codee/)
  assert.equal(L[2], 'pick: hosted/big-model; actually runs: local/qwen3:8b')
  assert.match(L[3], /^ {2}1\. hosted\/big-model - meets reasoning high \(high, heuristic\)/)
  assert.ok(L.slice(4).every(l => l.startsWith('  -  ')))
})
