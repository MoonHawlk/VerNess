/** Finish notices (T-445): the decision, the text, the per-OS command and the injected spawn. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { desktopCommand, notifyDone, notifyText, shouldNotify, withNotify } from '../lib/notify.mjs'

const base = { elapsedMs: 31000, cfg: {}, isTTY: true, env: {} }

test('shouldNotify: threshold, TTY and CI', () => {
  assert.equal(shouldNotify(base), true)
  assert.equal(shouldNotify({ ...base, elapsedMs: 29000 }), false)
  assert.equal(shouldNotify({ ...base, isTTY: false }), false)
  assert.equal(shouldNotify({ ...base, env: { CI: 'true' } }), false)
  assert.equal(shouldNotify({ ...base, env: { CI: '' } }), true)
  assert.equal(shouldNotify({ ...base, elapsedMs: 5000, cfg: { notify: { afterSeconds: 5 } } }), true)
  assert.equal(shouldNotify({ ...base, elapsedMs: 5000, cfg: { notify: { afterSeconds: 'x' } } }), false, 'bad value falls back to 30')
})

test('notifyText: done/failed, trimmed label, duration', () => {
  assert.equal(notifyText({ what: 'fix  the\nbug', ok: true, elapsedMs: 42000 }), 'done: fix the bug (42s)')
  assert.equal(notifyText({ what: 'x', ok: false, elapsedMs: 125000 }), 'failed: x (2m5s)')
  assert.match(notifyText({ what: 'a'.repeat(200), ok: true }), /^done: a{49}…$/)
  assert.equal(notifyText({ what: '', ok: true }), 'done: task')
})

test('desktopCommand: args arrays per OS, text never in the script', () => {
  const w = desktopCommand('win32', 'T', 'it"s $(bad)')
  assert.equal(w.cmd, 'powershell')
  assert.equal(w.env.FINESS_N_BODY, 'it"s $(bad)')
  assert.ok(!w.args.join(' ').includes('bad'))
  const m = desktopCommand('darwin', 'T', 'B')
  assert.equal(m.cmd, 'osascript')
  assert.deepEqual(m.args.slice(-2), ['T', 'B'])
  assert.deepEqual(desktopCommand('linux', 'T', 'B'), { cmd: 'notify-send', args: ['T', 'B'] })
})

test('notifyDone: bell + title always, desktop only when asked, failures silent', () => {
  const out = []; const spawned = []
  const io = { write: s => out.push(s), spawnFn: (...a) => spawned.push(a), isTTY: true, env: {}, platform: 'linux' }
  const run = { what: 'job', ok: true, elapsedMs: 40000 }
  assert.equal(notifyDone(run, {}, io), true)
  assert.match(out[0], /^\x07\x1b\]0;FiNess done: job \(40s\)\x07$/)
  assert.equal(spawned.length, 0)
  notifyDone(run, { notify: { desktop: true } }, io)
  assert.equal(spawned.length, 1)
  assert.equal(notifyDone({ ...run, elapsedMs: 1 }, {}, io), false)
  assert.equal(notifyDone(run, { notify: { desktop: true } }, { ...io, spawnFn: () => { throw new Error('boom') } }), true)
})

test('withNotify: passes the result, notifies failure on throw', async () => {
  const out = []
  const io = { write: s => out.push(s), isTTY: true, env: {} }
  const cfg = { notify: { afterSeconds: 0 } }
  assert.equal(await withNotify(cfg, 'a', () => 7, r => r === 7, io), 7)
  assert.match(out[0], /done: a/)
  await assert.rejects(withNotify(cfg, 'b', () => { throw new Error('x') }, undefined, io))
  assert.match(out[1], /failed: b/)
})
