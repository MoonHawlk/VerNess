/**
 * Pipeline executor (T-254): `standard` is one dsh run, byte-identical to what the REPL sent before
 * the executor existed; the M7 modes never run anything yet. The runner is a stub: no dsh is spawned.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { EXECUTORS, PIPELINE_MODES, executePipeline, planStandard } from '../lib/pipeline.mjs'

/** The REPL's inline call before T-254, kept here as the reference the executor must match. */
const legacy = ({ args, overlayArgs, prior, outgoing, env, cwd }) => ({
  argv: [...args, ...overlayArgs, ...(prior === undefined ? [] : ['--session-id', prior]), outgoing],
  opts: { env, cwd, task: true },
})

/** @returns {{run: Function, calls: object[]}} a runner that records its calls. */
const recorder = (result = { code: 0, out: '' }) => {
  const calls = []
  return { calls, run: (argv, opts) => { calls.push({ argv, opts }); return result } }
}

const CASES = [
  { args: ['--profile', 'finess'], overlayArgs: [], prior: undefined, outgoing: 'fix the bug', env: {}, cwd: '/w' },
  { args: ['--profile', 'finess'], overlayArgs: ['--patch', 'recipe.yml', '--patch', 'fallback.yml'], prior: 'sess-1', outgoing: 'line one\nline "two"', env: { K: 'v' }, cwd: 'C:\\work' },
  { args: ['--profile', 'p'], overlayArgs: ['--patch', 'fallback.yml'], prior: undefined, outgoing: 'x'.repeat(70000), env: { DSH_PERMISSION_MODE: 'read-only' }, cwd: '/tmp/a b' },
]

test('standard: argv and options are byte-identical to the pre-executor REPL call', () => {
  for (const c of CASES) {
    const { calls, run } = recorder()
    executePipeline('standard', { base: c.args, overlays: c.overlayArgs, sessionId: c.prior, task: c.outgoing, env: c.env, cwd: c.cwd }, { run })
    assert.equal(calls.length, 1, 'exactly one model turn')
    assert.equal(JSON.stringify(calls[0]), JSON.stringify(legacy(c)))
  }
})

test('standard: one turn, task flag set (long tasks go through stdin, T-448), overlays keep their order', () => {
  const p = planStandard({ base: ['--profile', 'f'], overlays: ['--patch', 'a', '--patch', 'b'], sessionId: 's', task: 't', env: { A: '1' }, cwd: '/c' })
  assert.deepEqual(p, { mode: 'standard', turns: 1, argv: ['--profile', 'f', '--patch', 'a', '--patch', 'b', '--session-id', 's', 't'], opts: { env: { A: '1' }, cwd: '/c', task: true } })
  assert.deepEqual(planStandard({ base: [], task: 't' }), { mode: 'standard', turns: 1, argv: ['t'], opts: { env: {}, task: true } })
})

test('standard: the runner result comes back tagged with the mode', () => {
  const { run } = recorder({ code: 3, out: 'boom', timedOut: false })
  assert.deepEqual(executePipeline('standard', { base: [], task: 't' }, { run }), { mode: 'standard', code: 3, out: 'boom', timedOut: false })
})

test('M7 modes and unknown modes never run anything', () => {
  for (const mode of ['agent', 'decision', 'adaptive']) {
    const { calls, run } = recorder()
    const r = executePipeline(mode, { base: [], task: 't' }, { run })
    assert.equal(calls.length, 0)
    assert.deepEqual([r.mode, r.code], [mode, 2])
    assert.match(r.error, new RegExp(`pipeline "${mode}" is not implemented yet \\(M7\\)`))
  }
  const { calls, run } = recorder()
  const r = executePipeline('toString', { base: [], task: 't' }, { run })
  assert.equal(calls.length, 0)
  assert.match(r.error, /unknown pipeline "toString" \(expected one of standard, agent, decision, adaptive\)/)
})

test('the mode list matches the contract, and only standard has an executor', () => {
  assert.deepEqual(PIPELINE_MODES, ['standard', 'agent', 'decision', 'adaptive'])
  assert.deepEqual(Object.keys(EXECUTORS), ['standard'])
})
