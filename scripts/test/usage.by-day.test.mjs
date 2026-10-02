/**
 * `/usage --by day` (T-137): tokens per route per LOCAL day across sessions, read from fixture
 * session logs written the way the substrate writes them (one zstd frame per append) under an
 * isolated `DSH_HOME`. Timestamps are built from local wall-clock dates, so the expectations hold in
 * any time zone, on macOS and Windows alike.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import usage from '../commands/usage.mjs'
import { aggregateUsageByDay, listSessions, localDay, localOffsetLabel } from '../lib/sessions.mjs'

const WS = '--fixture-workspace--'
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
let home
let savedHome

/**
 * Write one fixture session log, one zstd frame per event.
 * @param {string} id - session id.
 * @param {object[]} events - the events, in append order.
 */
function writeSession(id, events) {
  const dir = join(home, 'sessions', WS, `session-${id}`)
  mkdirSync(dir, { recursive: true })
  const frames = events.map(e => zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`)))
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
}

const header = (time, provider, model) => ({ type: 'request/header', time, data: { header: { config: { provider, model } } } })
const reply = (time, usage) => ({ type: 'assistant/message', time, data: usage === undefined ? {} : { usage } })

before(() => {
  savedHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'finess-usage-day-'))
  process.env.DSH_HOME = home
  // Session A spans local midnight: two calls on 30 Sep, one on 1 Oct, then a route switch.
  writeSession('a', [
    { type: 'session', createdAt: at(2026, 9, 30, 23, 0) },
    header(at(2026, 9, 30, 23, 1), 'deepseek', 'deepseek-chat'),
    reply(at(2026, 9, 30, 23, 2), { inputTokens: 100, outputTokens: 10 }),
    reply(at(2026, 9, 30, 23, 59), { inputTokens: 200, outputTokens: 20 }),
    reply(at(2026, 10, 1, 0, 1), { inputTokens: 300, outputTokens: 30 }),
    header(at(2026, 10, 1, 0, 2), 'ollama-local', 'qwen'),
    reply(at(2026, 10, 1, 0, 3)),
  ])
  // Session B: same route, same day as A's second half — must merge into one row with sessions = 2.
  // Its reply has no `time`, so it falls back to the session's createdAt.
  writeSession('b', [
    { type: 'session', createdAt: at(2026, 10, 1, 9, 0) },
    header(at(2026, 10, 1, 9, 1), 'deepseek', 'deepseek-chat'),
    { type: 'assistant/message', data: { usage: { inputTokens: 1000, outputTokens: 100 } } },
  ])
})

after(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

test('localDay uses the local calendar date, not UTC', () => {
  assert.equal(localDay(at(2026, 9, 30, 23, 59)), '2026-09-30')
  assert.equal(localDay(at(2026, 10, 1, 0, 1)), '2026-10-01')
  assert.match(localOffsetLabel(), /^UTC[+-]\d{2}:\d{2}$/)
})

test('aggregateUsageByDay splits by local day and route, merges across sessions', () => {
  const { rows, anyReported } = aggregateUsageByDay(listSessions({ workspace: WS }))
  assert.equal(anyReported, true)
  const pick = r => [r.day, `${r.provider}/${r.model}`, r.sessions, r.calls, r.reported, r.inputTokens, r.outputTokens]
  assert.deepEqual(rows.map(pick), [
    ['2026-10-01', 'deepseek/deepseek-chat', 2, 2, true, 1300, 130],
    ['2026-10-01', 'ollama-local/qwen', 1, 1, false, 0, 0],
    ['2026-09-30', 'deepseek/deepseek-chat', 1, 2, true, 300, 30],
  ])
})

test('per-day totals agree with the per-route summary', () => {
  for (const s of listSessions({ workspace: WS })) {
    for (const [k, r] of s.routes) {
      let calls = 0
      let input = 0
      for (const day of s.days.values()) { calls += day.get(k)?.calls ?? 0; input += day.get(k)?.inputTokens ?? 0 }
      assert.equal(calls, r.calls, k)
      assert.equal(input, r.inputTokens, k)
    }
  }
})

/** Run `/usage` with captured stdout. @param {string[]} args - flags. */
function runUsage(args) {
  const out = []
  const log = console.log
  console.log = (...a) => out.push(a.join(' '))
  try { return { code: usage.run({ workspaceKey: WS, cfg: {} }, args), text: out.join('\n') } } finally { console.log = log }
}

test('/usage --by day prints one table row per day and route, newest first', () => {
  const { code, text } = runUsage(['--by', 'day'])
  assert.equal(code, 0)
  assert.match(text, /local dates, UTC[+-]\d{2}:\d{2}/)
  const lines = text.split('\n').filter(l => /^\s+\d{4}-\d{2}-\d{2}\s/.test(l))
  assert.equal(lines.length, 3)
  assert.match(lines[0], /2026-10-01\s+deepseek\s+deepseek-chat\s+2\s+2\s+1,300\s+130/)
  assert.match(lines[1], /2026-10-01\s+ollama-local\s+qwen\s+1\s+1\s+—\s+—/)
  assert.match(lines[2], /2026-09-30\s+deepseek\s+deepseek-chat\s+1\s+2\s+300\s+30/)
})

test('/usage --by with an unknown breakdown fails with a hint', () => {
  const { code, text } = runUsage(['--by', 'week'])
  assert.equal(code, 1)
  assert.match(text, /supported: \/usage --by day/)
})
