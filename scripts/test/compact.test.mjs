/** `/compact` (T-151): the pure parts, the patch row and the command with a fake model turn. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { autoPercentOf, compactSettings, parseSummaryRun, renderCompactRow, seedText } from '../lib/compact.mjs'
import { buildContextReport } from '../lib/context.mjs'
import { NEW_KEY, readNotes } from '../lib/notes.mjs'

test('autoPercentOf: in range kept, 0/garbage/out of range means off', () => {
  assert.equal(autoPercentOf(75), 75)
  assert.equal(autoPercentOf('60'), 60)
  for (const v of [0, 5, 99, 'x', undefined, null]) assert.equal(autoPercentOf(v), undefined)
})

test('compactSettings: headroom leaves the ratio as the binding threshold on a 32k window', () => {
  const s = compactSettings(75, [{ contextWindow: 32768, maxTokens: 4096 }])
  assert.equal(s.thresholdRatio, 0.75)
  const W = 32768
  // The substrate's own formula: floor(min(W * ratio, W - O - headroom)).
  assert.equal(Math.floor(Math.min(W * s.thresholdRatio, W - 4096 - s.headroomTokens)), W * 0.75)
  assert.ok(s.headroomTokens > 0 && s.headroomTokens < 65536)
})

test('compactSettings: smallest window and largest output win; unknown windows and off give nothing', () => {
  const s = compactSettings(80, [{ contextWindow: 131072, maxTokens: 8192 }, { contextWindow: 32768, maxTokens: 4096 }])
  assert.equal(s.headroomTokens, Math.max(256, 32768 - 8192 - Math.ceil(32768 * 0.8)))
  assert.equal(compactSettings(undefined, [{ contextWindow: 32768 }]), undefined)
  assert.equal(compactSettings(75, [{}]), undefined)
  assert.equal(compactSettings(75, []), undefined)
})

test('renderCompactRow: a compaction-basic row, nothing when unset', () => {
  assert.deepEqual(renderCompactRow(undefined), [])
  const text = renderCompactRow({ thresholdRatio: 0.75, headroomTokens: 4096 }).join('\n')
  assert.match(text, /^- id: compaction-basic$/m)
  assert.match(text, /thresholdRatio: 0.75/)
  assert.match(text, /headroomTokens: 4096/)
})

test('parseSummaryRun: committed answer and summed usage; garbage lines ignored', () => {
  const out = [
    'noise',
    JSON.stringify({ type: 'status', phase: 'step_end', usage: { inputTokens: 100, outputTokens: 20 } }),
    '{broken',
    JSON.stringify({ type: 'final', text: '  the summary \n' }),
  ].join('\n')
  assert.deepEqual(parseSummaryRun(out), { answer: 'the summary', usage: { input: 100, output: 20 } })
  assert.equal(parseSummaryRun('').answer, '')
})

test('seedText: empty stays empty; long summaries are cut at a line end and say so', () => {
  assert.equal(seedText('  ', 100), '')
  assert.match(seedText('short', 100), /^Summary of the earlier conversation[^\n]*\nshort$/)
  const long = `${'a'.repeat(60)}\n${'b'.repeat(60)}\n${'z'.repeat(60)}`
  const t = seedText(long, 130)
  assert.match(t, /\[summary cut at 130 characters\]$/)
  assert.ok(!t.includes('z'))
})

test('/context hint: a full conversation mentions /compact', () => {
  const r = buildContextReport([{ label: 'conversation so far', tokens: 30000 }], 32768)
  assert.ok(r.over)
  assert.ok(r.hints.some(h => h.startsWith('/compact')))
})

test('/compact command: asks first, then summarizes, resets and seeds the new session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'finess-compact-'))
  try {
    const { default: cmd } = await import('../commands/compact.mjs')
    const calls = []
    let reset = false
    const ctx = {
      cfg: { profile: { name: 'finess' }, compact: { summaryChars: 500 } },
      workspaceKey: 'none',
      routeEnv: {},
      runDir: dir,
      conversation: { id: () => 'session-abc', reset: () => { reset = true } },
      dshAsync: async a => { calls.push(a); return { code: 0, out: JSON.stringify({ type: 'final', text: 'done: X; open: Y' }) } },
    }
    assert.equal(await cmd.run(ctx, []), 0)
    assert.equal(calls.length, 0, 'no model turn without --yes')
    assert.equal(reset, false)
    const noSession = { ...ctx, conversation: { id: () => undefined, reset: () => {} } }
    assert.equal(await cmd.run(noSession, ['--yes']), 0)
    assert.equal(calls.length, 0, 'nothing to compact without a session')
    const bad = { ...ctx, dshAsync: async () => ({ code: 1, out: '' }) }
    assert.equal(await cmd.run(bad, ['--yes']), 1)
    assert.equal(reset, false, 'a failed summary leaves the conversation alone')
    assert.equal(await cmd.run(ctx, ['--yes']), 0)
    assert.ok(calls[0].includes('--session-id') && calls[0].includes('session-abc') && calls[0].includes('--json'))
    assert.equal(reset, true)
    const [n] = readNotes(dir, NEW_KEY)
    assert.match(n.text, /done: X; open: Y/)
    assert.equal(n.sent, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
