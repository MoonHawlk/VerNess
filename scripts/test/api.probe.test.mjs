/**
 * `/api test` (T-358): the probe confirms key + model with one token, says it costs, and asks first.
 * `/cost` (T-362): a route with no price entry shows tokens only. T-435: a refused question is not an outage.
 * The network is never touched: the adapter call is a stub.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A fake dsh home with a one-provider adapter catalog, set before routes.mjs reads it.
const home = mkdtempSync(join(tmpdir(), 'finess-api-'))
const dist = join(home, 'profiles', 'p', 'node_modules', '@earendil-works', 'pi-ai', 'dist')
mkdirSync(join(dist, 'providers', 'data'), { recursive: true })
writeFileSync(join(dist, 'providers', 'data', 'acmeprobe.json'), JSON.stringify({ 'openai-completions': { 'm-1': {} } }))
writeFileSync(join(dist, 'env-api-keys.js'), 'export const findEnvKeys = () => ["ACMEPROBE_API_KEY"]\n')
process.env.DSH_HOME = home

const { default: api } = await import('../commands/api.mjs')
const { probeModel } = await import('../lib/routes.mjs')
const { decisionFailure } = await import('../lib/decisions.mjs')
const { priceUsage } = await import('../lib/sessions.mjs')

const cfg = { profile: { name: 'p' }, model: { route: 'local', id: 'small' }, extraRoutes: { acmeprobe: { model: 'm-1' } }, activeRoute: '' }
const ok = { role: 'assistant', stopReason: 'stop', usage: { input: 9, output: 1 } }

/** Run `/api test ...` with a stubbed adapter; returns exit code, printed text and the stub's calls. */
async function run(args, complete) {
  const calls = []
  const lines = []
  const log = console.log
  console.log = s => lines.push(String(s))
  try {
    const code = await api.run({ cfg, sync() {}, complete: (...a) => { calls.push(a); return complete(...a) } }, args)
    return { code, text: lines.join('\n'), calls }
  } finally { console.log = log }
}

test('without --yes it warns about the cost and sends nothing', async () => {
  process.env.ACMEPROBE_API_KEY = 'k'
  const r = await run(['test', 'acmeprobe'], () => ok)
  assert.equal(r.code, 0)
  assert.match(r.text, /bills it/)
  assert.match(r.text, /\/api test acmeprobe --yes/)
  assert.equal(r.calls.length, 0)
})

test('a missing key is reported for free, before any request', async () => {
  delete process.env.ACMEPROBE_API_KEY
  const r = await run(['test', 'acmeprobe', '--yes'], () => ok)
  assert.equal(r.code, 1)
  assert.match(r.text, /ACMEPROBE_API_KEY is not set/)
  assert.equal(r.calls.length, 0)
})

test('with --yes it sends one request capped at one token and reports usage', async () => {
  process.env.ACMEPROBE_API_KEY = 'secret'
  const r = await run(['test', 'acmeprobe', '--yes'], () => ok)
  assert.equal(r.code, 0)
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0][2].maxTokens, 1)
  assert.equal(r.calls[0][2].apiKey, 'secret')
  assert.match(r.text, /9 in, 1 out/)
  assert.doesNotMatch(r.text, /secret/)
})

test('a provider error or a throw fails the probe without crashing', async () => {
  process.env.ACMEPROBE_API_KEY = 'k'
  const bad = await probeModel(cfg, 'acmeprobe', 'm-1', { complete: () => ({ stopReason: 'error', errorMessage: '401 unauthorized' }) })
  assert.deepEqual([bad.ok, bad.error], [false, '401 unauthorized'])
  const thrown = await probeModel(cfg, 'acmeprobe', 'm-1', { complete: () => { throw new Error('ECONNREFUSED') } })
  assert.deepEqual([thrown.ok, thrown.error], [false, 'ECONNREFUSED'])
  const r = await run(['test', 'acmeprobe', '--yes'], () => ({ stopReason: 'error', errorMessage: 'nope' }))
  assert.equal(r.code, 1)
  assert.match(r.text, /probe failed/)
})

test('an unknown provider is refused', async () => {
  const r = await run(['test', 'nosuch', '--yes'], () => ok)
  assert.equal(r.code, 1)
  assert.equal(r.calls.length, 0)
})

test('/cost: a route with tokens and no price entry stays unpriced; an entry prices it', () => {
  const routes = [{ provider: 'acmeprobe', model: 'm-1', inputTokens: 2e6, outputTokens: 1e6, reported: true }]
  const none = priceUsage(routes, {})
  assert.deepEqual(none.unpriced, ['acmeprobe/m-1'])
  assert.equal(none.total, 0)
  const priced = priceUsage(routes, { 'acmeprobe/m-1': { inputPer1M: 1, outputPer1M: 4 } })
  assert.equal(priced.total, 6)
  assert.deepEqual(priced.unpriced, [])
})

test('shadow failure: an invalid question is not reported as an outage', () => {
  assert.equal(decisionFailure({ ok: false, error: 'invalid question: level.criteria: too many' }), 'invalid question: level.criteria: too many')
  assert.equal(decisionFailure({ ok: false, error: 'ECONNREFUSED' }), 'decision service unavailable (ECONNREFUSED)')
  assert.equal(decisionFailure({ ok: false, status: 500 }), 'decision service unavailable (500)')
})
