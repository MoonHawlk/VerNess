import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendHistory, loadHistory, recentTasks, storable } from '../lib/history.mjs'
import { makeSuggester } from '../lib/prompt.mjs'

const file = () => join(mkdtempSync(join(tmpdir(), 'finess-hist-')), 'sub', 'history.jsonl')

test('append, dedupe (newest wins), cap', () => {
  const f = file()
  for (const l of ['a', 'b', 'a', 'c']) appendHistory(f, l, 3)
  assert.deepEqual(loadHistory(f), ['b', 'a', 'c'])
  appendHistory(f, 'd', 3)
  assert.deepEqual(loadHistory(f), ['a', 'c', 'd'])
})

test('missing file is empty history', () => {
  assert.deepEqual(loadHistory(file()), [])
})

test('BOM, CRLF and torn lines are tolerated', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'finess-hist-')), 'history.jsonl')
  writeFileSync(f, '﻿"one"\r\n{not json\r\n42\r\n"two"\r\n', 'utf8')
  assert.deepEqual(loadHistory(f), ['one', 'two'])
})

test('credential-looking lines are never written', () => {
  const f = file()
  appendHistory(f, 'export API_KEY=abc123')
  appendHistory(f, 'use sk-abcdefghijklmnopqrstuvwxyz please')
  appendHistory(f, 'how many tokens did I use today')
  assert.deepEqual(loadHistory(f), ['how many tokens did I use today'])
  assert.equal(storable('password: hunter2'), false)
  assert.ok(!readFileSync(f, 'utf8').includes('abc123'))
})

test('recent tasks: plain text only, prefix, newest first, deduped, capped', () => {
  const hist = ['count the json files', '/usage', 'count lines', '#count note', 'count lines', 'deploy']
  assert.deepEqual(recentTasks(hist, 'COU').map(c => c.value), ['count lines', 'count the json files'])
  assert.deepEqual(recentTasks(hist, 'co'), [], 'fewer than 3 characters')
  assert.deepEqual(recentTasks(hist, '/us'), [], 'slash input belongs to commands')
  assert.deepEqual(recentTasks(hist, '#co'), [], 'notes are not tasks')
  assert.deepEqual(recentTasks(hist, 'count lines'), [], 'the exact line is not offered back')
  const many = Array.from({ length: 20 }, (_, i) => `task ${i}`)
  const got = recentTasks(many, 'tas')
  assert.equal(got.length, 6)
  assert.equal(got[0].value, 'task 19')
  assert.deepEqual(got[0], { value: 'task 19', hint: 'recent', replace: 3 })
})

test('suggester offers recent tasks for plain text and leaves commands alone', () => {
  const commands = new Map([['usage', { name: 'usage', summary: 'usage' }]])
  const s = makeSuggester(commands, () => ({}), () => ['count the json files', 'count lines', 'deploy'])
  assert.deepEqual(s('cou').map(c => c.value), ['count lines', 'count the json files'])
  assert.deepEqual(s('co'), [])
  assert.deepEqual(s('/us').map(c => c.value), ['/usage'])
  // Without a history supplier, plain text still gets nothing (the old behaviour).
  assert.deepEqual(makeSuggester(commands, () => ({}))('count'), [])
})
