/**
 * Loop-run records for the dashboard (T-328): parsing `.finess/loops/*.jsonl`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseLoopRuns } from '../lib/loop.mjs'

const rec = (at, outcome, log) => JSON.stringify({ at, objective: `obj ${at}`, outcome, detail: 'd', rounds: log.length, log })

test('parseLoopRuns sums round seconds and sorts newest first', () => {
  const text = [
    rec('2026-01-01T10:00:00Z', 'done', [{ seconds: 1.5 }, { seconds: 2 }]),
    rec('2026-01-02T10:00:00Z', 'timeout', [{ seconds: 600 }]),
    rec('2026-01-03T10:00:00Z', 'repeating', []),
  ].join('\r\n')
  const runs = parseLoopRuns(text)
  assert.deepEqual(runs.map(r => r.outcome), ['repeating', 'timeout', 'done'])
  assert.equal(runs[2].seconds, 3.5)
  assert.equal(runs[2].rounds, 2)
  assert.equal(runs[0].seconds, 0)
})

test('parseLoopRuns skips bad lines and tolerates missing fields', () => {
  const runs = parseLoopRuns('not json\n\n{"x":1}\n[1]\n{"objective":"o","rounds":4}\n')
  assert.equal(runs.length, 1)
  assert.deepEqual(runs[0], { at: '', objective: 'o', rounds: 4, outcome: '?', seconds: 0, detail: '' })
  assert.deepEqual(parseLoopRuns(undefined), [])
})
