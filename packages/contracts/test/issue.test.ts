import { test } from 'node:test'
import assert from 'node:assert/strict'

import { closest, formatPath } from '../src/issue.ts'

test('formatPath', () => {
  assert.equal(formatPath(['tools', 'allow', 2]), 'tools.allow[2]')
  assert.equal(formatPath([]), '')
})
test('closest', () => {
  assert.equal(closest('tool', ['tools', 'skills']), 'tools')
  assert.equal(closest('zzzzzz', ['tools']), undefined)
})
