/**
 * The web commands bridge plugin (`packages/commands`, ADR-0011) against a fake `ctx.commands`:
 * registration (reserved names and substrate clashes skipped and logged, aliases, hints), disposal
 * (HMR safety), and the handler's success/error mapping, ANSI stripping and abort. The handler runs
 * a stand-in launcher script, so no dsh and no tokens are needed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RESERVED, RESTART_LINE, apply, hintOf, listCommands, registerCommands, runCommand, stripAnsi, words } from '../../packages/commands/index.js'
import { REPO } from '../lib/util.mjs'

/** A fake `ctx.commands` with the real registry's name rule and clash error. */
function fakeRegistry(taken = []) {
  const defs = new Map(taken.map(n => [n, { name: n, substrate: true }]))
  return {
    defs,
    register(def) {
      if (!/^[a-z][a-z0-9_-]*$/.test(def.name)) throw new TypeError(`command name "${def.name}" must match`)
      if (def.input !== undefined && def.input.hint.trim() === '') throw new TypeError('input hint must not be empty')
      if (defs.has(def.name)) throw new Error(`command "${def.name}" is already registered (for a per-agent variant, ...)`)
      defs.set(def.name, def)
      return () => { if (defs.get(def.name) === def) defs.delete(def.name) }
    },
  }
}

const LIST = [
  { name: 'cost', summary: 'priced usage', usage: '/cost [--all] [--limit N]', aliases: [], web: true },
  { name: 'agents', summary: 'personas and teams', usage: '/agents', aliases: ['roster'], web: true },
  { name: 'persona', summary: 'switch persona', usage: '/persona [list | <id>]', aliases: ['p'], web: true },
  { name: 'help', summary: 'list', usage: '/help', aliases: ['?', 'commands'], web: false },
  { name: 'model', summary: 'model status', usage: '/model [<id>]', aliases: [], web: true },
  { name: 'feedback', summary: 'clash with a substrate host command', usage: '/feedback', aliases: [], web: true },
  { name: 'taken', summary: 'registered by the substrate first', usage: '/taken', aliases: [], web: true },
]

test('web commands and aliases register; web: false, reserved and taken names are skipped and logged', () => {
  const reg = fakeRegistry(['taken'])
  const logs = []
  const disposers = registerCommands(reg, LIST, { repo: REPO, log: m => logs.push(m) })
  const ours = [...reg.defs.values()].filter(d => d.substrate !== true).map(d => d.name).sort()
  assert.deepEqual(ours, ['agents', 'cost', 'p', 'persona', 'roster'])
  assert.equal(disposers.length, 5)
  assert.ok(!reg.defs.has('help') && !reg.defs.has('commands'))
  assert.deepEqual(logs.sort(), ['/feedback left to the substrate', '/model left to the substrate', '/taken left to the substrate'])
})

test('a registration carries definitionId, description, input hint and recordInput', () => {
  const reg = fakeRegistry()
  registerCommands(reg, LIST, { repo: REPO, log: () => {} })
  const cost = reg.defs.get('cost')
  assert.equal(cost.definitionId, '@finess/commands:cost')
  assert.equal(cost.description, 'priced usage')
  assert.deepEqual(cost.input, { hint: '[--all] [--limit N]' })
  assert.equal(cost.recordInput, true)
  assert.equal(reg.defs.get('agents').input, undefined, 'no input when the usage has no arguments')
  assert.match(reg.defs.get('p').description, /alias of \/persona/)
})

test('an alias runs its canonical command', async () => {
  const reg = fakeRegistry()
  const calls = []
  registerCommands(reg, LIST, { repo: REPO, log: () => {}, run: o => { calls.push(o); return { kind: 'success' } } })
  await reg.defs.get('p').handler({ rawInput: ' list', signal: new AbortController().signal })
  assert.equal(calls[0].command, 'persona')
  assert.equal(calls[0].rawInput, ' list')
})

test('RESERVED holds the client contributions and the substrate host commands', () => {
  for (const n of ['model', 'file', 'compact', 'export', 'feedback', 'goal', 'permission', 'plan']) assert.ok(RESERVED.has(n), n)
})

test('RESERVED covers every command the pinned substrate registers (skipped without the submodule)', t => {
  const root = join(REPO, 'upstream', 'deepseek-harness', 'packages')
  if (!existsSync(root)) { t.skip('upstream submodule not checked out'); return }
  const found = new Set()
  const walk = d => {
    for (const f of readdirSync(d)) {
      if (f === 'node_modules' || f === 'tests' || f === 'test') continue
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(f) && !/\.(spec|test)\.tsx?$/.test(f) && p.includes(`${join('', 'src', '')}`)) {
        for (const m of readFileSync(p, 'utf8').matchAll(/commands?\.register\(\{\s*(?:definitionId:[^\n]*\n\s*)?name: '([a-z][a-z0-9_-]*)'/g)) found.add(m[1])
      }
    }
  }
  walk(root)
  assert.ok(found.has('model') && found.has('feedback'), `expected substrate commands, found ${[...found]}`)
  for (const n of found) assert.ok(RESERVED.has(n), `substrate registers /${n}; add it to RESERVED in packages/commands/index.js`)
})

/** A fake plugin context: `appReady` optional, effects collected so the test can dispose them. */
function fakeCtx({ ready } = {}) {
  const cleanups = []
  const commands = fakeRegistry(['feedback'])
  return {
    commands,
    get: n => (n === 'appReady' ? ready : undefined),
    effect: fn => { cleanups.push(fn()) },
    dispose: () => { for (const c of cleanups.reverse()) c() },
  }
}

/** A controllable `appReady`. */
function fakeReady() {
  const listeners = new Set()
  return {
    listeners,
    onReady: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    fire: () => { for (const fn of listeners) fn() },
  }
}

test('apply registers only after appReady, and disposal removes every registration (HMR safety)', () => {
  const ready = fakeReady()
  const ctx = fakeCtx({ ready })
  apply(ctx, { repo: REPO }, { log: () => {}, list: () => ({ list: LIST }) })
  assert.deepEqual([...ctx.commands.defs.keys()], ['feedback'], 'nothing registered before ready')
  ready.fire()
  assert.ok(ctx.commands.defs.has('cost') && ctx.commands.defs.has('persona'))
  ctx.dispose()
  assert.deepEqual([...ctx.commands.defs.keys()], ['feedback'], 'only the substrate command is left')
})

test('disposal before ready cancels the pending registration', () => {
  const ready = fakeReady()
  const ctx = fakeCtx({ ready })
  apply(ctx, { repo: REPO }, { log: () => {}, list: () => ({ list: LIST }) })
  ctx.dispose()
  assert.equal(ready.listeners.size, 0)
  ready.fire()
  assert.ok(!ctx.commands.defs.has('cost'))
})

test('without appReady it registers at once; a failed list or missing repo registers nothing', () => {
  const ctx = fakeCtx()
  apply(ctx, { repo: REPO }, { log: () => {}, list: () => ({ list: LIST }) })
  assert.ok(ctx.commands.defs.has('cost'))

  const logs = []
  const broken = fakeCtx()
  apply(broken, { repo: REPO }, { log: m => logs.push(m), list: () => ({ error: 'exit 1: boom' }) })
  apply(broken, {}, { log: m => logs.push(m), list: () => ({ list: LIST }) })
  assert.deepEqual([...broken.commands.defs.keys()], ['feedback'])
  assert.deepEqual(logs, ['no commands registered: exit 1: boom', 'no config.repo; run ./turn_on.sh sync'])
})

test('listCommands reads the real launcher list', () => {
  const got = listCommands(REPO)
  assert.ok('list' in got, got.error)
  assert.ok(got.list.some(c => c.name === 'cost' && c.web === true))
  assert.ok(got.list.some(c => c.name === 'help' && c.web === false))
})

test('small helpers: words, hints, ANSI', () => {
  assert.deepEqual(words('  --week   --all '), ['--week', '--all'])
  assert.deepEqual(words(''), [])
  assert.equal(hintOf('/cost [--all]'), '[--all]')
  assert.equal(hintOf('/agents'), '')
  assert.equal(stripAnsi('\u001b[1m\u001b[36mbold\u001b[0m text\u001b[2K'), 'bold text')
})

// ------------------------------------------------------------------------- handler, real child

const dir = mkdtempSync(join(tmpdir(), 'finess-bridge-'))
const script = join(dir, 'fake-launcher.mjs')
writeFileSync(script, `
const [cmd, ...args] = process.argv.slice(2)
if (args[0] === 'fail') { process.stdout.write('\\u001b[33m  !! \\u001b[0mbad input\\n'); process.exit(3) }
if (args[0] === 'silent-fail') process.exit(2)
if (args[0] === 'sleep') { setTimeout(() => {}, 60000) } else {
  process.stdout.write('\\n  \\n\\u001b[1mhello\\u001b[0m ' + cmd + ' ' + args.join(',') + '\\n')
  setTimeout(() => { process.stderr.write('then stderr\\n'); setTimeout(() => process.stdout.write('then stdout\\n'), 30) }, 30)
}
`)
test.after(() => rmSync(dir, { recursive: true, force: true }))

test('exit 0 is success: stdout and stderr in order, ANSI stripped, indentation kept, args split on whitespace', async () => {
  const r = await runCommand({ repo: dir, script, command: 'cost', rawInput: '  --week  --all' })
  assert.deepEqual(r, { kind: 'success', text: 'hello /cost --week,--all\nthen stderr\nthen stdout' })
})

test('a non-zero exit is an error with the output, or the exit code when there is none', async () => {
  assert.deepEqual(await runCommand({ repo: dir, script, command: 'cost', rawInput: 'fail' }), { kind: 'error', text: '  !! bad input' })
  assert.deepEqual(await runCommand({ repo: dir, script, command: 'cost', rawInput: 'silent-fail' }), { kind: 'error', text: 'exit 2' })
})

test('a state-changing command with arguments gets the restart line', async () => {
  const r = await runCommand({ repo: dir, script, command: 'persona', rawInput: ' qa-engineer' })
  assert.equal(r.kind, 'success')
  assert.ok(r.text.endsWith(`\n\n${RESTART_LINE}`), r.text)
  const show = await runCommand({ repo: dir, script, command: 'persona', rawInput: '' })
  assert.ok(!show.text.includes(RESTART_LINE))
})

test('abort kills the child and settles as an error', async () => {
  const ac = new AbortController()
  let child
  const spawnImpl = (...a) => { child = spawn(...a); return child }
  const started = Date.now()
  const pending = runCommand({ repo: dir, script, command: 'team', rawInput: 'sleep', signal: ac.signal, spawnImpl })
  setTimeout(() => ac.abort(), 300)
  const r = await pending
  assert.deepEqual(r, { kind: 'error', text: '/team cancelled' })
  assert.ok(Date.now() - started < 10000)
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'the child has exited')
})

test('an already-aborted signal never spawns', async () => {
  const ac = new AbortController()
  ac.abort()
  let spawned = false
  const r = await runCommand({ repo: dir, script, command: 'cost', rawInput: '', signal: ac.signal, spawnImpl: () => { spawned = true } })
  assert.equal(r.kind, 'error')
  assert.equal(spawned, false)
})
