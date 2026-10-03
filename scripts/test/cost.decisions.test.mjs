/** `/cost` decision accounting (T-232): pure aggregation over shadow records, temp dirs only. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isLocalSidecar, readDecisionRecords, summarizeDecisions, wouldAvoidLlm } from '../lib/decisions.mjs'
import { decisionLines } from '../commands/cost.mjs'

const rec = (source, pipeline, ms, extra = {}) => ({ source, ms, model: { pipeline: { answer: pipeline, ...extra } } })

test('only a real task whose valid pipeline answer is "decision" would skip the LLM', () => {
  assert.equal(wouldAvoidLlm(rec('repl', 'decision')), true)
  assert.equal(wouldAvoidLlm(rec('repl', 'standard')), false)
  assert.equal(wouldAvoidLlm(rec('/decide', 'decision')), false)
  assert.equal(wouldAvoidLlm(rec('repl', 'decision', 1, { invalid: true })), false)
  assert.equal(wouldAvoidLlm({}), false)
})

test('reads dated records only, tolerating torn lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dec-'))
  try {
    writeFileSync(join(dir, '2026-01-01.jsonl'), `${JSON.stringify(rec('repl', 'decision', 100))}\n{torn\n\n`)
    writeFileSync(join(dir, '2026-01-02.jsonl'), `${JSON.stringify(rec('repl', 'standard', 300))}\n`)
    writeFileSync(join(dir, 'labels.jsonl'), '{"x":1}\n')
    const rs = readDecisionRecords(dir)
    assert.equal(rs.length, 2)
    assert.deepEqual(summarizeDecisions(rs), { calls: 2, meanMs: 200, wouldAvoid: 1, tasks: 2 })
    assert.deepEqual(readDecisionRecords(join(dir, 'nope')), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('summary of nothing, and records without latency', () => {
  assert.deepEqual(summarizeDecisions([]), { calls: 0, meanMs: undefined, wouldAvoid: 0, tasks: 0 })
  assert.equal(summarizeDecisions([{ source: '/decide' }]).meanMs, undefined)
})

test('local sidecar detection', () => {
  assert.equal(isLocalSidecar('http://127.0.0.1:8000'), true)
  assert.equal(isLocalSidecar('http://localhost:8000'), true)
  assert.equal(isLocalSidecar('https://api.example.com'), false)
  assert.equal(isLocalSidecar('garbage'), false)
})

test('lines: shadow wording, local zero cost, remote unpriced, empty', () => {
  const dec = { calls: 3, meanMs: 812.4, wouldAvoid: 1, tasks: 2 }
  const local = decisionLines(dec, { baseURL: 'http://127.0.0.1:8000', shadow: true }, {})
  assert.match(local[0], /3 call\(s\), mean 812ms, cost 0\.0000 \(local sidecar\)/)
  assert.equal(local[1], 'would have avoided 1 of 2 task(s) (shadow)')
  assert.match(decisionLines(dec, { baseURL: 'https://x.io', shadow: true }, {})[0], /price not configured/)
  assert.match(decisionLines(dec, { baseURL: 'https://x.io', shadow: false }, {})[1], /^LLM calls avoided 1 of 2/)
  assert.deepEqual(decisionLines({ calls: 0, wouldAvoid: 0, tasks: 0 }, { baseURL: 'http://127.0.0.1' }, {}), [])
})
