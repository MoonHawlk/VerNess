/**
 * One-shot `finess "<task>"` on a headless profile (T-469) goes through the pipeline executor with the
 * same argv and options the direct dsh call used: budget timeout, workspace cwd, overlays, stdin flag.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { executePipeline } from '../lib/pipeline.mjs'

test('one-shot: timeout, cwd, overlay, session and the stdin flag ride through the executor', () => {
  const calls = []
  const run = (argv, opts) => { calls.push({ argv, opts }); return { code: 0, out: '' } }
  executePipeline('standard', { base: ['--profile', 'f'], overlays: ['--patch', 'o.yml'], sessionId: 's1', task: 'do it', env: { K: 'v' }, cwd: '/w', timeoutMs: 90000 }, { run })
  assert.deepEqual(calls, [{ argv: ['--profile', 'f', '--patch', 'o.yml', '--session-id', 's1', 'do it'], opts: { env: { K: 'v' }, cwd: '/w', timeoutMs: 90000, task: true } }])
})

test('one-shot: no budget means no timeoutMs key; no session means no --session-id', () => {
  const calls = []
  executePipeline('standard', { base: ['--profile', 'f'], overlays: [], task: 'x', env: {}, cwd: '/w' }, { run: (a, o) => { calls.push({ a, o }); return { code: 0 } } })
  assert.deepEqual(calls, [{ a: ['--profile', 'f', 'x'], o: { env: {}, cwd: '/w', task: true } }])
})
