/**
 * The blocking spawn with a tree-killing timeout (T-472): a real child plus grandchild must both die.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runSyncTree } from '../lib/treerun.mjs'
import { isAlive } from '../lib/procs.mjs'

test('a timeout kills the child and its grandchild', async () => {
  const src = "const g = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(g.pid); setInterval(() => {}, 1000)"
  const r = runSyncTree(process.execPath, ['-e', src], { capture: true, timeoutMs: 2000 })
  assert.equal(r.timedOut, true)
  const gpid = Number(r.out.trim())
  assert.ok(Number.isInteger(gpid) && gpid > 0, `grandchild pid in output: ${r.out}`)
  for (let i = 0; i < 40 && isAlive(gpid); i++) await new Promise(res => setTimeout(res, 100))
  assert.equal(isAlive(gpid), false, 'grandchild survived')
})

test('a run that finishes in time keeps its exit code and output', () => {
  const r = runSyncTree(process.execPath, ['-e', 'console.log("hi"); process.exit(3)'], { capture: true, timeoutMs: 20000 })
  assert.deepEqual([r.code, r.out, r.timedOut], [3, 'hi', false])
})
