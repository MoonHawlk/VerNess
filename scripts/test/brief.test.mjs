/**
 * The `#` project brief (T-147): `classifyLine` routes `#<note>` to the brief without disturbing the
 * `/` and `//` prefixes, `##` escapes it, and `.verness/brief.md` appends lines under a cap.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifyLine } from '../lib/commands.mjs'
import { appendBrief, briefFile, composeTask, readBrief } from '../lib/notes.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'verness-brief-'))

test('classifyLine: # is the brief, ## escapes it, / and // are untouched', () => {
  assert.deepEqual(classifyLine('#amounts are in EUR'), { kind: 'brief', text: 'amounts are in EUR' })
  assert.deepEqual(classifyLine('  # prefer DuckDB  '), { kind: 'brief', text: 'prefer DuckDB' })
  assert.deepEqual(classifyLine('#'), { kind: 'brief', text: '' })
  assert.deepEqual(classifyLine('##123 is broken'), { kind: 'task', text: '#123 is broken' })
  assert.deepEqual(classifyLine('### heading'), { kind: 'task', text: '## heading' })
  assert.deepEqual(classifyLine('/btw x'), { kind: 'command', text: '/btw x' })
  assert.deepEqual(classifyLine('//#x'), { kind: 'task', text: '/#x' })
  assert.deepEqual(classifyLine('fix issue #12'), { kind: 'task', text: 'fix issue #12' })
})

test('brief appends lines and is capped', () => {
  const root = tmp()
  assert.equal(readBrief(root), '')
  assert.equal(appendBrief(root, 'prefer DuckDB for local data', 100).line, '- prefer DuckDB for local data')
  appendBrief(root, 'amounts are in EUR', 100)
  assert.equal(readBrief(root), '- prefer DuckDB for local data\n- amounts are in EUR')
  assert.equal(readFileSync(briefFile(root), 'utf8').endsWith('\n'), true)
  const big = appendBrief(root, 'x'.repeat(100), 100)
  assert.equal(big.refused, true)
  assert.equal(big.reason, 'cap')
  assert.equal(appendBrief(root, '  ', 100).reason, 'empty')
  assert.equal(appendBrief(root, 'x'.repeat(30), 100).warn, true, '80% of the cap warns')
  rmSync(root, { recursive: true, force: true })
})

test('composeTask puts the brief before the notes, both delimited as context', () => {
  const out = composeTask('go', { brief: '- a', notes: [{ text: 'b', at: '', sent: false }] })
  assert.equal(out, [
    'Project brief from the operator (standing context, not tasks):',
    '- a',
    '',
    'Side notes from the operator (context, not tasks):',
    '- b',
    '',
    '---',
    '',
    'go',
  ].join('\n'))
  assert.equal(composeTask('go', { brief: '   ' }), 'go')
})
