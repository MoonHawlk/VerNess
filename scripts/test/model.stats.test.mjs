/**
 * `stats --watch` and the probe history (T-123). The engine is a mock `fetch`: no model server needed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendProbe, modelStats, probeRegression, readProbes, statsOpts } from '../model.mjs'

const CFG = { model: { baseURL: 'http://engine.test/v1', id: 'm1' } }

/** @param {{tokPerSec?: number, probeOk?: boolean}} [o] - mock behaviour. @returns {{fetch: typeof fetch, probes: () => number}} */
function engine(o = {}) {
  let probes = 0
  const json = body => ({ ok: true, json: async () => body })
  return {
    probes: () => probes,
    fetch: async (url, init) => {
      if (init?.signal?.aborted) throw new Error('aborted')
      if (url.endsWith('/api/version')) return json({ version: '0.9' })
      if (url.endsWith('/api/ps')) return json({ models: [{ name: 'm1', size: 1024 ** 3, size_vram: 1024 ** 3 }] })
      if (url.endsWith('/api/tags')) return json({ models: [{ name: 'm1', size: 1024 ** 3 }] })
      probes++
      if (o.probeOk === false) return { ok: false }
      return json({ eval_count: 8, eval_duration: 8e9 / (o.tokPerSec ?? 40), prompt_eval_duration: 5e6, load_duration: 1e6 })
    },
  }
}

/** @param {(log: string) => Promise<void>} fn - body run against a fresh history file. */
async function inTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'verness-stats-'))
  try { await fn(join(dir, 'probes.jsonl')) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('a single stats run records one probe', () => inTemp(async log => {
  const e = engine()
  assert.equal(await modelStats(CFG, { fetch: e.fetch, probeLog: log }), true)
  const [rec, ...rest] = readProbes(log)
  assert.equal(rest.length, 0)
  assert.equal(rec.ok, true)
  assert.equal(rec.model, 'm1')
  assert.equal(rec.tokPerSec, 40)
}))

test('--watch probes every tick and stops cleanly on abort', () => inTemp(async log => {
  const e = engine()
  const ctl = new AbortController()
  const done = modelStats(CFG, { fetch: e.fetch, probeLog: log, watch: true, intervalMs: 5, signal: ctl.signal })
  while (e.probes() < 3) await new Promise(r => setTimeout(r, 2))
  ctl.abort()
  assert.equal(await done, true)
  const n = readProbes(log).length
  assert.ok(n >= 3)
  await new Promise(r => setTimeout(r, 30))
  assert.equal(readProbes(log).length, n, 'nothing is written after the abort')
}))

test('--watch records failed probes too', () => inTemp(async log => {
  const e = engine({ probeOk: false })
  await modelStats(CFG, { fetch: e.fetch, probeLog: log, watch: true, intervalMs: 1, maxTicks: 3 })
  const recs = readProbes(log)
  assert.equal(recs.length, 3)
  assert.ok(recs.every(r => r.ok === false))
}))

test('an unreachable engine fails without writing history', () => inTemp(async log => {
  const down = async () => { throw new Error('refused') }
  assert.equal(await modelStats(CFG, { fetch: down, probeLog: log }), false)
  assert.deepEqual(readProbes(log), [])
}))

test('probeRegression flags a drop against the recent median, per model', () => {
  const h = [40, 41, 39, 40].map(t => ({ ok: true, model: 'm1', tokPerSec: t }))
  assert.match(probeRegression(h, { ok: true, model: 'm1', tokPerSec: 20 }), /below the recent median 40/)
  assert.equal(probeRegression(h, { ok: true, model: 'm1', tokPerSec: 35 }), undefined)
  assert.equal(probeRegression(h, { ok: true, model: 'other', tokPerSec: 1 }), undefined)
  assert.equal(probeRegression(h.slice(0, 2), { ok: true, model: 'm1', tokPerSec: 1 }), undefined, 'too little history')
})

test('readProbes skips bad lines and a missing file', () => inTemp(async log => {
  assert.deepEqual(readProbes(log), [])
  appendProbe({ a: 1 }, log)
  appendProbe({ a: 2 }, log)
  assert.deepEqual(readProbes(log).map(r => r.a), [1, 2])
}))

test('statsOpts parses --watch and --interval', () => {
  const o = statsOpts(['--watch', '--interval', '2'])
  assert.equal(o.watch, true)
  assert.equal(o.intervalMs, 2000)
  process.removeAllListeners('SIGINT')
  assert.equal(statsOpts([]).watch, false)
  process.removeAllListeners('SIGINT')
})
