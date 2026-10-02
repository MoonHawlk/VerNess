/**
 * Per-tool counts, failure rate and the latency histogram (T-271), from synthetic session events.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LATENCY_BUCKETS, summarizeTools, toolRuns } from '../lib/toolstats.mjs'

const call = (name, time, id) => ({ type: 'tool/call', time, data: { name, id } })
const result = (time, id, error) => ({ type: 'tool/result', time, data: { id, ...(error === undefined ? {} : { error }) } })

test('toolRuns pairs by id when present, even out of order', () => {
  const runs = toolRuns([call('a', 0, 1), call('b', 10, 2), result(50, 2), result(900, 1, { message: 'boom' })])
  assert.deepEqual(runs, [
    { name: 'a', ms: 900, failed: true },
    { name: 'b', ms: 40, failed: false },
  ])
})

test('toolRuns falls back to order, and leaves unanswered calls without a verdict', () => {
  const runs = toolRuns([call('a', 0), call('a', 10), result(100), { type: 'turn/end', time: 101 }])
  assert.deepEqual(runs, [
    { name: 'a', ms: 100, failed: false },
    { name: 'a', ms: undefined, failed: undefined },
  ])
})

test('summarizeTools counts calls and failures per tool, busiest first', () => {
  const s = summarizeTools([
    { name: 'read', ms: 20, failed: false }, { name: 'read', ms: 40, failed: false },
    { name: 'read', ms: 60, failed: true }, { name: 'bash', ms: 3000, failed: false },
  ])
  assert.deepEqual(s.tools.map(t => [t.name, t.calls, t.failures]), [['read', 3, 1], ['bash', 1, 0]])
  assert.equal(s.tools[0].failRate, 1 / 3)
  assert.equal(s.tools[0].p50, 40)
  assert.equal(s.tools[0].p95, 60)
  assert.equal(s.calls, 4)
  assert.equal(s.failures, 1)
})

test('the histogram buckets every timed call once and skips untimed ones', () => {
  const ms = [10, 99, 100, 499, 500, 999, 1000, 4999, 5000, 29999, 30000, 600000]
  const s = summarizeTools([...ms.map(m => ({ name: 't', ms: m, failed: false })), { name: 't' }])
  assert.equal(s.histogram.length, LATENCY_BUCKETS.length)
  assert.deepEqual(s.histogram.map(h => h.count), [2, 2, 2, 2, 2, 2])
  assert.equal(s.histogram.reduce((a, h) => a + h.count, 0), ms.length)
})

test('no runs gives empty tables, not NaN', () => {
  const s = summarizeTools([])
  assert.deepEqual(s.tools, [])
  assert.ok(s.histogram.every(h => h.count === 0))
})
