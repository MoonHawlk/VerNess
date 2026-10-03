import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foldTodos, formatTodos } from '../lib/todos.mjs'

const w = todos => ({ type: 'todo/write', seq: 1, time: 1, data: { todos } })

test('foldTodos returns null when no todo/write exists', () => {
  assert.equal(foldTodos([]), null)
  assert.equal(foldTodos([{ type: 'turn/start' }]), null)
})

test('foldTodos keeps the latest whole-list snapshot', () => {
  const ev = [w([{ content: 'a', status: 'pending' }]), { type: 'tool/call' }, w([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }])]
  assert.deepEqual(foldTodos(ev), [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }])
})

test('foldTodos honours an empty later write and skips malformed events', () => {
  assert.deepEqual(foldTodos([w([{ content: 'a', status: 'pending' }]), w([])]), [])
  assert.deepEqual(foldTodos([w([{ content: 'a', status: 'pending' }]), { type: 'todo/write', data: {} }]), [{ content: 'a', status: 'pending' }])
})

test('formatTodos marks items and counts done', () => {
  const out = formatTodos([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }])
  assert.deepEqual(out, ['[x] a', '[~] b', '[ ] c', '1/3 done'])
})
