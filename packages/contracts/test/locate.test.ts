import { test } from 'node:test'
import assert from 'node:assert/strict'

import { locate } from '../src/locate.ts'

const text = `{
  // a comment with "quotes" and {braces}
  "id": "data-scientist",
  "tools": {
    "allow": ["read", "grep",
      "sql.query"],
  },
}`

test('top-level value', () => assert.deepEqual(locate(text, ['id']), { line: 3, column: 9 }))
test('array element', () => assert.deepEqual(locate(text, ['tools', 'allow', 2]), { line: 6, column: 7 }))
test('missing key points at the parent object', () => assert.deepEqual(locate(text, ['tools', 'deny']), { line: 4, column: 12 }))
test('root', () => assert.deepEqual(locate(text, []), { line: 1, column: 1 }))
test('string containing a colon and a slash-slash', () => {
  assert.deepEqual(locate('{"a": "http://x", "b": 1}', ['b']), { line: 1, column: 24 })
})

test('block comment containing a quote and braces before a value', () => {
  const t = `{
  /* block "quote" {brace} */
  "a": 1
}`
  assert.deepEqual(locate(t, ['a']), { line: 3, column: 8 })
})

test('key with a nested object value points at its opening brace', () => {
  const t = `{
  "a": {
    "b": 1
  }
}`
  assert.deepEqual(locate(t, ['a']), { line: 2, column: 8 })
})

test('missing intermediate segment returns undefined', () => {
  assert.equal(locate(text, ['nope', 'x']), undefined)
})

test('out-of-range array index points at the array opening bracket', () => {
  assert.deepEqual(locate(text, ['tools', 'allow', 5]), { line: 5, column: 14 })
})

test('string value with an escaped quote followed by a later key', () => {
  const t = `{
  "a": "esc\\"aped",
  "b": 2
}`
  assert.deepEqual(locate(t, ['b']), { line: 3, column: 8 })
})

test('CRLF line endings', () => {
  const t = '{\r\n  "a": 1\r\n}'
  assert.deepEqual(locate(t, ['a']), { line: 2, column: 8 })
})
