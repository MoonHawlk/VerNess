/**
 * The pet's animation: the off switch (T-335g, `animationAllowed` is pure, so every condition is
 * tested from a fake environment), and the animator on a simulated terminal (T-335h): a fake clock,
 * a captured writer and a tiny VT screen, so frames advance, timers stop, and nothing is written off
 * a TTY - without touching the real stdout, which carries the test runner's protocol.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createAnimator, petAnimation, rowsOf } from '../lib/pet-anim.mjs'
import { animationAllowed, sideBySide } from '../lib/pet.mjs'

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

test('FINESS_NO_PET turns it off too, but empty or 0 does not', () => {
  assert.equal(animationAllowed({ ...ok, env: { FINESS_NO_PET: '1' } }).ok, false)
  assert.equal(animationAllowed({ ...ok, env: { FINESS_NO_PET: '' } }).ok, true)
  assert.equal(animationAllowed({ ...ok, env: { FINESS_NO_PET: '0' } }).ok, true)
})

test('no argument at all is a safe no', () => {
  assert.equal(animationAllowed().ok, false)
})

// ---------------------------------------------------------------- the animator (T-335f, T-335h)

/** A fake clock: timers fire only when `tick(ms)` advances past them. */
function fakeClock() {
  let now = 0
  let seq = 0
  const timers = new Map()
  return {
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout: id => { timers.delete(id) },
    tick(ms) {
      const until = now + ms
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (next === undefined || next[1].at > until) break
        timers.delete(next[0]); now = next[1].at; next[1].fn()
      }
      now = until
    },
    pending: () => timers.size,
  }
}

/**
 * A minimal VT screen: \r, \n, CUU (A), CUF (C), SGR (m, ignored), DECSC/DECRC (ESC 7/8) and
 * auto-wrap - enough to replay what the animator writes and see what the reader is left looking at.
 * @param {string[]} rows - the screen before, one string per row; the cursor starts on the last.
 * @param {number} col - the cursor's starting column.
 * @returns {{feed(s: string): void, rows: string[], cursor(): [number, number]}} the screen.
 */
function screen(rows, col) {
  const g = rows.map(r => [...r])
  let r = g.length - 1
  let c = col
  let saved
  return {
    feed(s) {
      for (let i = 0; i < s.length;) {
        if (s[i] === '\x1b' && (s[i + 1] === '7' || s[i + 1] === '8')) {
          if (s[i + 1] === '7') saved = [r, c]
          else [r, c] = saved
          i += 2
          continue
        }
        const m = s.slice(i).match(/^\x1b\[([0-9;]*)([A-Za-z])/)
        if (m !== null) {
          const n = m[1] === '' ? 1 : Math.max(1, Number(m[1]))
          if (m[2] === 'A') r = Math.max(0, r - n)
          if (m[2] === 'C') c += n
          i += m[0].length
          continue
        }
        const ch = s[i++]
        if (ch === '\r') c = 0
        else if (ch === '\n') { r++; c = 0; g[r] ??= [] }
        else { g[r][c] = ch; c++ }
      }
    },
    get rows() { return g.map(x => Array.from(x, ch => ch ?? ' ').join('')) },
    cursor: () => [r, c],
  }
}

const frames = [{ lines: ['A1', 'A2'], ms: 100 }, { lines: ['B1', 'A2'], ms: 100 }]
const anim = (c, out, extra = {}) => createAnimator({
  tracks: [{ frames, loop: true, jitter: 0 }], drawn: frames[0].lines, column: 2,
  write: s => out.push(s), rows: () => 40, ...c, ...extra,
})

test('frames advance on the clock and loop; only changed rows are written; stop clears the timer', () => {
  const c = fakeClock(); const out = []
  const a = anim(c, out)
  a.place({ bottom: 3 })
  a.start()
  assert.equal(out.length, 0, 'frame 0 is what is already drawn')
  c.tick(100); c.tick(100); c.tick(100)
  assert.deepEqual(out.map(s => (s.includes('B1') ? 'B' : 'A')), ['B', 'A', 'B'])
  assert.ok(out.every(s => !s.includes('A2')), 'the unchanged row is never rewritten')
  assert.equal(a.running(), true)
  a.stop()
  assert.equal(c.pending(), 0)
  assert.equal(a.running(), false)
  c.tick(1000)
  assert.equal(out.length, 3, 'nothing after stop')
})

test('a repaint saves the cursor, climbs past the rows below, writes only the art columns, restores', () => {
  const c = fakeClock(); const out = []
  anim(c, out).place({ bottom: 3 })
  // `place` before `start` is how the REPL drives it; start via a fresh animator for clarity.
  const a = anim(c, out); a.place({ bottom: 3 }); a.start(); c.tick(100)
  const s = out.at(-1)
  assert.ok(s.startsWith('\x1b7') && s.endsWith('\x1b8'))
  assert.ok(s.includes('\x1b[4A'), 'row 0 of a 2-row art is bottom + 1 = 4 rows up')
  assert.ok(s.includes('\x1b[2C'), 'indented by the column')
  assert.doesNotMatch(s, /\x1b\[[0-2]?K|\x1b\[2J/, 'never clears a line: the panel sits beside the art')
  a.stop()
})

test('simulated terminal: the art changes in place, the panel beside it and the prompt stay put', () => {
  const art = ['  A1   panel one', '  A2   panel two']
  const below = ['     a hint line', '  status', 'finess> ab']
  const scr = screen([...art, ...below], 10)
  const c = fakeClock()
  const a = createAnimator({ tracks: [{ frames, loop: true, jitter: 0 }], drawn: frames[0].lines, column: 2, write: s => scr.feed(s), rows: () => 40, ...c })
  // The cursor is on the input row: 3 rows below the art's last row (hint, status, input).
  a.place({ bottom: 3 }); a.start(); c.tick(100)
  assert.deepEqual(scr.rows, ['  B1   panel one', '  A2   panel two', ...below])
  assert.deepEqual(scr.cursor(), [4, 10], 'the cursor is back where the editor left it')
  c.tick(100)
  assert.deepEqual(scr.rows, [...art, ...below])
  a.stop()
})

test('holds while the dropdown is open, then catches up', () => {
  const c = fakeClock(); const out = []
  const a = anim(c, out)
  a.place({ bottom: 2, hold: true }); a.start(); c.tick(100)
  assert.equal(out.length, 0, 'nothing drawn while the editor shows its dropdown')
  a.place({ bottom: 2, hold: false })
  assert.equal(out.length, 1, 'the frame due is painted once the dropdown closes')
  assert.ok(out[0].includes('B1'))
  a.stop()
})

test('nothing is drawn before the editor says where its cursor is', () => {
  const c = fakeClock(); const out = []
  const a = anim(c, out)
  a.start(); c.tick(500)
  assert.equal(out.length, 0)
  a.stop()
})

test('stops instead of painting when the art may have scrolled off the screen', () => {
  const c = fakeClock(); const out = []
  // Row 0 of a 2-row art with the cursor 5 below the last row is 6 up: it needs 7 rows on screen.
  const a = anim(c, out, { rows: () => 6 })
  a.place({ bottom: 5 }); a.start(); c.tick(100)
  assert.equal(out.length, 0)
  assert.equal(a.running(), false)
  assert.equal(c.pending(), 0)
  const u = anim(c, out, { rows: () => undefined })
  u.place({ bottom: 1 }); u.start(); c.tick(100)
  assert.equal(out.length, 0, 'unknown height: never paint')
})

test('rows above `from` are never written (a happy sheep has no mark row on screen)', () => {
  const c = fakeClock(); const out = []
  const marks = [{ lines: ['  ', 'A1'], ms: 100 }, { lines: ['! ', 'A1'], ms: 100 }]
  const a = createAnimator({ tracks: [{ frames: marks, loop: true, jitter: 0 }], drawn: marks[0].lines, from: 1, write: s => out.push(s), rows: () => 40, ...c })
  a.place({ bottom: 1 }); a.start(); c.tick(1000)
  assert.equal(out.length, 0)
  a.stop()
})

test('once, then loop: the intro plays, hands over, and a final one-shot stays on its last frame', () => {
  const c = fakeClock(); const out = []
  const intro = { loop: false, jitter: 0, frames: [{ lines: ['I1', 'A2'], ms: 50 }, { lines: ['A1', 'A2'], ms: 0 }] }
  const a = createAnimator({ tracks: [intro, { frames, loop: true, jitter: 0 }], drawn: frames[0].lines, write: s => out.push(s), rows: () => 40, ...c })
  a.place({ bottom: 1 }); a.start()
  assert.ok(out[0].includes('I1'), 'the intro starts at once')
  c.tick(50)
  assert.ok(out[1].includes('A1'), 'back to rest')
  c.tick(100)
  assert.ok(out[2].includes('B1'), 'then the loop')
  a.stop()
  const once = createAnimator({ tracks: [intro], drawn: frames[0].lines, write: s => out.push(s), rows: () => 40, ...c })
  once.place({ bottom: 1 }); once.start(); c.tick(1000)
  assert.equal(once.running(), false)
  assert.equal(c.pending(), 0)
})

test('jitter randomises the wait within its bounds', () => {
  const c = fakeClock(); const out = []
  const a = anim(c, out, { tracks: [{ frames, loop: true, jitter: 0.5 }], random: () => 1 })
  a.place({ bottom: 1 }); a.start()
  c.tick(149)
  assert.equal(out.length, 0, '100 ms + 50% = 150 ms')
  c.tick(1)
  assert.equal(out.length, 1)
  a.stop()
})

// ---------------------------------------------------------------- the REPL's controller

const vitals = () => ({
  name: 'Ness', persona: 'generalist', model: 'm', route: 'r', session: undefined,
  versions: { finess: '0', commit: undefined, node: '24', dsh: { installed: '1', pinned: '1' }, engine: undefined },
  workers: { engine: { remote: true, baseURL: 'x' }, decision: { up: false, enabled: false } },
  roster: { personas: 1, teams: 0 }, recent: {}, now: 0,
})
/** A fake terminal: captured writes and the listeners it was given. */
const term = over => {
  const writes = []
  const listeners = new Map()
  return {
    isTTY: true, columns: WIDE, rows: 50, writes, listeners,
    write: s => { writes.push(String(s)); return true },
    on: (e, f) => listeners.set(e, f),
    off: (e, f) => { if (listeners.get(e) === f) listeners.delete(e) },
    ...over,
  }
}

test('off a TTY nothing is written and no timer starts, even once the editor reports', () => {
  const c = fakeClock()
  const out = term({ isTTY: false })
  const p = petAnimation({ vitals: vitals(), cfg: {}, after: 3, out, env: {}, proc: out, ...c })
  p.onRender({ row: 1, dropdown: false })
  c.tick(60000)
  assert.equal(out.writes.length, 0)
  assert.equal(c.pending(), 0)
  assert.match(p.why, /terminal/)
  p.stop()
})

test('the opt-outs reach the REPL controller: pet.animate false and FINESS_NO_PET draw nothing', () => {
  for (const [cfg, env] of [[{ pet: { animate: false } }, {}], [{}, { FINESS_NO_PET: '1' }], [{ pet: { enabled: false } }, {}]]) {
    const c = fakeClock(); const out = term()
    const p = petAnimation({ vitals: vitals(), cfg, after: 3, out, env, proc: out, ...c })
    p.onRender({ row: 1, dropdown: false }); c.tick(60000)
    assert.equal(out.writes.length, 0, JSON.stringify({ cfg, env }))
    assert.equal(c.pending(), 0)
  }
})

test('on a TTY: starts at the first redraw, blinks, and stop removes its timer and listeners', () => {
  const c = fakeClock(); const out = term()
  const p = petAnimation({ vitals: vitals(), cfg: {}, after: 3, out, env: {}, proc: out, random: () => 0.5, ...c })
  assert.equal(c.pending(), 0, 'nothing before the editor draws')
  assert.ok(out.listeners.has('exit') && out.listeners.has('resize'))
  p.onRender({ row: 1, dropdown: false })
  assert.equal(p.running(), true)
  c.tick(3500)
  assert.equal(out.writes.length, 1, 'the blink')
  assert.match(out.writes[0], /\x1b\[9A/, 'eye row 4 of 9 is 4 above the last art row; + 3 printed + 1 + editor row 1')
  p.stop()
  assert.equal(c.pending(), 0)
  assert.equal(out.listeners.size, 0)
})

// A boot-like prompt: 13 rows printed under the pet (blank, header, command bar, info lines), the
// editor's status line above the input, so the cursor is 15 rows below her hooves.
const BOOT_AFTER = 13

test('a default 80x24 terminal: the blink fits until a dropdown may have scrolled her away', () => {
  const c = fakeClock(); const out = term({ columns: 80, rows: 24 })
  const p = petAnimation({ vitals: vitals(), cfg: {}, after: BOOT_AFTER, out, env: {}, proc: out, random: () => 0.5, ...c })
  p.onRender({ row: 1, dropdown: false, below: 0 })
  c.tick(3500)
  assert.equal(out.writes.length, 1, 'the eye row is 19 rows up: it fits in 24')
  c.tick(150)
  assert.equal(out.writes.length, 2, 'eye open again')
  p.onRender({ row: 1, dropdown: true, below: 7 })
  p.onRender({ row: 1, dropdown: false, below: 0 })
  c.tick(10000)
  assert.equal(out.writes.length, 2, 'a 7-row dropdown may have scrolled the eye off: nothing more')
  assert.equal(p.running(), false)
  assert.equal(c.pending(), 0)
  p.stop()
})

test('sleepy: the z reaches the mark row only when the terminal is tall enough', () => {
  const sleepy = () => { const v = vitals(); v.workers.engine = { up: true, loaded: [] }; return v }
  const tall = fakeClock(); const big = term({ columns: 80, rows: 30 })
  const p = petAnimation({ vitals: sleepy(), cfg: {}, after: BOOT_AFTER, out: big, env: {}, proc: big, random: () => 0.5, ...tall })
  p.onRender({ row: 1, dropdown: false, below: 0 })
  tall.tick(1800 + 700 * 3)
  assert.equal(big.writes.length, 4, 'a full drift, back to the mark row')
  assert.equal(p.running(), true)
  p.stop()
  const short = fakeClock(); const small = term({ columns: 80, rows: 23 })
  const q = petAnimation({ vitals: sleepy(), cfg: {}, after: BOOT_AFTER, out: small, env: {}, proc: small, random: () => 0.5, ...short })
  q.onRender({ row: 1, dropdown: false, below: 0 })
  short.tick(10000)
  assert.equal(small.writes.length, 0, 'the mark row is 23 rows up: out of reach in 23')
  assert.equal(q.running(), false)
  assert.equal(short.pending(), 0)
})

test('a resize stops her', () => {
  const c = fakeClock(); const out = term()
  const p = petAnimation({ vitals: vitals(), cfg: {}, after: 0, out, env: {}, proc: out, ...c })
  p.onRender({ row: 1, dropdown: false })
  out.listeners.get('resize')()
  assert.equal(p.running(), false)
  assert.equal(c.pending(), 0)
})

test('rowsOf counts wrapped lines, ignores colour, and refuses a line that exactly fills the width', () => {
  assert.equal(rowsOf(['', 'abc', '\x1b[2mabc\x1b[0m'], 10), 3)
  assert.equal(rowsOf(['x'.repeat(25)], 10), 3)
  assert.equal(rowsOf(['x'.repeat(20)], 10), undefined)
})
