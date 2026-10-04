/**
 * Dashboard server (T-273..T-278): bind/token rules, debounce, SSE framing, and one loopback
 * integration run on an ephemeral port. Temp dirs only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  bindPlan, debounce, hostAllowed, isLoopback, loadOrCreateToken, requestToken, sseFrame, startDashboardServer, tokenOk,
} from '../lib/dashserve.mjs'

test('isLoopback / bindPlan: only loopback skips the token', () => {
  for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) assert.equal(bindPlan(h).requireToken, false, h)
  for (const h of ['0.0.0.0', '192.168.1.5', '::', 'example.com']) assert.equal(bindPlan(h).requireToken, true, h)
  assert.equal(isLoopback('127.0.0.1.evil.com'), false)
})

test('token: stored once, reused, matched in constant time, read from query/header/bearer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finess-dash-'))
  try {
    const file = join(dir, 'run', 'dashboard.token')
    const a = loadOrCreateToken(file)
    assert.equal(a.created, true)
    assert.ok(a.token.length >= 32)
    const b = loadOrCreateToken(file)
    assert.deepEqual([b.token, b.created], [a.token, false])
    assert.equal(tokenOk(a.token, a.token), true)
    assert.equal(tokenOk('nope', a.token), false)
    assert.equal(tokenOk(undefined, a.token), false)
    assert.equal(requestToken('/?token=abc', {}), 'abc')
    assert.equal(requestToken('/', { 'x-finess-token': 'h' }), 'h')
    assert.equal(requestToken('/', { authorization: 'Bearer z' }), 'z')
    assert.equal(requestToken('/', {}), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('hostAllowed: loopback names only (DNS rebinding guard)', () => {
  assert.equal(hostAllowed('127.0.0.1:4180'), true)
  assert.equal(hostAllowed('localhost:1'), true)
  assert.equal(hostAllowed('[::1]:80'), true)
  assert.equal(hostAllowed('evil.example:4180'), false)
  assert.equal(hostAllowed(undefined), false)
})

test('debounce: a burst fires once, cancel stops it', async () => {
  let n = 0
  const d = debounce(() => { n++ }, 20)
  d.trigger(); d.trigger(); d.trigger()
  await new Promise(r => setTimeout(r, 60))
  assert.equal(n, 1)
  d.trigger(); d.cancel()
  await new Promise(r => setTimeout(r, 40))
  assert.equal(n, 1)
})

test('sseFrame: id, event, one-line JSON data, blank-line terminator', () => {
  assert.equal(sseFrame('changed', { version: 2 }, 2), 'id: 2\nevent: changed\ndata: {"version":2}\n\n')
  assert.equal(sseFrame('ping'), 'event: ping\n\n')
})

test('a non-loopback bind without a token is refused', async () => {
  await assert.rejects(startDashboardServer({ host: '0.0.0.0', port: 0, render: () => '' }), /needs a token/)
})

/** GET with an explicit Host header; resolves {status, body}. */
const get = (port, path, headers = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, headers }, res => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', c => { body += c })
    res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] }))
  })
  req.on('error', reject)
  req.end()
})

test('server: serves the page, pushes a changed event on a file change, shuts down cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'finess-dash-'))
  const watched = join(dir, 'loops')
  mkdirSync(watched)
  let renders = 0
  const srv = await startDashboardServer({
    port: 0, render: () => { renders++; return `<html><body>page ${renders}</body></html>` },
    targets: () => [watched], debounceMs: 30, pollMs: 100,
  })
  try {
    assert.equal(srv.host, '127.0.0.1')
    const page = await get(srv.port, '/')
    assert.equal(page.status, 200)
    assert.match(page.body, /page 1/)
    assert.match(page.body, /EventSource/)
    assert.equal((await get(srv.port, '/')).body, page.body, 'cached until a change')
    assert.equal((await get(srv.port, '/', { host: 'evil.example' })).status, 403)
    assert.equal((await get(srv.port, '/nope')).status, 404)

    // Open the event stream, then touch a watched file.
    const seen = await new Promise((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => reject(new Error(`no changed event; got ${JSON.stringify(buf)}`)), 8000)
      const req = request({ host: '127.0.0.1', port: srv.port, path: '/events' }, res => {
        assert.match(res.headers['content-type'], /text\/event-stream/)
        res.setEncoding('utf8')
        res.on('data', c => {
          buf += c
          if (buf.includes('event: hello') && !buf.includes('changed')) setTimeout(() => writeFileSync(join(watched, 'x.jsonl'), '{}\n'), 50)
          if (buf.includes('event: changed')) { clearTimeout(timer); req.destroy(); resolve(buf) }
        })
      })
      req.on('error', e => { if (!buf.includes('changed')) reject(e) })
      req.end()
    })
    assert.match(seen, /event: changed\ndata: \{"version":\d+\}/)
    assert.match((await get(srv.port, '/')).body, /page 2/, 'rendered again after the change')
  } finally {
    await srv.close()
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(existsSync(dir), false)
})

test('server with a token: 401 without it, 200 with ?token= or the header', async () => {
  const srv = await startDashboardServer({ port: 0, token: 'secret-token-123456', render: () => '<html><body>ok</body></html>' })
  try {
    assert.equal((await get(srv.port, '/')).status, 401)
    assert.equal((await get(srv.port, '/?token=wrong')).status, 401)
    assert.equal((await get(srv.port, '/events')).status, 401)
    assert.equal((await get(srv.port, '/?token=secret-token-123456')).status, 200)
    assert.equal((await get(srv.port, '/', { 'x-finess-token': 'secret-token-123456' })).status, 200)
  } finally { await srv.close() }
})

test('token file is private on POSIX', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finess-dash-'))
  try {
    const f = join(dir, 't')
    loadOrCreateToken(f)
    if (process.platform !== 'win32') assert.equal(statSync(f).mode & 0o777, 0o600)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
