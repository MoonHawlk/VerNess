/**
 * The command guard (`packages/guard`, T-473): the `tools/pre-execute` listener against a fake ctx,
 * a fake approval service and a fake terminal (yes+DELETE runs, anything else denies, no channel
 * denies), the REPL's `!cmd` gate with an injected terminal, the piped REPL refusing, `/guard`, and
 * the patch row. Never touches a real terminal: every channel is injected or forced off.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DENIED, apply, commandOf, confirmOnTty, confirmViaApproval, createGuard, guardShellLine, modeOf, openTty, shown } from '../../packages/guard/index.js'
import { guardStatus } from '../commands/guard.mjs'
import { renderPatch } from '../finess.mjs'
import { REPO } from '../lib/util.mjs'

/** A fake terminal that answers from a list and records what was written. */
function fakeTty(answers) {
  const q = [...answers]
  const out = []
  let closed = false
  return { out, get closed() { return closed }, write: s => { out.push(s) }, readLine: () => (q.length > 0 ? q.shift() : null), close: () => { closed = true } }
}

/** A fake approval service answering from a list. */
function fakeApproval(outcomes, policy = 'ask') {
  const q = [...outcomes]
  const asked = []
  return { asked, config: { policy }, overrideOf: () => undefined, request: async req => { asked.push(req); return q.shift() ?? 'unavailable' } }
}

const exec = (command, name = 'bash') => ({ callId: 'c1', name, arguments: { command, text: command }, agent: { session: {} } })
const allow = async () => ({ kind: 'allow' })

/** Run one call through a guard; report the decision and whether the gate chain went on. */
async function run(guard, e, next = allow) {
  let nexted = false
  const d = await guard(e, async () => { nexted = true; return next() })
  return { d, nexted }
}

test('commandOf: only the command-running tools, only string commands', () => {
  assert.equal(commandOf(exec('ls')), 'ls')
  assert.equal(commandOf(exec('ls', 'pwsh')), 'ls')
  assert.equal(commandOf({ name: 'terminal_send', arguments: { text: 'rm -rf x' } }), 'rm -rf x')
  assert.equal(commandOf({ name: 'write', arguments: { command: 'rm -rf x' } }), undefined)
  assert.equal(commandOf({ name: 'bash', arguments: { command: 3 } }), undefined)
  assert.equal(commandOf({ name: 'bash' }), undefined)
})

test('modeOf: only an explicit "deny" weakens nothing; junk is confirm-twice', () => {
  assert.equal(modeOf({ irreversible: 'deny' }), 'deny')
  for (const c of [undefined, null, {}, { irreversible: 'allow' }, { irreversible: 'off' }, 'deny']) assert.equal(modeOf(c), 'confirm-twice')
})

test('listener: a harmless command passes straight through, no prompt', async () => {
  let opened = false
  const g = createGuard({ openTty: () => { opened = true; return fakeTty([]) } })
  const r = await run(g, exec('ls -la'))
  assert.deepEqual(r, { d: { kind: 'allow' }, nexted: true })
  assert.equal(opened, false)
})

test('listener (terminal): yes + DELETE runs; the full command and reasons are shown', async () => {
  const tty = fakeTty(['yes', 'DELETE'])
  const g = createGuard({ openTty: () => tty })
  const r = await run(g, exec('rm -rf build'))
  assert.deepEqual(r.d, { kind: 'allow' })
  const text = tty.out.join('')
  assert.match(text, /rm -rf build/)
  assert.match(text, /rm -r: deletes a whole directory tree/)
  assert.match(text, /type yes to continue/)
  assert.match(text, /type DELETE \(or rm\) to confirm/)
  assert.equal(tty.closed, true)
})

test('listener (terminal): the command\'s first word is accepted as the second answer', async () => {
  const g = createGuard({ openTty: () => fakeTty(['YES', 'git']) })
  assert.deepEqual((await run(g, exec('git reset --hard'))).d, { kind: 'allow' })
})

test('listener (terminal): yes + a wrong word, no, or end of input all deny with the model-facing reason', async () => {
  for (const answers of [['yes', 'delete'], ['yes', 'y'], ['no'], ['y', 'DELETE'], [], ['yes']]) {
    const g = createGuard({ openTty: () => fakeTty(answers) })
    const { d } = await run(g, exec('git push --force'))
    assert.equal(d.kind, 'deny', String(answers))
    assert.ok(d.reason.startsWith(DENIED), d.reason)
    assert.match(d.reason, /push --force/)
  }
})

test('listener: no terminal and no approval answerer denies, never allows', async () => {
  const g = createGuard({ openTty: () => null, getApproval: () => fakeApproval(['unavailable']) })
  const { d } = await run(g, exec('rm -rf /'))
  assert.equal(d.kind, 'deny')
  assert.ok(d.reason.startsWith(DENIED))
})

test('listener (web surface): approval unavailable never falls back to a terminal', async () => {
  let opened = false
  const g = createGuard({ surface: 'web', openTty: () => { opened = true; return fakeTty(['yes', 'DELETE']) }, getApproval: () => undefined })
  assert.equal((await run(g, exec('rm -rf x'))).d.kind, 'deny')
  assert.equal(opened, false)
})

test('listener (approval service): two sequential asks; both granted runs', async () => {
  const ap = fakeApproval(['allowed-once', 'allowed-once'])
  const g = createGuard({ getApproval: () => ap, openTty: () => { throw new Error('terminal must not be used') } })
  assert.deepEqual((await run(g, exec('del /s /q *.tmp', 'pwsh'))).d, { kind: 'allow' })
  assert.equal(ap.asked.length, 2)
  assert.match(ap.asked[0].reason, /1 of 2.*del \/s \/q \*\.tmp.*del \/s/)
  assert.match(ap.asked[1].reason, /2 of 2/)
  assert.equal(ap.asked[0].callId, 'c1')
  assert.equal(ap.asked[0].toolName, 'pwsh')
})

test('listener (approval service): a first or second refusal denies without trying the terminal', async () => {
  for (const outcomes of [['rejected'], ['cancelled'], ['allowed-once', 'rejected'], ['allowed-once', 'unavailable']]) {
    const ap = fakeApproval(outcomes)
    const g = createGuard({ getApproval: () => ap, openTty: () => fakeTty(['yes', 'DELETE']) })
    assert.equal((await run(g, exec('git clean -fdx'))).d.kind, 'deny', String(outcomes))
  }
})

test('listener: approval unavailable (headless) or policy never falls back to the terminal', async () => {
  const unavailable = createGuard({ getApproval: () => fakeApproval(['unavailable']), openTty: () => fakeTty(['yes', 'DELETE']) })
  assert.equal((await run(unavailable, exec('rm -rf x'))).d.kind, 'allow')
  const never = fakeApproval(['rejected'], 'never')
  const g = createGuard({ getApproval: () => never, openTty: () => fakeTty(['yes', 'DELETE']) })
  assert.equal((await run(g, exec('rm -rf x'))).d.kind, 'allow')
  assert.equal(never.asked.length, 0)
  const throwing = { request: async () => { throw new Error('no open turn') } }
  assert.equal(await confirmViaApproval(throwing, exec('x'), 'x', []), 'unavailable')
  assert.equal(await confirmViaApproval(fakeApproval(['allowed-once']), { name: 'bash' }, 'x', []), 'unavailable')
})

test('listener: another gate\'s deny wins with no prompt; its ask is kept after confirming', async () => {
  let opened = false
  const g = createGuard({ openTty: () => { opened = true; return fakeTty(['yes', 'DELETE']) } })
  const denied = await run(g, exec('rm -rf x'), async () => ({ kind: 'deny', reason: 'policy' }))
  assert.deepEqual(denied.d, { kind: 'deny', reason: 'policy' })
  assert.equal(opened, false)
  const asked = await run(g, exec('rm -rf x'), async () => ({ kind: 'ask', reason: 'persona' }))
  assert.deepEqual(asked.d, { kind: 'ask', reason: 'persona' })
})

test('listener: mode deny refuses without asking anyone', async () => {
  let opened = false
  const ap = fakeApproval(['allowed-once', 'allowed-once'])
  const g = createGuard({ mode: 'deny', getApproval: () => ap, openTty: () => { opened = true; return null } })
  const { d } = await run(g, exec('git branch -D feat'))
  assert.equal(d.kind, 'deny')
  assert.match(d.reason, /"deny"/)
  assert.equal(opened, false)
  assert.equal(ap.asked.length, 0)
})

test('listener: parallel irreversible calls are confirmed one at a time', async () => {
  let open = 0
  let max = 0
  const ap = { request: async () => { open++; max = Math.max(max, open); await new Promise(r => setTimeout(r, 5)); open--; return 'allowed-once' } }
  const g = createGuard({ getApproval: () => ap })
  const all = await Promise.all([run(g, exec('rm -rf a')), run(g, exec('rm -rf b')), run(g, exec('rm -rf c'))])
  assert.ok(all.every(r => r.d.kind === 'allow'))
  assert.equal(max, 1)
})

test('apply: mounts on tools/pre-execute, reads mode/surface from config and approval from ctx', async () => {
  const on = new Map()
  const ap = fakeApproval(['allowed-once', 'rejected'])
  apply({ on: (e, fn) => on.set(e, fn), get: k => (k === 'approval' ? ap : undefined) }, { irreversible: 'confirm-twice', surface: 'web' })
  const d = await on.get('tools/pre-execute')(exec('rm -rf x'), allow)
  assert.equal(d.kind, 'deny')
  assert.equal(ap.asked.length, 2)
})

test('shown: control characters and ANSI escapes cannot disguise a command', () => {
  assert.equal(shown('rm -rf /\u001b[2K\rls'), 'rm -rf /\\u001b[2K\\u000dls')
  assert.equal(shown('a\nb'), 'a\\nb')
  const tty = fakeTty(['no'])
  confirmOnTty(tty, 'echo ok\u001b[1A\u001b[2Krm -rf /', ['x'])
  assert.doesNotMatch(tty.out.join(''), /\u001b/)
})

test('openTty: FINESS_GUARD_TTY=none means no terminal', () => {
  assert.equal(openTty({ env: { FINESS_GUARD_TTY: 'none' } }), null)
})

test('openTty: a POSIX run with no /dev/tty uses a terminal stderr and never closes it', () => {
  // Opened only, never read. Where /dev/tty exists this is the real device; elsewhere stderr.
  const io = openTty({ platform: 'linux', env: {}, isatty: fd => fd === 2 })
  assert.notEqual(io, null)
  io.close()
  process.stderr.write('') // fd 2 still open
})

test('shown: bidi overrides are escaped too', () => {
  assert.equal(shown('rm -rf \u202e/'), 'rm -rf \\u202e/')
})

test('REPL gate: harmless runs, irreversible needs yes + DELETE, piped or deny mode refuses', () => {
  assert.equal(guardShellLine('echo hi', { mode: 'confirm-twice', io: null }).run, true)
  const tty = fakeTty(['yes', 'DELETE'])
  assert.equal(guardShellLine('rm -rf build', { mode: 'confirm-twice', io: tty }).run, true)
  assert.match(tty.out.join(''), /FiNess guard: you want to run an IRREVERSIBLE command/)
  const no = guardShellLine('rm -rf build', { mode: 'confirm-twice', io: fakeTty(['yes', 'nope']) })
  assert.deepEqual([no.run, no.message], [false, DENIED])
  assert.match(guardShellLine('rm -rf build', { mode: 'confirm-twice', io: null }).message, /no terminal/)
  assert.match(guardShellLine('rm -rf build', { mode: 'deny', io: fakeTty(['yes', 'DELETE']) }).message, /"deny"/)
})

test('REPL piped: !rm -rf is refused and the directory survives', () => {
  const home = mkdtempSync(join(tmpdir(), 'finess-guard-'))
  const victim = join(home, 'victim')
  mkdirSync(victim)
  try {
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'finess.mjs'), '--no-model'], {
      cwd: REPO, input: `!rm -rf "${victim.replaceAll('\\', '/')}"\n!echo guard-still-here\n`, encoding: 'utf8', windowsHide: true, timeout: 60000,
      env: { ...process.env, DSH_HOME: home, NO_COLOR: '1', FINESS_NO_PET: '1', DSH_PERMISSION_MODE: 'workspace-write', FINESS_GUARD_TTY: 'none' },
    })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /refused: irreversible command and no terminal to confirm it on: rm -r/)
    assert.match(r.stdout, /guard-still-here/)
    assert.equal(existsSync(victim), true)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('/guard: status names the mode and whether the row is enforced', () => {
  const row = { id: 'finess-guard', package: '@finess/guard', path: 'packages/guard', enabled: true, config: { irreversible: 'deny' } }
  assert.match(guardStatus({ settings: { plugins: [row] } }).join('\n'), /\[enforced\][\s\S]*mode: +deny/)
  assert.match(guardStatus({ settings: { plugins: [{ ...row, enabled: false }] } }).join('\n'), /DISABLED[\s\S]*mode: +deny/)
  assert.match(guardStatus({ settings: { plugins: [] } }).join('\n'), /NOT configured/)
})

test('renderPatch: the guard row carries its config and the surface', () => {
  const row = { id: 'finess-guard', package: '@finess/guard', path: 'packages/guard', enabled: true, surfaceConfig: true, config: { irreversible: 'confirm-twice' } }
  const cfg = {
    profile: { name: 'guard-test', template: 'headless' },
    model: { route: 'local', id: 'small', source: 'hf.co/org/small:Q8_0', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'LOCAL_KEY' },
    extraRoutes: {}, activeRoute: '', personas: { active: 'p', definitions: { p: { prefix: 'P', suffix: 'S' } } },
    settings: { plugins: [row], toolsMode: 'native' }, tips: [],
  }
  assert.match(renderPatch(cfg, { surface: 'headless', state: {} }), /- id: finess-guard\n {6}name: '@finess\/guard'\n {6}config:\n {8}irreversible: "confirm-twice"\n {8}surface: "headless"\n/)
  assert.match(renderPatch(cfg, { surface: 'web', state: {} }), /surface: "web"/)
})
