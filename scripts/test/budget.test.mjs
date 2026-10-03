import assert from 'node:assert/strict'
import { test } from 'node:test'

import { budgetGate, evaluateBudget, gatherUsage, taskTimeoutMs } from '../lib/budget.mjs'
import { localDay } from '../lib/sessions.mjs'

test('evaluateBudget: unset means no limit', () => {
  const v = evaluateBudget({}, { dailyTokens: 9e9 })
  assert.deepEqual(v.items, [])
  assert.equal(evaluateBudget(undefined, {}).blocked.length, 0)
})

test('evaluateBudget: ok below 80%, warn from 80%, block from 100%', () => {
  const b = { sessionTokens: 100, dailyTokens: 100, dailyCost: 10 }
  const v = evaluateBudget(b, { sessionTokens: 79, dailyTokens: 80, dailyCost: 10 })
  const level = k => v.items.find(i => i.key === k).level
  assert.equal(level('sessionTokens'), 'ok')
  assert.equal(level('dailyTokens'), 'warn')
  assert.equal(level('dailyCost'), 'block')
  assert.equal(v.items.find(i => i.key === 'dailyTokens').remaining, 20)
  assert.equal(evaluateBudget({ dailyCost: 10 }, { dailyCost: 25 }).items[0].remaining, 0)
})

test('evaluateBudget: ignores non-positive or non-numeric limits and taskSeconds', () => {
  assert.deepEqual(evaluateBudget({ dailyTokens: 0, sessionTokens: 'x', taskSeconds: 5 }, {}).items, [])
})

test('taskTimeoutMs maps taskSeconds to milliseconds', () => {
  assert.equal(taskTimeoutMs({ taskSeconds: 30 }), 30000)
  assert.equal(taskTimeoutMs({}), undefined)
  assert.equal(taskTimeoutMs(undefined), undefined)
})

test('budgetGate: silent with no budget, warns at 80%, refuses at 100%, allow once is consumed', () => {
  const said = []
  const io = (usage, extra = {}) => ({ usage, say: l => said.push(l), ...extra })
  assert.equal(budgetGate({}, io({ dailyTokens: 1 })).ok, true)
  assert.deepEqual(said, [])

  const cfg = { budget: { dailyTokens: 1000 } }
  const warn = budgetGate(cfg, io({ dailyTokens: 850 }))
  assert.equal(warn.ok, true)
  assert.equal(warn.lines.length, 1)
  assert.match(warn.lines[0], /80%|85%/)

  const stop = budgetGate(cfg, io({ dailyTokens: 1000 }))
  assert.equal(stop.ok, false)
  assert.match(stop.lines.at(-1), /budget\.dailyTokens/)
  assert.match(stop.lines.at(-1), /\/budget allow once/)

  let consumed = 0
  const through = budgetGate(cfg, io({ dailyTokens: 1200 }, { allowOnce: true, consume: () => consumed++ }))
  assert.equal(through.ok, true)
  assert.equal(consumed, 1)
  // Allow-once is not spent when no limit was hit.
  budgetGate(cfg, io({ dailyTokens: 5 }, { allowOnce: true, consume: () => consumed++ }))
  assert.equal(consumed, 1)
})

test('gatherUsage: session tokens, today tokens and priced cost; other days excluded', () => {
  const now = new Date(2026, 9, 3, 12).getTime()
  const today = localDay(now)
  const row = (provider, inT, outT) => ({ provider, model: 'm', calls: 1, reported: inT + outT > 0, inputTokens: inT, outputTokens: outT })
  const a = { identity: 'session-a', routes: new Map([['x/m', row('x', 1000000, 0)]]), days: new Map([[today, new Map([['x/m', row('x', 1000000, 0)]])]]) }
  const b = { identity: 'session-b', routes: new Map(), days: new Map([[today, new Map([['loc/m', row('loc', 300, 200)]])], ['2020-01-01', new Map([['x/m', row('x', 5e6, 0)]])]]) }
  const u = gatherUsage({ pricing: { x: { inputPer1M: 2, outputPer1M: 4 } } }, { sessions: [a, b], sessionId: 'session-a', now })
  assert.equal(u.sessionTokens, 1000000)
  assert.equal(u.dailyTokens, 1000500)
  assert.equal(u.dailyCost, 2)
  assert.equal(gatherUsage({}, { sessions: [a, b], now }).sessionTokens, 0)
})

test('runLoopTask: taskSeconds caps the round timeout, and a spent budget stops before the round', async () => {
  const { runLoopTask } = await import('../loop-task.mjs')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'finess-budget-'))
  try {
    const seen = []
    const dsh = (a, o) => { seen.push(o.timeoutMs); return { code: 1, out: '', timedOut: true } }
    await runLoopTask({ cfg: { profile: { name: 'p' }, budget: { taskSeconds: 5 } }, dsh }, 'x', { loopsDir: dir, roundTimeout: 60 })
    assert.deepEqual(seen, [5000])
    const res = await runLoopTask({ cfg: { profile: { name: 'p' } }, dsh, budgetGate: () => false }, 'x', { loopsDir: dir })
    assert.equal(res.outcome, 'budget')
    assert.equal(seen.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
