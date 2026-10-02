/**
 * Tool errors in the dashboard timeline: the substrate logs them as objects, never "[object Object]".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { errorText } from '../dashboard.mjs'

test('errorText names the error and code, with the message when there is one', () => {
  assert.equal(errorText({ name: 'ToolArgsError', code: 'INVALID_ARGS' }), 'ToolArgsError INVALID_ARGS')
  assert.equal(errorText({ name: 'FsError', code: 'FS_NOT_FOUND', message: 'no such file' }), 'FsError FS_NOT_FOUND: no such file')
  assert.equal(errorText({ message: 'boom' }), 'boom')
  assert.equal(errorText({ other: 1 }), '{"other":1}')
  assert.equal(errorText('plain'), 'plain')
})
