/** Where the editor thinks a wrapped input lands (T-302); the simulated-tty test checks it on screen. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { layout } from '../lib/prompt.mjs'

test('fits on one row', () => {
  assert.deepEqual(layout('finess> ', 'hello', 5, '', 80), { rows: 1, cursorRow: 0, cursorCol: 13 })
})

test('exactly filling a row puts the cursor on a row of its own', () => {
  assert.deepEqual(layout('finess> ', 'x'.repeat(72), 72, '', 80), { rows: 1, cursorRow: 1, cursorCol: 0 })
})

test('a ghost after an exactly full row takes that next row instead', () => {
  assert.deepEqual(layout('finess> ', 'x'.repeat(72), 72, 'ghost', 80), { rows: 2, cursorRow: 1, cursorCol: 0 })
})

test('long buffer, cursor in the middle', () => {
  assert.deepEqual(layout('finess> ', 'x'.repeat(200), 100, '', 80), { rows: 3, cursorRow: 1, cursorCol: 28 })
})

test('a wide character that does not fit moves to the next row, and the cursor with it', () => {
  // 8 + 31 = 39 columns used at width 40: the 漢 cannot take the last cell.
  const buf = 'x'.repeat(31) + '漢'
  assert.deepEqual(layout('finess> ', buf, 31, '', 40), { rows: 2, cursorRow: 1, cursorCol: 0 })
  assert.deepEqual(layout('finess> ', buf, buf.length, '', 40), { rows: 2, cursorRow: 1, cursorCol: 2 })
})

test('emoji are two columns and one cursor step; combining marks take none', () => {
  assert.deepEqual(layout('> ', '🙂a', 2, '', 80), { rows: 1, cursorRow: 0, cursorCol: 4 })
  assert.deepEqual(layout('> ', 'éa', 2, '', 80), { rows: 1, cursorRow: 0, cursorCol: 3 })
})
