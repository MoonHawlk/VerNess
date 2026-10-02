/** `/context` (T-151): the pure estimation and formatting. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildContextReport, estimateTokens, formatContextReport } from '../lib/context.mjs'

test('estimateTokens: chars / 4, rounded up, never negative', () => {
  assert.equal(estimateTokens(0), 0)
  assert.equal(estimateTokens(1), 1)
  assert.equal(estimateTokens(8), 2)
  assert.equal(estimateTokens(9), 3)
  assert.equal(estimateTokens(undefined), 0)
  assert.equal(estimateTokens(-5), 0)
})

test('buildContextReport: totals, percent, measured tokens win over chars', () => {
  const r = buildContextReport([
    { label: 'persona prompt', chars: 400 },
    { label: 'conversation so far', tokens: 1000 },
  ], 4000)
  assert.equal(r.totalTokens, 1100)
  assert.equal(r.pct, 27.5)
  assert.equal(r.over, false)
  assert.deepEqual(r.hints, [])
  assert.equal(r.rows[1].measured, true)
})

test('buildContextReport: warns at 80% with hints only for parts that are present', () => {
  const r = buildContextReport([
    { label: 'project brief', chars: 2000 },
    { label: 'side notes', chars: 0 },
    { label: 'conversation so far', tokens: 300 },
  ], 1000)
  assert.equal(r.over, true)
  assert.ok(r.hints.some(h => h.includes('/new')))
  assert.ok(r.hints.some(h => h.includes('brief')))
  assert.ok(!r.hints.some(h => h.includes('/btw')))
})

test('buildContextReport: unknown window gives no percent and no warning', () => {
  const r = buildContextReport([{ label: 'project brief', chars: 99999 }], undefined)
  assert.equal(r.pct, undefined)
  assert.equal(r.over, false)
})

test('formatContextReport: rows, total, estimate label, warnings', () => {
  const r = buildContextReport([{ label: 'project brief', chars: 3600 }], 1000)
  const { lines, warnings } = formatContextReport(r)
  assert.ok(lines[0].includes('3,600 chars') && lines[0].includes('~900 tok'))
  assert.ok(lines.some(l => l.startsWith('total') && l.includes('90.0% of 1,000')))
  assert.ok(lines.at(-1).includes('estimates'))
  assert.ok(warnings[0].includes('90%'))
  const calm = formatContextReport(buildContextReport([{ label: 'project brief', chars: 40 }], 1000))
  assert.deepEqual(calm.warnings, [])
})
