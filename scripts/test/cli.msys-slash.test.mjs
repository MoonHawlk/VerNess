/**
 * Git Bash rewrites a leading `/word` into a path under its install root; the launcher reads it back
 * as a command instead of sending it to the model as a task.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { unmangleSlash } from '../finess.mjs'

test('a rewritten /word under the Git root is read back as a slash command', () => {
  assert.equal(unmangleSlash('C:/Program Files/Git/guard'), '/guard')
  assert.equal(unmangleSlash('C:\Program Files\Git\models'), '/models')
  assert.equal(unmangleSlash('D:/tools/Git/usr/think'), '/think')
})

test('real paths, tasks and other words are left alone', () => {
  assert.equal(unmangleSlash('/guard'), '/guard')
  assert.equal(unmangleSlash('summarize the README'), 'summarize the README')
  assert.equal(unmangleSlash('C:/Program Files/Git/guard check rm -rf build'), 'C:/Program Files/Git/guard check rm -rf build')
  assert.equal(unmangleSlash('C:/code/app'), 'C:/code/app')
  assert.equal(unmangleSlash(undefined), undefined)
})
