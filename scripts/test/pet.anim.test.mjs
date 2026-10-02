/**
 * The pet's animation off switch (T-335g): `animationAllowed` is pure, so every condition is tested
 * from a fake environment, with no terminal and no timers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { animatePet, animationAllowed, sideBySide } from '../lib/pet.mjs'

const WIDE = 160
const ok = { isTTY: true, columns: WIDE, env: {}, cfg: { pet: {} } }

test('on by default: a wide terminal, no config, no env', () => {
  assert.deepEqual(animationAllowed(ok), { ok: true })
  assert.equal(animationAllowed({ ...ok, cfg: {} }).ok, true, 'no pet section at all')
  assert.equal(animationAllowed({ ...ok, cfg: { pet: { animate: true } } }).ok, true)
})

test('pet.animate: false turns it off', () => {
  const r = animationAllowed({ ...ok, cfg: { pet: { animate: false } } })
  assert.equal(r.ok, false)
  assert.match(r.why, /pet\.animate/)
})

test('pet.enabled: false turns it off too', () => {
  assert.equal(animationAllowed({ ...ok, cfg: { pet: { enabled: false } } }).ok, false)
})

test('forced off when stdout is not a terminal', () => {
  assert.equal(animationAllowed({ ...ok, isTTY: false }).ok, false)
  assert.equal(animationAllowed({ ...ok, isTTY: undefined }).ok, false, 'a pipe has no isTTY')
})

test('forced off by NO_COLOR, even set but empty', () => {
  assert.equal(animationAllowed({ ...ok, env: { NO_COLOR: '1' } }).ok, false)
  const r = animationAllowed({ ...ok, env: { NO_COLOR: '' } })
  assert.equal(r.ok, false, 'NO_COLOR set but empty still counts (no-color.org)')
  assert.match(r.why, /NO_COLOR/)
})

test('forced off by CI', () => {
  assert.equal(animationAllowed({ ...ok, env: { CI: 'true' } }).ok, false)
  assert.equal(animationAllowed({ ...ok, env: { CI: '' } }).ok, false)
})

test('forced off below the side-by-side width, on at it', () => {
  let edge = 1
  while (!sideBySide(edge)) edge++
  assert.equal(animationAllowed({ ...ok, columns: edge }).ok, true, `${edge} columns is side by side`)
  const r = animationAllowed({ ...ok, columns: edge - 1 })
  assert.equal(r.ok, false)
  assert.match(r.why, /narrow/)
  assert.equal(animationAllowed({ ...ok, columns: undefined }).ok, false, 'unknown width')
})

test('no argument at all is a safe no', () => {
  assert.equal(animationAllowed().ok, false)
})

/**
 * Run `animatePet` against a fake terminal (isTTY true, empty environment), capturing every write.
 * @param {object} cfg - the configuration passed to it.
 * @returns {Promise<string[]>} what it wrote.
 */
async function captureOnTTY(cfg) {
  const v = {
    name: 'Ness', persona: 'generalist', model: 'm', route: 'r', session: undefined,
    versions: { verness: '0', commit: undefined, node: '24', dsh: { installed: '1', pinned: '1' }, engine: undefined },
    workers: { engine: { remote: true, baseURL: 'x' }, decision: { up: false, enabled: false } },
    roster: { personas: 1, teams: 0 }, recent: {}, now: 0,
  }
  // A fake terminal and a clean environment: the real stdout carries the test runner's protocol.
  const writes = []
  const out = { isTTY: true, write: s => { writes.push(String(s)); return true } }
  await animatePet(v, { columns: WIDE, cfg, out, env: {} })
  return writes
}
const CURSOR_UP = /\x1b\[\d+A/

test('animatePet obeys the switch on a terminal: pet.animate false draws a still panel', async () => {
  const writes = await captureOnTTY({ pet: { animate: false } })
  assert.ok(writes.some(w => w.includes('VerNess')), 'the panel is printed')
  assert.ok(!writes.some(w => CURSOR_UP.test(w)), 'no cursor-up: nothing animated')
})

test('animatePet animates on a terminal when allowed (control)', async () => {
  const writes = await captureOnTTY({ pet: { animate: true } })
  assert.ok(writes.some(w => CURSOR_UP.test(w)), 'frames overwrite in place')
})
