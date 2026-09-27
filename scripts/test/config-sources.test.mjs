/**
 * `/config` source attribution (T-180): each value is owned by the layer that set it — built-in
 * default, `verness.config.json`, `.verness/state.json`, a persona file or the environment — and a
 * credential is never shown, however deeply it is nested.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SOURCE, formatValue, isSecretKey, maskSecrets, resolvedRows, settingRows } from '../lib/config-sources.mjs'

const HIDDEN = '******** (hidden)'
const cfg = {
  model: { route: 'local', id: 'small', apiKeyEnv: 'LOCAL_KEY', apiKeyValue: 'placeholder', maxTokens: 4096 },
  extraRoutes: { hosted: { baseURL: 'https://x', apiKeyValue: 'sk-abcdefghijklmnopqrstuvwxyz' } },
  activeRoute: '',
  personas: { active: 'generalist', definitions: {} },
  pricing: { hosted: 1 },
}
// The file sets only some fields; everything else came from the defaults.
const raw = { model: { id: 'small' }, extraRoutes: cfg.extraRoutes, pricing: cfg.pricing }
const byKey = rows => Object.fromEntries(rows.map(r => [r.key, r]))

test('a field is the file\'s when the file sets it, a default otherwise', () => {
  const rows = byKey(settingRows(cfg, raw))
  assert.equal(rows['model.id'].source, SOURCE.file)
  assert.equal(rows['model.route'].source, SOURCE.default)
  assert.equal(rows['personas.active'].source, SOURCE.default)
  assert.equal(rows['extraRoutes.hosted'].source, SOURCE.file)
  assert.equal(rows['pricing.hosted'].source, SOURCE.file, 'a section only the file has is the file\'s')
  assert.equal(rows.activeRoute.source, SOURCE.default)
  // No config file at all: everything is a default.
  assert.ok(settingRows(cfg, undefined).every(r => r.source === SOURCE.default))
})

test('credentials are masked at any depth; key-variable names and numbers are not', () => {
  const rows = byKey(settingRows(cfg, raw))
  assert.equal(rows['model.apiKeyValue'].value, HIDDEN)
  assert.equal(rows['model.apiKeyEnv'].value, 'LOCAL_KEY')
  assert.equal(rows['model.maxTokens'].value, 4096)
  assert.equal(rows['extraRoutes.hosted'].value.apiKeyValue, HIDDEN)
  assert.ok(!JSON.stringify(settingRows(cfg, raw)).includes('sk-abc'), 'no secret survives anywhere')
  assert.deepEqual(maskSecrets({ note: 'ghp_0123456789abcdefghij', list: [{ token: 't' }] }), { note: HIDDEN, list: [{ token: HIDDEN }] })
  assert.equal(isSecretKey('authToken'), true)
  assert.equal(isSecretKey('apiKeyEnv'), false)
})

test('state, persona and environment own what they override', () => {
  const persona = { id: 'scientist', source: 'personas/scientist.json', model: { id: 'big' } }
  const state = { persona: 'scientist', access: 'read-only', apiRoutes: { hosted: { apiKey: 'secret-value' } } }
  const rows = byKey(resolvedRows({
    cfg, raw, state, persona,
    effective: { name: 'local', model: 'big', source: 'persona scientist' },
    access: 'read-only', accessEnv: undefined,
  }))
  assert.equal(rows.persona.source, SOURCE.state)
  assert.equal(rows.route.source, SOURCE.default)
  assert.equal(rows.model.value, 'big')
  assert.equal(rows.model.source, 'persona file personas/scientist.json')
  assert.equal(rows.access.source, SOURCE.state)
  assert.equal(rows.session.source, SOURCE.default)
  assert.equal(rows['state.apiRoutes'].source, SOURCE.state)
  assert.equal(rows['state.apiRoutes'].value.hosted.apiKey, HIDDEN)

  const over = byKey(resolvedRows({
    cfg, raw, state: { model: 'tiny', route: 'local' }, persona: undefined,
    effective: { name: 'local', model: 'tiny', source: '/model override' },
    access: 'full', accessEnv: 'full',
  }))
  assert.equal(over.model.source, SOURCE.state)
  assert.equal(over.route.source, SOURCE.state)
  assert.match(over.access.source, /^environment/)

  const plain = byKey(resolvedRows({
    cfg, raw, state: {}, persona: undefined,
    effective: { name: 'local', model: 'small', source: 'route default' },
    access: 'workspace-write', accessEnv: undefined,
  }))
  assert.equal(plain.model.source, SOURCE.file, 'the route default model comes from model.id, set in the file')
})

test('formatValue keeps short values and summarizes long ones', () => {
  assert.equal(formatValue('abc'), 'abc')
  assert.equal(formatValue(''), '""')
  assert.equal(formatValue(undefined), '(unset)')
  assert.equal(formatValue([1, 2]), '[1,2]')
  assert.equal(formatValue(Array.from({ length: 40 }, (_, i) => `item-${i}`)), '[40 items]')
  assert.equal(formatValue({ a: 'x'.repeat(80), b: 1 }), '{ a, b }')
})
