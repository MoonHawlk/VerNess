/**
 * Model routes (T-365): `parseRef` for `/models add`, the precedence `effectiveRoute` applies, how a
 * catalog route is rendered into the profile patch, and `.env` parsing. Every test passes its own
 * launcher state and environment, so neither `.finess/state.json` nor the real `.env` is read.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseRef } from '../commands/models.mjs'
import { applyDotEnv, effectiveRoute, knownRoutes, loadDotEnv, localModels } from '../lib/routes.mjs'
import { renderPatch } from '../finess.mjs'

// ------------------------------------------------------------------------------ parseRef

test('parseRef: registry names have no slash, with or without a tag', () => {
  assert.deepEqual(parseRef('qwen3:1.7b'), { kind: 'registry', name: 'qwen3:1.7b' })
  assert.deepEqual(parseRef('  llama3  '), { kind: 'registry', name: 'llama3' })
})

test('parseRef: Hugging Face repos, with the hf.co/huggingface.co prefix optional and the quant split off', () => {
  assert.deepEqual(parseRef('Qwen/Qwen3-0.6B-GGUF'), { kind: 'hf', repo: 'Qwen/Qwen3-0.6B-GGUF', quant: undefined })
  assert.deepEqual(parseRef('Qwen/Qwen3-0.6B-GGUF:Q8_0'), { kind: 'hf', repo: 'Qwen/Qwen3-0.6B-GGUF', quant: 'Q8_0' })
  assert.deepEqual(parseRef('hf.co/Qwen/Qwen3-0.6B-GGUF:Q4_K_M'), { kind: 'hf', repo: 'Qwen/Qwen3-0.6B-GGUF', quant: 'Q4_K_M' })
  assert.deepEqual(parseRef('HuggingFace.co/org/repo'), { kind: 'hf', repo: 'org/repo', quant: undefined })
  assert.deepEqual(parseRef('org/repo:'), { kind: 'hf', repo: 'org/repo', quant: undefined }, 'an empty quant is no quant')
})

test('parseRef: a pasted URL yields the repo and nothing after it', () => {
  assert.deepEqual(parseRef('https://huggingface.co/Qwen/Qwen3-0.6B-GGUF'), { kind: 'hf', repo: 'Qwen/Qwen3-0.6B-GGUF' })
  assert.deepEqual(parseRef('https://www.huggingface.co/org/repo/tree/main?x=1'), { kind: 'hf', repo: 'org/repo' })
  assert.deepEqual(parseRef('http://hf.co/org/repo#readme'), { kind: 'hf', repo: 'org/repo' })
})

// ------------------------------------------------------------------- effectiveRoute precedence

// The persona is an inline config definition under an id no personas/ file uses, so the repo's
// persona files cannot change what these tests see.
const PERSONA = 'routes-test-persona'
/**
 * @param {object} [over] - fields to override.
 * @param {object} [personaModel] - the test persona's `model` preference.
 * @returns {object} a minimal configuration with a local route and two extra routes.
 */
const makeCfg = (over = {}, personaModel = {}) => ({
  profile: { name: 'routes-test', template: 'headless' },
  model: { route: 'local', id: 'small', source: 'hf.co/org/small:Q8_0', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'LOCAL_KEY', apiKeyValue: 'placeholder' },
  extraRoutes: {
    gateway: { api: 'openai-completions', baseURL: 'https://gateway.example/v1', id: 'gw-model', models: ['gw-other'], apiKeyEnv: 'GATEWAY_API_KEY' },
    hosted: { apiKeyEnv: 'HOSTED_API_KEY', model: 'hosted-model' },
  },
  activeRoute: '',
  personas: { active: PERSONA, definitions: { [PERSONA]: { prefix: 'P', suffix: 'S', model: personaModel } } },
  settings: { plugins: [], toolsMode: 'native' },
  tips: [],
  ...over,
})

test('effectiveRoute: no choice anywhere means the local route and its configured model', () => {
  const e = effectiveRoute(makeCfg(), { state: {} })
  assert.equal(e.name, 'local')
  assert.equal(e.model, 'small')
  assert.equal(e.source, 'route default')
  assert.equal(e.error, undefined)
})

test('effectiveRoute: route precedence is state, then persona, then activeRoute, then model.route', () => {
  assert.equal(effectiveRoute(makeCfg({ activeRoute: 'gateway' }), { state: {} }).name, 'gateway')
  assert.equal(effectiveRoute(makeCfg({ activeRoute: 'gateway' }, { route: 'hosted' }), { state: {} }).name, 'hosted', 'persona beats activeRoute')
  assert.equal(effectiveRoute(makeCfg({ activeRoute: 'gateway' }, { route: 'hosted' }), { state: { route: 'local' } }).name, 'local', 'state beats persona')
  assert.equal(effectiveRoute(makeCfg({ activeRoute: undefined }), { state: {} }).name, 'local', 'an absent activeRoute is the local route')
})

test('effectiveRoute: a state persona override picks whose preference applies', () => {
  const cfg = makeCfg({}, { route: 'hosted' })
  cfg.personas.definitions.other = { model: { route: 'gateway' } }
  assert.equal(effectiveRoute(cfg, { state: {} }).name, 'hosted')
  assert.equal(effectiveRoute(cfg, { state: { persona: 'other' } }).name, 'gateway')
})

test('effectiveRoute: a route nobody declared is an error that falls back to the local spec', () => {
  const e = effectiveRoute(makeCfg(), { state: { route: 'nowhere' } })
  assert.equal(e.name, 'nowhere')
  assert.equal(e.source, 'none')
  assert.equal(e.model, undefined)
  assert.equal(e.route.kind, 'local')
  assert.match(e.error, /route "nowhere" is not declared/)
})

test('effectiveRoute: a /model override applies only to the route it was chosen for', () => {
  const onGateway = { route: 'gateway', model: 'gw-other', modelRoute: 'gateway' }
  assert.deepEqual(
    (({ name, model, source }) => ({ name, model, source }))(effectiveRoute(makeCfg(), { state: onGateway })),
    { name: 'gateway', model: 'gw-other', source: '/model override' },
  )
  // The same override, but the run is on another route: never sent there (the old UNKNOWN_MODEL).
  const e = effectiveRoute(makeCfg(), { state: { ...onGateway, route: 'hosted' } })
  assert.equal(e.model, 'hosted-model')
  assert.equal(e.source, 'route default')
})

test('effectiveRoute: a legacy override without modelRoute can only have meant the local route', () => {
  assert.equal(effectiveRoute(makeCfg(), { state: { model: 'legacy' } }).model, 'legacy')
  assert.equal(effectiveRoute(makeCfg(), { state: { model: 'legacy', route: 'gateway' } }).model, 'gw-model')
})

test('effectiveRoute: a persona model applies on its own route, and beats the route default but not /model', () => {
  const cfg = makeCfg({}, { route: 'gateway', id: 'persona-model' })
  assert.equal(effectiveRoute(cfg, { state: {} }).model, 'persona-model')
  assert.equal(effectiveRoute(cfg, { state: {} }).source, `persona ${PERSONA}`)
  assert.equal(effectiveRoute(cfg, { state: { model: 'mine', modelRoute: 'gateway' } }).model, 'mine')
  // Chosen route differs from the persona's: the persona model is not carried over.
  assert.equal(effectiveRoute(cfg, { state: { route: 'hosted' } }).model, 'hosted-model')
  // A persona model without a route is bound to the local route.
  const local = makeCfg({}, { id: 'persona-local' })
  assert.equal(effectiveRoute(local, { state: {} }).model, 'persona-local')
  assert.equal(effectiveRoute(local, { state: { route: 'gateway' } }).model, 'gw-model')
})

test('effectiveRoute: a catalog route with no model selected says how to pick one', () => {
  const cfg = makeCfg()
  delete cfg.extraRoutes.hosted.model
  const e = effectiveRoute(cfg, { state: { route: 'hosted' } })
  assert.equal(e.model, undefined)
  assert.match(e.error, /route "hosted" has no model selected — run \/api use hosted <model>/)
})

test('knownRoutes: kinds, and /api use routes from state never shadow a config entry', () => {
  const state = { apiRoutes: { added: { apiKeyEnv: 'ADDED_API_KEY', model: 'a1' }, hosted: { apiKeyEnv: 'X', model: 'from-state' } } }
  const routes = knownRoutes(makeCfg(), { state })
  assert.equal(routes.local.kind, 'local')
  assert.equal(routes.gateway.kind, 'declared')
  assert.equal(routes.hosted.kind, 'catalog')
  assert.equal(routes.hosted.model, 'hosted-model', 'the config entry wins')
  assert.equal(routes.added.kind, 'catalog')
  assert.equal(effectiveRoute(makeCfg(), { state: { ...state, route: 'added' } }).model, 'a1')
})

test('localModels: configured source and id, every /models add, and a local /model override', () => {
  assert.deepEqual(localModels(makeCfg(), { state: {} }), ['hf.co/org/small:Q8_0', 'small'])
  assert.deepEqual(localModels(makeCfg(), { state: { localModels: ['extra', 'small'], model: 'chosen' } }), ['hf.co/org/small:Q8_0', 'small', 'extra', 'chosen'])
  // An override for another route is not served by the local engine.
  assert.deepEqual(localModels(makeCfg(), { state: { model: 'gw-other', modelRoute: 'gateway' } }), ['hf.co/org/small:Q8_0', 'small'])
})

// ------------------------------------------------------------------- catalog route in the patch

/**
 * @param {string} patch - rendered patch text.
 * @param {string} name - provider name.
 * @returns {string[]} the lines of that provider's block under `providers:`.
 */
function providerBlock(patch, name) {
  const lines = patch.split('\n')
  const start = lines.indexOf(`          ${name}:`)
  assert.notEqual(start, -1, `provider ${name} is rendered`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(l => !l.startsWith('           '))
  return rest.slice(0, end === -1 ? rest.length : end)
}

test('renderPatch: a catalog route names only its key variable, so the adapter catalog is not replaced', () => {
  const state = { route: 'hosted', apiRoutes: { added: { apiKeyEnv: 'ADDED_API_KEY', model: 'a1' } } }
  const patch = renderPatch(makeCfg(), { surface: 'headless', state })
  for (const name of ['hosted', 'added']) {
    const block = providerBlock(patch, name)
    assert.ok(block.some(l => l.trim().startsWith('apiKeyEnv: ')), `${name} names its key variable`)
    for (const field of ['api:', 'baseURL:', 'models:', 'defaultContextWindow:']) {
      assert.ok(!block.some(l => l.trim().startsWith(field)), `${name} has no ${field}`)
    }
  }
  assert.deepEqual(providerBlock(patch, 'hosted').map(l => l.trim()), ["displayName: 'hosted'", 'apiKeyEnv: HOSTED_API_KEY'])
  assert.match(patch, /- id: agent-default-model\n {2}config:\n {4}provider: hosted\n {4}model: 'hosted-model'\n/)
  assert.match(patch, /# Model chosen by: route default\./)
})

test('renderPatch: declared and local routes restate endpoint, protocol and models', () => {
  const patch = renderPatch(makeCfg(), { surface: 'headless', state: { localModels: ['extra'] } })
  const gateway = providerBlock(patch, 'gateway').map(l => l.trim())
  assert.ok(gateway.includes('api: openai-completions'))
  assert.ok(gateway.includes("baseURL: 'https://gateway.example/v1'"))
  assert.ok(gateway.includes("- id: 'gw-model'") && gateway.includes("- id: 'gw-other'"))
  const local = providerBlock(patch, 'local').map(l => l.trim())
  for (const id of ['hf.co/org/small:Q8_0', 'small', 'extra']) assert.ok(local.includes(`- id: '${id}'`), `local serves ${id}`)
  assert.match(patch, /provider: local\n {4}model: 'small'\n/)
})

// ------------------------------------------------------------------------------ .env parsing

test('applyDotEnv: export prefixes, quotes, comments, CRLF and blank or invalid lines', () => {
  const env = {}
  const text = [
    '# a comment line',
    'PLAIN=value',
    'export EXPORTED=yes',
    '  SPACED  =  padded',
    'DOUBLE="quoted # not a comment"',
    "SINGLE='single'",
    'COMMENTED=abc # trailing comment',
    'HASH=a#b',
    'EMPTY=',
    'not a line',
    '1BAD=x',
    'WIN=crlf',
    '',
  ].join('\r\n')
  const loaded = applyDotEnv(text, env)
  assert.deepEqual(env, {
    PLAIN: 'value', EXPORTED: 'yes', SPACED: 'padded', DOUBLE: 'quoted # not a comment', SINGLE: 'single',
    COMMENTED: 'abc', HASH: 'a#b', WIN: 'crlf',
  })
  assert.deepEqual(loaded, ['PLAIN', 'EXPORTED', 'SPACED', 'DOUBLE', 'SINGLE', 'COMMENTED', 'HASH', 'WIN'])
})

test('applyDotEnv: a variable the shell already set wins, and is not reported as loaded', () => {
  const env = { KEEP: 'shell', BLANK: '' }
  assert.deepEqual(applyDotEnv('KEEP=file\nBLANK=file\nNEW=1\n', env), ['NEW'])
  assert.deepEqual(env, { KEEP: 'shell', BLANK: '', NEW: '1' })
})

test('applyDotEnv: trailing whitespace is not part of a value, quoted or not', () => {
  const env = {}
  applyDotEnv('A=key   \nB="quoted"  \nC=\'q\' # note\n', env)
  assert.deepEqual(env, { A: 'key', B: 'quoted', C: 'q' })
})

test('loadDotEnv: reads the named file into the given environment; a missing file loads nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finess-env-'))
  try {
    const file = join(dir, '.env')
    writeFileSync(file, 'ROUTES_TEST_KEY=abc\n', 'utf8')
    const env = {}
    assert.deepEqual(loadDotEnv(file, env), ['ROUTES_TEST_KEY'])
    assert.equal(env.ROUTES_TEST_KEY, 'abc')
    assert.equal(process.env.ROUTES_TEST_KEY, undefined, 'process.env is untouched when another env is given')
    assert.deepEqual(loadDotEnv(join(dir, 'missing.env'), env), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
