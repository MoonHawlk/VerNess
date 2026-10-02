/**
 * `/btw` side notes (T-130): storage per session key, the 2000-character cap with its 80% warning,
 * send-once, the hand-over from the pre-session key, and the delimited "context, not tasks" block.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import btw from '../commands/btw.mjs'
import {
  NEW_KEY, addNote, clearNotes, composeTask, dropNote, markSent, markUnsent, moveNotes, notesFile, pendingNotes, readNotes,
} from '../lib/notes.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'finess-notes-'))

test('add, read, drop, clear', () => {
  const d = tmp()
  addNote(d, 's1', 'use the staging db', 2000)
  addNote(d, 's1', 'numbers in EUR', 2000)
  assert.deepEqual(readNotes(d, 's1').map(n => n.text), ['use the staging db', 'numbers in EUR'])
  assert.equal(dropNote(d, 's1', 1), true)
  assert.deepEqual(readNotes(d, 's1').map(n => n.text), ['numbers in EUR'])
  assert.equal(dropNote(d, 's1', 9), false)
  assert.equal(dropNote(d, 's1', Number('x')), false)
  clearNotes(d, 's1')
  assert.deepEqual(readNotes(d, 's1'), [])
  rmSync(d, { recursive: true, force: true })
})

test('cap: warn at 80%, refuse past 100%', () => {
  const d = tmp()
  assert.equal(addNote(d, 'k', 'x'.repeat(79), 100).warn, false)
  assert.equal(addNote(d, 'k', 'y', 100).warn, true) // 80 characters in all
  const c = addNote(d, 'k', 'z'.repeat(21), 100) // would be 101
  assert.equal(c.refused, true)
  assert.equal(c.reason, 'cap')
  assert.equal(readNotes(d, 'k').length, 2)
  assert.equal(addNote(d, 'k', 'z'.repeat(20), 100).refused, false, 'exactly the cap is allowed')
  rmSync(d, { recursive: true, force: true })
})

test('empty note is refused', () => {
  const d = tmp()
  const r = addNote(d, 'k', '   ', 100)
  assert.equal(r.refused, true)
  assert.equal(r.reason, 'empty')
  rmSync(d, { recursive: true, force: true })
})

test('send once: pending until marked sent; unsent again for a fresh session', () => {
  const d = tmp()
  addNote(d, 'k', 'a', 100)
  assert.equal(pendingNotes(readNotes(d, 'k')).length, 1)
  markSent(d, 'k')
  assert.equal(pendingNotes(readNotes(d, 'k')).length, 0)
  assert.equal(readNotes(d, 'k').length, 1, 'a sent note is kept')
  markUnsent(d, 'k')
  assert.equal(pendingNotes(readNotes(d, 'k')).length, 1)
  rmSync(d, { recursive: true, force: true })
})

test('notes written before the session exists follow it, after its own', () => {
  const d = tmp()
  addNote(d, 'session-abc', 'older', 100)
  addNote(d, NEW_KEY, 'early note', 100)
  moveNotes(d, NEW_KEY, 'session-abc')
  assert.deepEqual(readNotes(d, NEW_KEY), [])
  assert.deepEqual(readNotes(d, 'session-abc').map(n => n.text), ['older', 'early note'])
  moveNotes(d, NEW_KEY, 'session-abc') // nothing to move: a no-op
  assert.equal(readNotes(d, 'session-abc').length, 2)
  rmSync(d, { recursive: true, force: true })
})

test('a session identity with path characters still maps to one file in the run dir', () => {
  const f = notesFile('/run', 'a/b:c\\d')
  assert.match(f.replace(/\\/g, '/'), /\/run\/notes-a_b_c_d\.json$/)
})

test('a corrupt or BOM-prefixed file reads safely', () => {
  const d = tmp()
  writeFileSync(notesFile(d, 'k'), '{not json', 'utf8')
  assert.deepEqual(readNotes(d, 'k'), [])
  writeFileSync(notesFile(d, 'k'), '﻿[{"text":"kept","at":"","sent":false}]', 'utf8')
  assert.equal(readNotes(d, 'k')[0].text, 'kept')
  rmSync(d, { recursive: true, force: true })
})

test('composeTask delimits context from the task', () => {
  const out = composeTask('count the files', { notes: [{ text: 'skip node_modules', at: '', sent: false }] })
  assert.equal(out, [
    'Side notes from the operator (context, not tasks):',
    '- skip node_modules',
    '',
    '---',
    '',
    'count the files',
  ].join('\n'))
})

test('composeTask with nothing to add returns the task unchanged', () => {
  assert.equal(composeTask('hi', {}), 'hi')
  assert.equal(composeTask('hi', { notes: [] }), 'hi')
})

test('/btw is terminal-only and refuses an over-cap note with exit 1', () => {
  assert.equal(btw.web, false)
  // A conversation with a key unique to this test keeps the real run dir untouched afterwards.
  const key = `test-${process.pid}-${Date.now()}`
  const ctx = { conversation: { id: () => key }, cfg: { notes: { maxChars: 10 } } }
  const log = console.log
  console.log = () => {}
  try {
    assert.equal(btw.run(ctx, ['short']), 0)
    assert.equal(btw.run(ctx, ['much', 'too', 'long']), 1)
    assert.equal(btw.run(ctx, []), 0)
    assert.equal(btw.run(ctx, ['drop', '5']), 1)
    assert.equal(btw.run(ctx, ['clear']), 0)
  } finally { console.log = log }
})
