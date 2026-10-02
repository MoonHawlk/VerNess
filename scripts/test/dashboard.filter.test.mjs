/**
 * Dashboard route filter (T-272): the pure matcher, and the tool summary the page recomputes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { matchRoute } from '../dashboard.mjs'
import { summarizeTools, toolstatsClientSource } from '../lib/toolstats.mjs'

test('matchRoute: empty filter keeps everything, else the session must have used the route', () => {
  assert.equal(matchRoute({ routes: ['a/x'] }, ''), true)
  assert.equal(matchRoute({ routes: ['a/x', 'b/y'] }, 'b/y'), true)
  assert.equal(matchRoute({ routes: ['a/x'] }, 'b/y'), false)
  assert.equal(matchRoute({}, 'a/x'), false)
})

test('the embedded summarizeTools gives the same answer as the module one', () => {
  const runs = [{ name: 'read', ms: 50, failed: false }, { name: 'read', ms: 2000, failed: true }, { name: 'bash' }]
  const inPage = new Function(`${toolstatsClientSource()}; return summarizeTools`)()
  assert.deepEqual(inPage(runs), summarizeTools(runs))
})
