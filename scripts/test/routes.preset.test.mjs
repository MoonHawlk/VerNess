/**
 * Persona model presets (T-361): precedence (session choice > persona preset > config default), the
 * fallback for a preset that cannot run, and the per-task overlay a team run writes. Every test passes
 * its own state, persona and environment, so neither `.finess/state.json` nor the real `.env` is read.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writePersonaOverlay } from '../lib/personas.mjs'
import { effectiveRoute } from '../lib/routes.mjs'

const cfg = {
  profile: { name: 'preset-test', template: 'headless' },
  model: { route: 'local', id: 'small', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'LOCAL_KEY', apiKeyValue: 'placeholder' },
  extraRoutes: { hosted: { apiKeyEnv: 'HOSTED_API_KEY', model: 'hosted-default' } },
  activeRoute: '',
  personas: { active: 'worker', definitions: { worker: { prefix: '', suffix: '' } } },
  settings: { plugins: [], toolsMode: 'native' },
  tips: [],
}
const reviewer = { id: 'rev', prefix: '', suffix: '', tips: [], model: { route: 'hosted', id: 'strong' } }
const keyed = { HOSTED_API_KEY: 'k' }

test('preset: applies for the persona it is given, over the config default', () => {
  const e = effectiveRoute(cfg, { state: {}, persona: reviewer, env: keyed })
  assert.deepEqual([e.name, e.model, e.preset, e.warning], ['hosted', 'strong', true, undefined])
  const plain = effectiveRoute(cfg, { state: {}, persona: { id: 'w', model: {} }, env: keyed })
  assert.deepEqual([plain.name, plain.model, plain.preset], ['local', 'small', undefined])
})

test('preset: a session /api use choice beats it', () => {
  const e = effectiveRoute(cfg, { state: { route: 'local' }, persona: reviewer, env: keyed })
  assert.deepEqual([e.name, e.model, e.preset], ['local', 'small', undefined])
})

test('preset: an explicit /model on the preset route beats the preset model', () => {
  const state = { route: 'hosted', model: 'mine', modelRoute: 'hosted' }
  const e = effectiveRoute(cfg, { state, persona: reviewer, env: keyed })
  assert.deepEqual([e.model, e.source], ['mine', '/model override'])
})

test('preset: an unknown route falls back to the default with one warning, no error', () => {
  const e = effectiveRoute(cfg, { state: {}, persona: { id: 'p', model: { route: 'nowhere', id: 'x' } }, env: {} })
  assert.deepEqual([e.name, e.model, e.error, e.preset], ['local', 'small', undefined, undefined])
  assert.match(e.warning, /persona p: model route "nowhere" is not declared/)
})

test('preset: a route whose key is not set falls back to the default with a warning', () => {
  const e = effectiveRoute(cfg, { state: {}, persona: reviewer, env: {} })
  assert.deepEqual([e.name, e.model, e.error, e.preset], ['local', 'small', undefined, undefined])
  assert.match(e.warning, /needs HOSTED_API_KEY/)
})

test('overlay: pins the model only when the preset is in force', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finess-overlay-'))
  const written = (name, state, env) => readFileSync(writePersonaOverlay(reviewer, cfg, join(dir, name), effectiveRoute(cfg, { state, persona: reviewer, env })), 'utf8')
  try {
    assert.match(written('a.yml', {}, keyed), /provider: hosted\n\s+model: 'strong'/)
    assert.doesNotMatch(written('b.yml', {}, {}), /agent-default-model/, 'unusable preset: no pin')
    assert.doesNotMatch(written('c.yml', { route: 'local' }, keyed), /agent-default-model/, 'session route: no pin')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
