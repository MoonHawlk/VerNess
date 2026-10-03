/**
 * Route fallback (T-453): `chooseFallback` is pure over an injected engine probe, launcher state and
 * environment, so nothing here touches the network, `.finess/state.json` or the real `.env`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { chooseFallback, unavailableReason } from '../lib/routes.mjs'

const PERSONA = 'fallback-test-persona'
/**
 * @param {object} [over] - fields to override on the config.
 * @param {object} [personaModel] - the test persona's `model` preference.
 * @returns {object} a config with a local default, a keyed gateway and a catalog route.
 */
const makeCfg = (over = {}, personaModel = {}) => ({
  profile: { name: 'fallback-test', template: 'headless' },
  model: {
    route: 'local', id: 'small', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'LOCAL_KEY', apiKeyValue: 'placeholder',
    fallback: [{ route: 'gateway', id: 'gw-model' }, { route: 'hosted', id: 'hosted-model' }],
  },
  extraRoutes: {
    gateway: { api: 'openai-completions', baseURL: 'https://gateway.example/v1', id: 'gw-model', apiKeyEnv: 'GATEWAY_API_KEY' },
    hosted: { apiKeyEnv: 'HOSTED_API_KEY', model: 'hosted-model' },
  },
  activeRoute: '',
  personas: { active: PERSONA, definitions: { [PERSONA]: { prefix: 'P', suffix: 'S', model: personaModel } } },
  settings: { plugins: [], toolsMode: 'native' },
  tips: [],
  ...over,
})
const KEYS = { GATEWAY_API_KEY: 'k', HOSTED_API_KEY: 'k' }

test('chooseFallback: nothing changes when the list is empty or absent', () => {
  const cfg = makeCfg()
  cfg.model.fallback = []
  assert.equal(chooseFallback(cfg, { state: {}, env: KEYS, engineUp: false }).use, false)
  delete cfg.model.fallback
  assert.equal(chooseFallback(cfg, { state: {}, env: KEYS, engineUp: false }).use, false)
})

test('chooseFallback: a healthy default is kept', () => {
  const d = chooseFallback(makeCfg(), { state: {}, env: KEYS, engineUp: true })
  assert.equal(d.use, false)
  assert.equal(d.reason, undefined)
})

test('chooseFallback: local engine down picks the first usable entry and words the line', () => {
  const d = chooseFallback(makeCfg(), { state: {}, env: KEYS, engineUp: false })
  assert.equal(d.use, true)
  assert.equal(d.name, 'gateway')
  assert.equal(d.model, 'gw-model')
  assert.equal(d.line, 'default route local unavailable (local engine not answering) - using gateway/gw-model for this task')
})

test('chooseFallback: entries without their key are skipped, in order', () => {
  const d = chooseFallback(makeCfg(), { state: {}, env: { HOSTED_API_KEY: 'k' }, engineUp: false })
  assert.equal(d.name, 'hosted')
  assert.deepEqual(d.candidates.map(c => c.usable), [false, true])
  assert.match(d.candidates[0].why, /GATEWAY_API_KEY not set/)
})

test('chooseFallback: an unusable list leaves the default and says why', () => {
  const d = chooseFallback(makeCfg(), { state: {}, env: {}, engineUp: false })
  assert.equal(d.use, false)
  assert.equal(d.reason, 'local engine not answering')
})

test('chooseFallback: a hosted default without its key falls back to the local engine when it answers', () => {
  const cfg = makeCfg({ activeRoute: 'gateway' })
  cfg.model.fallback = [{ route: 'local', id: 'small' }]
  const d = chooseFallback(cfg, { state: {}, env: {}, engineUp: true })
  assert.equal(d.use, true)
  assert.equal(d.from, 'gateway')
  assert.match(d.line, /default route gateway unavailable \(GATEWAY_API_KEY not set\) - using local\/small/)
  assert.equal(chooseFallback(cfg, { state: {}, env: {}, engineUp: false }).use, false, 'engine down too: nothing usable')
})

test('chooseFallback: the default is never its own fallback; undeclared routes and malformed entries are ignored', () => {
  const cfg = makeCfg()
  cfg.model.fallback = [{ route: 'local', id: 'small' }, { route: 'nowhere', id: 'x' }, null, { route: 'hosted' }, { route: 'hosted', id: 'hosted-model' }]
  const d = chooseFallback(cfg, { state: {}, env: KEYS, engineUp: false })
  assert.equal(d.name, 'hosted')
  assert.equal(d.candidates.length, 3)
})

test('chooseFallback: an explicit session choice is never replaced', () => {
  assert.equal(chooseFallback(makeCfg(), { state: { model: 'other' }, env: KEYS, engineUp: false }).use, false, '/model')
  assert.equal(chooseFallback(makeCfg(), { state: { route: 'local' }, env: KEYS, engineUp: false }).use, false, '/api use')
})

test('chooseFallback: a persona preset is respected; the default under a keyless preset is replaceable', () => {
  const preset = chooseFallback(makeCfg({}, { route: 'hosted', id: 'p' }), { state: {}, env: KEYS, engineUp: false })
  assert.equal(preset.use, false, 'preset in force: not the default')
  const dropped = chooseFallback(makeCfg({}, { route: 'hosted', id: 'p' }), { state: {}, env: { GATEWAY_API_KEY: 'k' }, engineUp: false })
  assert.equal(dropped.use, true, 'preset dropped (no key): the default applies, so fallback may')
  assert.equal(dropped.name, 'gateway')
})

test('unavailableReason: local needs the engine, hosted needs its key unless a placeholder is configured', () => {
  assert.equal(unavailableReason({ kind: 'local' }, { engineUp: true, env: {} }), undefined)
  assert.match(unavailableReason({ kind: 'local' }, { engineUp: false, env: {} }), /engine/)
  assert.match(unavailableReason({ kind: 'catalog', apiKeyEnv: 'K' }, { engineUp: true, env: {} }), /K not set/)
  assert.match(unavailableReason({ kind: 'catalog', apiKeyEnv: 'K' }, { engineUp: true, env: { K: '' } }), /K not set/)
  assert.equal(unavailableReason({ kind: 'catalog', apiKeyEnv: 'K' }, { engineUp: true, env: { K: 'v' } }), undefined)
  assert.equal(unavailableReason({ kind: 'declared', apiKeyEnv: 'K', apiKeyValue: 'p' }, { engineUp: true, env: {} }), undefined)
})
