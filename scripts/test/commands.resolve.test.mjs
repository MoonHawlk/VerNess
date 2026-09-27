/**
 * Unique-prefix resolution and the `//` escape (T-182): an exact name or alias always wins, a
 * prefix runs only when it names one command, an ambiguous one runs nothing, and a line starting
 * `//` is a task with one slash removed, never a command.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyLine, resolveCommand, runCommand } from '../lib/commands.mjs'

/**
 * @param {object[]} list - command definitions.
 * @returns {Map<string, object>} a registry shaped like `loadCommands` builds it.
 */
function registry(list) {
  const out = new Map()
  for (const c of list) { out.set(c.name, c); for (const a of c.aliases ?? []) out.set(a, c) }
  return out
}

const ran = []
const cmd = (name, aliases) => ({ name, aliases, summary: name, run: (_ctx, args) => { ran.push([name, ...args]); return 0 } })
const commands = registry([
  cmd('model'), cmd('models'), cmd('persona', ['p']), cmd('exit', ['quit']),
  cmd('sessions', ['session', 'ls']), cmd('help', ['?']),
  // A persona-scoped command sits in the same Map, so prefixes reach it too.
  cmd('hypotheses'),
])

test('an exact name or alias wins over a longer match', () => {
  assert.deepEqual(resolveCommand('model', commands), { name: 'model', candidates: ['model'] })
  assert.equal(resolveCommand('p', commands).name, 'persona')
  assert.equal(resolveCommand('?', commands).name, 'help')
  assert.equal(resolveCommand('MODEL', commands).name, 'model')
})

test('a unique prefix resolves, including through an alias and to a persona command', () => {
  assert.equal(resolveCommand('pers', commands).name, 'persona')
  assert.equal(resolveCommand('qu', commands).name, 'exit')
  assert.equal(resolveCommand('hyp', commands).name, 'hypotheses')
  // `session` and `sessions` both start with "sess" but are one command.
  assert.deepEqual(resolveCommand('sess', commands), { name: 'sessions', candidates: ['sessions'] })
})

test('an ambiguous prefix resolves to nothing and lists every candidate', () => {
  assert.deepEqual(resolveCommand('mo', commands), { candidates: ['model', 'models'] })
  assert.deepEqual(resolveCommand('zz', commands), { candidates: [] })
  assert.deepEqual(resolveCommand('', commands), { candidates: [] })
})

test('runCommand runs a unique prefix and refuses an ambiguous one without passing it on', async () => {
  ran.length = 0
  assert.deepEqual(await runCommand('/pers show x', { commands }), { handled: true, code: 0, name: 'persona' })
  assert.deepEqual(ran, [['persona', 'show', 'x']])
  const r = await runCommand('/mo', { commands })
  assert.equal(r.handled, true, 'an ambiguous prefix must not fall through to the model')
  assert.equal(r.code, 1)
  assert.deepEqual(r.ambiguous, ['model', 'models'])
  assert.equal(ran.length, 1, 'nothing ran for the ambiguous prefix')
  assert.deepEqual(await runCommand('/nope', { commands }), { handled: false })
})

test('classifyLine: commands, tasks, and the // escape', () => {
  assert.deepEqual(classifyLine('   '), { kind: 'empty' })
  assert.deepEqual(classifyLine('/model x'), { kind: 'command', text: '/model x' })
  assert.deepEqual(classifyLine('fix the bug'), { kind: 'task', text: 'fix the bug' })
  assert.deepEqual(classifyLine('//etc/hosts is odd'), { kind: 'task', text: '/etc/hosts is odd' })
  assert.deepEqual(classifyLine('///x'), { kind: 'task', text: '//x' })
  assert.deepEqual(classifyLine('  //help  '), { kind: 'task', text: '/help' })
})
