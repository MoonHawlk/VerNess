/**
 * A hosted decision provider is config, not code (T-205), and Laya's MCP row renders only behind
 * `decisions.mcp` (T-240). Servers are local stubs on ephemeral ports; nothing leaves the machine.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

import { ROUTING_QUESTIONS, askDecision, decisionConfig, isLocalSidecar, mcpRowLines, venvPython } from '../lib/decisions.mjs'
import { renderPatch } from '../finess.mjs'

/**
 * Start a stub SystemOne server.
 * @param {(n: number) => {status: number, json: object}} reply - the reply for the nth request.
 * @returns {Promise<{url: string, seen: any[], close: () => void}>} the server and what it saw.
 */
async function stub(reply) {
  const seen = []
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
      const r = reply(seen.length)
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.json))
    })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => srv.close() }
}

const ANSWER = { answers: { level: { choice: 'simple', answer_confidence: 0.8 } } }

test('a hosted provider is only a different baseURL and key env: same path, bearer, body, result', async () => {
  const jev = await stub(() => ({ status: 200, json: ANSWER }))
  process.env.FINESS_TEST_JEV_KEY = 'jev-secret'
  try {
    // Configured exactly as a user would for a hosted provider: three keys, no code.
    const dc = decisionConfig({ decisions: { baseURL: jev.url, apiKeyEnv: 'FINESS_TEST_JEV_KEY', timeoutMs: 3000 } })
    const r = await askDecision(dc, 'rename a variable', { level: ROUTING_QUESTIONS.level }, { retries: 0 })
    assert.equal(r.ok, true)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, ANSWER)
    assert.equal(jev.seen.length, 1)
    assert.equal(jev.seen[0].method, 'POST')
    assert.equal(jev.seen[0].url, '/v1/systemone')
    assert.equal(jev.seen[0].auth, 'Bearer jev-secret')
    assert.deepEqual(JSON.parse(jev.seen[0].body), { state: { document: 'rename a variable' }, questions: { level: ROUTING_QUESTIONS.level } })
  } finally { delete process.env.FINESS_TEST_JEV_KEY; jev.close() }
})

test('the Laya default key env is not consulted for another provider; no key means no auth header', async () => {
  const s = await stub(() => ({ status: 200, json: ANSWER }))
  process.env.LAYA_API_KEY = 'laya-key-must-not-leak'
  delete process.env.FINESS_TEST_OTHER_KEY
  try {
    const dc = decisionConfig({ decisions: { baseURL: s.url, apiKeyEnv: 'FINESS_TEST_OTHER_KEY' } })
    await askDecision(dc, 'x', { level: ROUTING_QUESTIONS.level }, { retries: 0 })
    assert.equal(s.seen[0].auth, undefined)
  } finally { delete process.env.LAYA_API_KEY; s.close() }
})

test('503 backpressure is retried against a hosted provider too', async () => {
  const s = await stub(n => (n === 1 ? { status: 503, json: { error: 'busy' } } : { status: 200, json: ANSWER }))
  try {
    const dc = decisionConfig({ decisions: { baseURL: s.url, apiKeyEnv: 'FINESS_TEST_NO_KEY' } })
    const r = await askDecision(dc, 'x', { level: ROUTING_QUESTIONS.level }, { retries: 2 })
    assert.equal(r.ok, true)
    assert.equal(s.seen.length, 2)
  } finally { s.close() }
})

test('loopback is only a cost label: a hosted URL is not a local sidecar', () => {
  assert.equal(isLocalSidecar('http://127.0.0.1:8000'), true)
  assert.equal(isLocalSidecar('https://jev.example.com'), false)
})

// ------------------------------------------------------------------------------- T-240

test('venvPython picks the layout of the platform', () => {
  const repo = resolve('r')
  assert.equal(venvPython({}, { win: true, repo }), join(repo, '.finess', 'py', 'Scripts', 'python.exe'))
  assert.equal(venvPython({ venv: 'v' }, { win: false, repo }), join(repo, 'v', 'bin', 'python'))
})

test('mcpRowLines: off by default, a stdio row for laya.mcp.server when on', () => {
  assert.deepEqual(mcpRowLines(decisionConfig({})), [])
  assert.equal(decisionConfig({}).mcp, false)
  const repo = resolve('r')
  const text = mcpRowLines(decisionConfig({ decisions: { mcp: true } }), { win: false, repo }).join('\n')
  assert.match(text, /- id: mcp-laya\n {6}name: '@deepseek-ai\/dsh-mcp-client'/)
  assert.match(text, /serverName: laya\n {8}transport: stdio/)
  assert.ok(text.includes(`command: '${join(repo, '.finess', 'py', 'bin', 'python')}'`))
  assert.ok(text.includes("args: ['-m', 'laya.mcp.server']"))
  assert.match(text, /failOnStartupError: false/)
})

test('renderPatch: the mcp row appears only with the flag and a checkout path (never in the committed copy)', () => {
  const base = {
    profile: { name: 't', template: 'headless' },
    model: { route: 'local', id: 'small', source: 'x', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'K', apiKeyValue: 'p' },
    activeRoute: '', personas: { active: 'p', definitions: { p: { prefix: 'P', suffix: 'S', model: {} } } },
    settings: { plugins: [], toolsMode: 'native' }, tips: [],
  }
  const on = { ...base, decisions: { mcp: true } }
  const repo = resolve('r')
  assert.match(renderPatch(on, { surface: 'headless', repo, state: {} }), /- id: mcp-laya/)
  assert.doesNotMatch(renderPatch(on, { surface: 'headless', state: {} }), /mcp-laya/)
  assert.doesNotMatch(renderPatch(base, { surface: 'headless', repo, state: {} }), /mcp-laya/)
})
