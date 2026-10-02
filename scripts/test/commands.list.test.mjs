/**
 * `finess.mjs --list-commands` (web commands bridge, ADR-0011): valid JSON on stdout, every command
 * once with its aliases folded in, and the terminal-only commands marked `web: false`. Runs the real
 * launcher, which reads only the repo (no dsh, no tokens); `DSH_HOME` points at an empty temp dir.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { commandList } from '../lib/commands.mjs'
import { REPO } from '../lib/util.mjs'
import { pluginOnSurface } from '../finess.mjs'

/** Run the launcher with an isolated `DSH_HOME`. @param {string[]} args - launcher arguments. */
function launcher(args) {
  const home = mkdtempSync(join(tmpdir(), 'finess-list-'))
  try {
    return spawnSync(process.execPath, [join(REPO, 'scripts', 'finess.mjs'), ...args], {
      cwd: REPO, encoding: 'utf8', windowsHide: true, env: { ...process.env, DSH_HOME: home, NO_COLOR: '1', FINESS_NO_PET: '1' },
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
}

const TERMINAL_ONLY = ['btw', 'context', 'help', 'new', 'off', 'recipe', 'resume', 'web', 'workspace']

test('--list-commands prints one JSON array and nothing else on stdout', () => {
  const r = launcher(['--list-commands'])
  assert.equal(r.status, 0, r.stderr)
  const list = JSON.parse(r.stdout)
  assert.ok(Array.isArray(list) && list.length > 10)
  for (const c of list) {
    assert.deepEqual(Object.keys(c).sort(), ['aliases', 'name', 'summary', 'usage', 'web'])
    assert.equal(typeof c.name, 'string')
    assert.equal(typeof c.summary, 'string')
    assert.ok(c.usage.startsWith('/'), c.usage)
    assert.ok(Array.isArray(c.aliases))
    assert.equal(typeof c.web, 'boolean')
  }
})

test('every command appears once, aliases folded in (no alias is listed as its own entry)', () => {
  const list = JSON.parse(launcher(['--list-commands']).stdout)
  const names = list.map(c => c.name)
  assert.equal(new Set(names).size, names.length)
  const aliases = list.flatMap(c => c.aliases)
  assert.equal(new Set(aliases).size, aliases.length)
  for (const a of aliases) assert.ok(!names.includes(a), `alias ${a} is also a command entry`)
  assert.deepEqual(list.find(c => c.name === 'persona')?.aliases, ['p'])
})

test('terminal-only commands are web: false, the quick-tools are web: true', () => {
  const list = JSON.parse(launcher(['--list-commands']).stdout)
  const off = list.filter(c => !c.web).map(c => c.name)
  for (const n of TERMINAL_ONLY) assert.ok(off.includes(n), `${n} should be web: false`)
  // `/exit` (alias `/quit`) must be web: false wherever it exists; nothing else is.
  const exit = list.find(c => c.name === 'exit' || c.aliases.includes('exit'))
  if (exit !== undefined) assert.equal(exit.web, false, '/exit must be web: false')
  assert.deepEqual(off.filter(n => !TERMINAL_ONLY.includes(n) && n !== exit?.name), [])
  for (const n of ['cost', 'usage', 'persona', 'agents', 'decide', 'decisions-data']) {
    assert.equal(list.find(c => c.name === n)?.web, true, `${n} should be web: true`)
  }
})

test('commandList folds aliases, defaults usage and summary, and keeps web: false', () => {
  const a = { name: 'alpha', aliases: ['al'], summary: 'first', run() {} }
  const b = { name: 'beta', usage: '/beta <x>', web: false, run() {} }
  const list = commandList(new Map([['beta', b], ['alpha', a], ['al', a]]))
  assert.deepEqual(list, [
    { name: 'alpha', summary: 'first', usage: '/alpha', aliases: ['al'], web: true },
    { name: 'beta', summary: '', usage: '/beta <x>', aliases: [], web: false },
  ])
})

test('an unknown /word exits non-zero instead of becoming a model task', () => {
  const r = launcher(['/no-such-command-here'])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /no such command: \/no-such-command-here/)
})

test('plugin rows with surfaces stay out of other profiles', () => {
  assert.equal(pluginOnSurface({ id: 'x' }, 'headless'), true)
  assert.equal(pluginOnSurface({ id: 'x', surfaces: ['web'] }, 'web'), true)
  assert.equal(pluginOnSurface({ id: 'x', surfaces: ['web'] }, 'headless'), false)
})
