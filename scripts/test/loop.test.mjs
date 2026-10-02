/**
 * `/loop-task` guards: consecutive-repeat tiers (T-325) and the per-round wall-clock budget (T-327).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { callFingerprint, detectStall, repeatChain, repeatReminder } from '../lib/loop.mjs'
import { runLoopTask } from '../loop-task.mjs'

const call = (name, args) => ({ name, args, fp: callFingerprint(name, args) })
const same = n => Array.from({ length: n }, () => call('read', { path: 'a', mode: 'x' }))

test('repeatChain: tiers at 3, 5 and 8 consecutive identical calls', () => {
  assert.equal(repeatChain(same(2)).level, 'none')
  assert.equal(repeatChain(same(3)).level, 'gentle')
  assert.equal(repeatChain(same(4)).level, 'gentle')
  assert.equal(repeatChain(same(5)).level, 'detailed')
  assert.equal(repeatChain(same(8)).level, 'block')
  assert.equal(repeatChain(same(8)).count, 8)
})

test('repeatChain: argument key order is ignored, a different call resets the run', () => {
  const calls = [...same(7), call('read', { mode: 'x', path: 'a' })]
  assert.equal(repeatChain(calls).level, 'block')
  assert.equal(repeatChain([...same(7), call('read', { path: 'b' })]).level, 'none')
  assert.equal(callFingerprint('t', '{"b":1,"a":2}'), callFingerprint('t', { a: 2, b: 1 }))
})

test('repeatChain: non-consecutive repeats do not count', () => {
  const calls = []
  for (let i = 0; i < 6; i++) calls.push(call('read', { path: 'a' }), call('grep', { q: String(i) }))
  assert.equal(repeatChain(calls).level, 'none')
})

test('repeatReminder: gentle and detailed text, none otherwise', () => {
  assert.match(repeatReminder(repeatChain(same(3))), /identical arguments/)
  const d = repeatReminder(repeatChain(same(5)))
  assert.match(d, /tool: read/)
  assert.match(d, /consecutive_calls: 5/)
  assert.equal(repeatReminder(repeatChain(same(1))), '')
  assert.equal(repeatReminder(repeatChain(same(9))), '')
})

test('repeatReminder: long arguments are truncated in the quote', () => {
  const chain = repeatChain(Array.from({ length: 5 }, () => call('write', { body: 'x'.repeat(2000) })))
  assert.match(repeatReminder(chain, 50), /more chars/)
})

test('detectStall: only the block tier reports a repeat', () => {
  const st = n => ({ calls: same(n), answers: [] })
  assert.deepEqual(detectStall(st(5)).repeated, [])
  assert.deepEqual(detectStall(st(8)).repeated, ['read x8'])
})

test('runLoopTask: a round past its budget is classified timeout and stops the loop', async () => {
  const seen = []
  const ctx = {
    cfg: { profile: { name: 'p' } },
    dsh: (args, opts) => { seen.push(opts.timeoutMs); return { code: 1, out: '', timedOut: true } },
  }
  const res = await runLoopTask(ctx, 'x', { maxRounds: 5, roundTimeout: 7 })
  assert.equal(res.outcome, 'timeout')
  assert.equal(res.rounds, 1)
  assert.deepEqual(seen, [7000])
})

test('runLoopTask: the round budget defaults to 600 seconds', async () => {
  const seen = []
  const ctx = { cfg: { profile: { name: 'p' } }, dsh: (a, o) => { seen.push(o.timeoutMs); return { code: 1, out: '', timedOut: true } } }
  await runLoopTask(ctx, 'x')
  assert.deepEqual(seen, [600000])
})
