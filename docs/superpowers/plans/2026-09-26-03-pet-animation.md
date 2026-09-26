# WS-C — Pet: tests, animation, live workers, profile ownership: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Read
> `2026-09-26-00-master-plan.md` first. Requires WS-A Task 1 (`npm test`).

**Goal:** A pet test suite that survives redesigns, idle animation that can never corrupt the
terminal, live `/loop-task` and `/team` workers in the status panel, and a warning when another
checkout owns the shared dsh profile.

**Architecture:** Rendering stays pure (`petArt`, `renderPet`). Animation is a small scheduler,
`createAnimator()` in a new `scripts/lib/pet-anim.mjs`. It takes its clock, timers and writer as
parameters, so it is tested with a fake clock and never touches the real stdout in tests. It
animates **only** in the window where the distance between the art and the cursor is known: after
the pet is drawn and before the first line is submitted, and again after `/pet`. It pauses whenever
the line editor redraws.

**Tech stack:** Node ESM, ANSI escapes (`\x1b[<n>A`, `\x1b[<n>B`, `\r`, `\x1b[2K`), `node:test`.

**Spec:** `docs/03-BACKLOG.md` WS-C lines T-335a–h, T-334, T-336, T-338; `docs/04-PROGRESS.md`
entry "the pet".

## Read this first: the pet is being redesigned in parallel
As of 2026-09-26 there are **two** drawings:
- `main` working tree (uncommitted): a circle with moods `happy | curious | sad`, `petAnimFrames`,
  and a one-shot boot animation `animatePet`.
- branch `epic` (committed, 5338fd4): a baby sheep with moods `happy | sleepy | worried`, and a
  matching `scripts/test/pet.render.mjs`.

**Before Task 1, ask the owner which drawing is canonical and merge it onto the branch you work
on.** Every task below is written against the *shape* (a mood owns a list of frames of equal
size), never against a specific drawing or mood name. Mood names come from an exported constant.

## Global Constraints
Inherit the master plan. Also:
- ASCII only in the art (legacy Windows consoles mangle anything else).
- Every frame of every mood has the same height and width. The animator overwrites in place, so a
  shorter frame would leave debris.
- Animation is **off** when `pet.animate === false`, stdout is not a TTY, `NO_COLOR` or `CI` is set,
  or the terminal is narrower than the side-by-side layout (64 columns).
- One timer at most. Cleared on the first submitted line, on exit, and on SIGINT.

## Review Focus
1. Output printed between the pet and the prompt (a warning, the command bar) changes the distance
   to the art. The animator must be told that distance, never guess it. Task 3.
2. Terminal resize while animating (the side-by-side layout collapses to stacked): stop animating.
3. The editor's dropdown opening while a frame is written: the animator pauses on `render` and
   resumes after. Task 3.
4. `NO_COLOR=` (set but empty) counts as set, per no-color.org. Task 3 tests it.
5. A heartbeat file left behind by a crashed run must not show a live worker forever. Task 4.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `scripts/lib/pet.mjs` | modify | export `PET_MOODS`; `petFrames(mood)` returns frames + timings; vitals read live workers |
| `scripts/lib/pet-anim.mjs` | create | `createAnimator()`: scheduling, pausing, in-place repaint |
| `scripts/lib/prompt.mjs` | modify | `onRender` hook so the animator can pause |
| `scripts/lib/heartbeat.mjs` | create | `.verness/live/*.json` writer/reader |
| `scripts/loop-task.mjs`, `scripts/lib/teams.mjs` | modify | write heartbeats |
| `scripts/verness.mjs` | modify | start/stop the animator; stamp and check the profile patch owner |
| `scripts/test/pet.render.test.mjs` | rename + rewrite | mood-agnostic render test |
| `scripts/test/pet.anim.test.mjs` | create | fake-clock animator test |
| `scripts/test/heartbeat.test.mjs`, `scripts/test/profile-owner.test.mjs` | create | |

---

### Task 1: A render test that survives redesigns (T-338)

**Files:**
- Modify: `scripts/lib/pet.mjs` (export `PET_MOODS`)
- Rename: `scripts/test/pet.render.mjs` → `scripts/test/pet.render.test.mjs`, rewritten

**Interfaces:**
- Produces: `PET_MOODS: readonly string[]`, the moods `moodOf` can return, in priority order (the
  "broken" mood first). For the circle it is `['sad', 'curious', 'happy']`; for the sheep,
  `['worried', 'sleepy', 'happy']`.

- [ ] **Step 1: Export the constant** next to the frames in `pet.mjs`:

```js
/** Every mood `moodOf` can return, broken-first. Tests iterate this instead of naming moods. */
export const PET_MOODS = Object.freeze(Object.keys(FRAMES))
```

Reorder the `FRAMES` literal if needed so its key order is broken-first. If the drawing on your
branch has no `FRAMES` table (the cube did not), export the list literally.

- [ ] **Step 2: Rewrite the test as `node:test`, mood-agnostic**

```js
// scripts/test/pet.render.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PET_MOODS, ago, moodOf, petAnimFrames, petArt, renderPet } from '../lib/pet.mjs'

const NOW = Date.parse('2026-09-26T12:00:00Z')
const base = () => ({
  name: 'Ness', persona: 'generalist', model: 'qwen3:0.6b', route: 'ollama-local',
  session: 'session-a55aee3c-7456-4bd4-b39b-aa77d350aff9',
  versions: { verness: '0.0.1', commit: 'abc1234', node: '24.14.0', dsh: { installed: '0.1.7-rc.2', pinned: '0.1.7-rc.2' }, engine: { name: 'ollama', version: '0.32.13' } },
  workers: { engine: { up: true, loaded: [{ name: 'qwen3:0.6b', vram: 800 * 2 ** 20 }] }, decision: { up: false, enabled: false } },
  roster: { personas: 5, teams: 1, commands: 18 },
  recent: {}, now: NOW,
})
const ANSI = /\x1b\[/
const [BROKEN, IDLE, OK] = PET_MOODS

test('three moods, broken > idle > ok', () => {
  assert.equal(PET_MOODS.length, 3)
  assert.equal(moodOf(base()).mood, OK)
  const idle = base(); idle.workers.engine.loaded = []
  assert.equal(moodOf(idle).mood, IDLE)
  const down = base(); down.workers.engine.up = false
  assert.equal(moodOf(down).mood, BROKEN)
  assert.match(moodOf(down).says, /\/up/)
  const drift = base(); drift.versions.dsh.installed = '0.1.6'
  assert.equal(moodOf(drift).mood, BROKEN)
  const both = base(); both.workers.engine.up = false; both.workers.engine.loaded = []
  assert.equal(moodOf(both).mood, BROKEN, 'broken beats idle')
})

for (const mood of PET_MOODS) {
  test(`${mood}: every frame has the same size`, () => {
    const frames = petAnimFrames(mood)
    assert.ok(frames.length >= 1)
    const h = frames[0].length
    const w = frames[0][0].length
    for (const f of frames) {
      assert.equal(f.length, h, 'height')
      for (const l of f) assert.equal(l.length, w, `width of "${l}"`)
      for (const l of f) assert.match(l, /^[\x20-\x7e]*$/, 'ASCII only')
    }
  })
  test(`${mood}: resting art is as wide as the frames`, () => {
    for (const l of petArt(mood)) assert.equal(l.length, petAnimFrames(mood)[0][0].length)
  })
}

test('side by side at 80 columns, stacked at 40, never wider than the terminal', () => {
  for (const cols of [80, 64, 40]) {
    for (const l of renderPet(base(), { columns: cols })) assert.ok(l.replace(/\x1b\[[0-9;]*m/g, '').length <= cols, `${cols}: "${l}"`)
  }
})

test('no escape codes off a TTY', () => {
  const was = process.stdout.isTTY
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
  try { for (const l of renderPet(base(), {})) assert.doesNotMatch(l, ANSI) } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: was, configurable: true })
  }
})

test('unknown values render instead of crashing', () => {
  const v = base(); v.versions.dsh = {}; v.versions.engine = undefined; v.session = undefined
  assert.ok(renderPet(v, { columns: 80 }).length > 0)
})

test('ago', () => {
  assert.equal(ago(42e3), '42s'); assert.equal(ago(5 * 60e3), '5m'); assert.equal(ago(3 * 3600e3), '3h'); assert.equal(ago(2 * 86400e3), '2d')
})
```

Port any assertion from the old test that checks something specific to the current drawing (for
example the cube's corner checks) into a clearly named extra test. Delete it if that drawing is gone.

- [ ] **Step 3: Run it**

```bash
git mv scripts/test/pet.render.mjs scripts/test/pet.render.test.mjs   # then paste the new content
npm test
```

Expected: PASS on the canonical drawing.

- [ ] **Step 4: Commit** — `test(pet): mood-agnostic render test under node:test (T-338)`

---

### Task 2: Frames with timings (T-335a, remaining part)

**Files:**
- Modify: `scripts/lib/pet.mjs`
- Test: append to `scripts/test/pet.render.test.mjs`

**Interfaces:**
- Produces: `petFrames(mood): {frames: {lines: string[], ms: number}[], loop: boolean, jitter: number}`.
  `ms` is how long a frame stays. `loop: false` plays once, then rests on the last frame.
  `jitter` (0..1) randomises `ms` by ±`jitter` so idle motion does not look mechanical.
  `petAnimFrames(mood)` stays as it is (the boot animation uses it); it becomes
  `petFrames(mood).frames.map(f => f.lines)`.

- [ ] **Step 1: Failing test (append)**

```js
import { petFrames } from '../lib/pet.mjs'

for (const mood of PET_MOODS) {
  test(`${mood}: timings are sane`, () => {
    const p = petFrames(mood)
    assert.equal(typeof p.loop, 'boolean')
    assert.ok(p.jitter >= 0 && p.jitter <= 1)
    for (const f of p.frames) assert.ok(Number.isInteger(f.ms) && f.ms >= 80 && f.ms <= 10000, `${mood}: ${f.ms} ms`)
    assert.deepEqual(p.frames.map(f => f.lines), petAnimFrames(mood))
  })
}
```

- [ ] **Step 2: Implement.** Add a `TIMING` table beside `FRAMES`, one entry per mood, for example:

```js
/**
 * How each mood moves. The ok mood blinks: a long rest frame, then ~150 ms with eyes closed
 * (T-335b), with jitter so the blink never looks mechanical. The idle mood loops its drifting mark
 * slowly (T-335c). The broken mood pulses its `!` (T-335e).
 */
const TIMING = {
  happy:   { ms: [3500, 150], loop: true, jitter: 0.4 },
  curious: { ms: [700, 700, 700, 1400], loop: true, jitter: 0.1 },
  sad:     { ms: [900, 600], loop: true, jitter: 0 },
}

/** @param {string} mood @returns {{frames: {lines: string[], ms: number}[], loop: boolean, jitter: number}} */
export function petFrames(mood) {
  const lines = petAnimFrames(mood)
  const t = TIMING[mood] ?? { ms: [1000], loop: false, jitter: 0 }
  return { frames: lines.map((l, i) => ({ lines: l, ms: t.ms[i] ?? t.ms.at(-1) })), loop: t.loop, jitter: t.jitter }
}
```

Use the real mood keys of the canonical drawing. **Frame content for blink and pulse:** the
drawing's author adds the frames (for the blink, a copy of the rest frame with the eyes replaced by
`-`; for the pulse, the rest frame with the `!` mark replaced by a space). Keep the boot one-shot
`animatePet` working on its own frames. If the boot frames and the idle frames differ, keep two
tables, `BOOT_FRAMES` and `IDLE_FRAMES`, and point `petFrames` at `IDLE_FRAMES`.

- [ ] **Step 3: Tests pass; commit** — `feat(pet): per-frame timings and loop flags (T-335a, T-335b, T-335c, T-335e)`

---

### Task 3: The animator: safe redraw and the off switch (T-335f, T-335g, T-335h)

**Files:**
- Create: `scripts/lib/pet-anim.mjs`
- Modify: `scripts/lib/prompt.mjs` (`readLineWithSuggestions` accepts `onRender?: (phase: 'before'|'after') => void`)
- Modify: `scripts/verness.mjs` (`cmdRun`: start after drawing the pet, stop on the first submitted line; `/pet` restarts it)
- Modify: `verness.config.json` is **not** edited; add `pet: { enabled: true, name: 'Ness', animate: true }` to `DEFAULTS`
- Test: `scripts/test/pet.anim.test.mjs`

**Interfaces:**
- Produces:
  - `animationAllowed({isTTY, columns, env, cfg}): {ok: boolean, why?: string}`
  - `createAnimator(opts): {start(): void, stop(): void, pause(): void, resume(): void, running(): boolean}` where
    `opts = { frames: {lines: string[], ms: number}[], loop: boolean, jitter: number, rowsBelow: number, column: number, write: (s: string) => void, setTimeout, clearTimeout, random?: () => number }`.
    `rowsBelow` is the number of terminal rows between the **last** art row and the cursor row
    (the prompt). `column` is the art's left column (`2` for the 2-space indent `renderPet` uses).
- A repaint writes, in one `write()` call:
  `\x1b[s` (save), then for each art row `i` from the top: move up `(rowsBelow + H - i)` rows, `\r`,
  move right `column` (`\x1b[<column>C`), the row text, then `\x1b[u` (restore). It never clears the
  whole line, because the panel text sits to the right of the art.

- [ ] **Step 1: Failing test with a fake clock and writer**

```js
// scripts/test/pet.anim.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { animationAllowed, createAnimator } from '../lib/pet-anim.mjs'

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
const frames = [{ lines: ['AA', 'aa'], ms: 100 }, { lines: ['BB', 'bb'], ms: 100 }]

test('frames advance on schedule and loop', () => {
  const c = fakeClock(); const out = []
  const a = createAnimator({ frames, loop: true, jitter: 0, rowsBelow: 3, column: 2, write: s => out.push(s), ...c })
  a.start()
  c.tick(100); c.tick(100); c.tick(100)
  assert.deepEqual(out.map(s => (s.includes('BB') ? 'B' : 'A')), ['B', 'A', 'B'])
  a.stop()
  assert.equal(c.pending(), 0)
})

test('a repaint saves and restores the cursor and moves up past the rows below', () => {
  const c = fakeClock(); const out = []
  createAnimator({ frames, loop: true, jitter: 0, rowsBelow: 3, column: 2, write: s => out.push(s), ...c }).start()
  c.tick(100)
  assert.ok(out[0].startsWith('\x1b[s') && out[0].endsWith('\x1b[u'))
  assert.ok(out[0].includes('\x1b[5A'), 'top row is H + rowsBelow = 5 up')
  assert.ok(out[0].includes('\x1b[2C'), 'indented by the column')
})

test('once: stops on the last frame', () => {
  const c = fakeClock(); const out = []
  const a = createAnimator({ frames, loop: false, jitter: 0, rowsBelow: 1, column: 0, write: s => out.push(s), ...c })
  a.start(); c.tick(1000)
  assert.equal(out.length, 1)
  assert.equal(a.running(), false)
})

test('paused: nothing is written, and resume continues', () => {
  const c = fakeClock(); const out = []
  const a = createAnimator({ frames, loop: true, jitter: 0, rowsBelow: 1, column: 0, write: s => out.push(s), ...c })
  a.start(); a.pause(); c.tick(500)
  assert.equal(out.length, 0)
  a.resume(); c.tick(100)
  assert.equal(out.length, 1)
  a.stop()
})

test('off switch', () => {
  const ok = { isTTY: true, columns: 100, env: {}, cfg: { pet: {} } }
  assert.equal(animationAllowed(ok).ok, true)
  assert.equal(animationAllowed({ ...ok, isTTY: false }).ok, false)
  assert.equal(animationAllowed({ ...ok, columns: 60 }).ok, false)
  assert.equal(animationAllowed({ ...ok, env: { NO_COLOR: '' } }).ok, false, 'NO_COLOR set but empty still counts')
  assert.equal(animationAllowed({ ...ok, env: { CI: 'true' } }).ok, false)
  assert.equal(animationAllowed({ ...ok, cfg: { pet: { animate: false } } }).ok, false)
})
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement `scripts/lib/pet-anim.mjs`**

```js
/**
 * Idle animation for the pet, repainted in place. Everything that touches time or the terminal is
 * injected, so the scheduler is tested with a fake clock and a captured writer.
 *
 * Safety model: the caller only starts the animator when it knows exactly how many rows separate the
 * art from the cursor (`rowsBelow`), and stops it the moment anything else prints. The editor pauses
 * it around its own redraws.
 * @module scripts/lib/pet-anim
 */

const ESC = '\u001b'

/**
 * @param {{isTTY: boolean, columns?: number, env: Record<string, string|undefined>, cfg: object}} o - the environment.
 * @returns {{ok: boolean, why?: string}} whether to animate, and why not.
 */
export function animationAllowed(o) {
  if (o.cfg?.pet?.animate === false) return { ok: false, why: 'pet.animate is false' }
  if (o.isTTY !== true) return { ok: false, why: 'not a terminal' }
  if (o.env.NO_COLOR !== undefined) return { ok: false, why: 'NO_COLOR is set' }
  if (o.env.CI !== undefined) return { ok: false, why: 'CI is set' }
  if ((o.columns ?? 0) < 64) return { ok: false, why: 'terminal narrower than the side-by-side layout' }
  return { ok: true }
}

/**
 * @param {object} o - see the plan's Interfaces block.
 * @returns {{start(): void, stop(): void, pause(): void, resume(): void, running(): boolean}} the controller.
 */
export function createAnimator(o) {
  const random = o.random ?? Math.random
  const H = o.frames[0].lines.length
  let i = 0
  let timer
  let paused = false
  let alive = false

  const paint = lines => {
    let s = `${ESC}[s`
    lines.forEach((l, row) => {
      s += `${ESC}[${o.rowsBelow + H - row}A\r${o.column > 0 ? `${ESC}[${o.column}C` : ''}${l}${ESC}[u${ESC}[s`
    })
    o.write(`${s.slice(0, -`${ESC}[s`.length)}`)
  }
  const delay = ms => Math.max(40, Math.round(ms * (1 + (random() * 2 - 1) * o.jitter)))
  const schedule = () => {
    timer = o.setTimeout(() => {
      timer = undefined
      if (!alive) return
      const next = i + 1
      if (next >= o.frames.length && !o.loop) { alive = false; return }
      i = next % o.frames.length
      if (!paused) paint(o.frames[i].lines)
      if (next + 1 >= o.frames.length && !o.loop) { alive = false; return }
      schedule()
    }, delay(o.frames[i].ms))
  }
  return {
    start() { if (alive) return; alive = true; i = 0; schedule() },
    stop() { alive = false; if (timer !== undefined) o.clearTimeout(timer); timer = undefined },
    pause() { paused = true },
    resume() { paused = false },
    running: () => alive,
  }
}
```

Each row restores to the saved cursor, then saves again, so every row's `A` offset is measured
from the prompt. That is what the "moves up past the rows below" test checks. If a test fails on
the exact escape string, fix the implementation, not the test: the test encodes the safety rule.

- [ ] **Step 4: Editor hook.** In `readLineWithSuggestions`, call `opts.onRender?.('before')` at
the start of `render()` and `opts.onRender?.('after')` at its end.

- [ ] **Step 5: Wire it in `cmdRun`**
1. Draw the pet as today (or play `animatePet` first), then **count every line printed after the
   art's last row until the prompt appears**: the rest of the side-by-side block below the art (0
   when bottom-aligned), the blank line, the quick-tools header, the command bar lines, and the
   `info` lines. Collect those lines in an array before printing, and use `array.length` plus the
   status line the editor draws above the prompt (1). That total is `rowsBelow`.
2. `if (animationAllowed({ isTTY: process.stdout.isTTY, columns: process.stdout.columns, env: process.env, cfg }).ok)`, create the animator with `petFrames(mood)`, `column: 2`, `write: s => process.stdout.write(s)`, and the global timers. Start it.
3. Pass `onRender: p => (p === 'before' ? anim.pause() : anim.resume())` to the editor.
4. Stop it (`anim.stop()`) as soon as `readLineWithSuggestions` resolves, on `process.once('exit')`,
   and on `process.stdout.once('resize')`.
5. `/pet` redraws the panel. It may restart the animator through a `ctx.restartPet(rowsBelow)` hook,
   or not animate at all; decide based on how simple it stays. Document the choice in `docs/04-PROGRESS.md`.

- [ ] **Step 6: Manual check** in a real terminal ≥ 64 columns: the pet blinks while you wait; typing
`/` opens the dropdown without artefacts; Enter stops the animation; `NO_COLOR=1 ./turn_on.sh` shows
no animation; `./turn_on.sh | cat` shows none.

- [ ] **Step 7: Commit** — `feat(pet): idle animation with in-place repaint and an off switch (T-335f, T-335g, T-335h)`

### About T-335d (talking while a model turn streams)
Do **not** implement it in this form. During a turn, `dsh` inherits stdout and streams the answer
directly, so the art has already scrolled away and nothing may write to the terminal. Re-scope it in
the backlog to: "When the REPL moves to reading the substrate's `--json` event stream (as
`scripts/loop-task.mjs` already does), show a one-line `Ness: …` spinner on the status line while a
turn streams." Mark it blocked on that change.

---

### Task 4: Live workers in the panel (T-334)

**Files:**
- Create: `scripts/lib/heartbeat.mjs`
- Modify: `scripts/loop-task.mjs` (start/stop a heartbeat around the loop), `scripts/lib/teams.mjs` (around `runTeam`), `scripts/lib/pet.mjs` (`gatherVitals` reads live workers; `panelRows` shows them)
- Test: `scripts/test/heartbeat.test.mjs`

**Interfaces:**
- `startHeartbeat(dir: string, info: {kind: 'loop'|'team', label: string}, opts?: {everyMs?: number, now?, setInterval?, clearInterval?, pid?: number}): () => void`
  writes `<dir>/<kind>-<pid>.json` = `{kind, label, pid, startedAt, beatAt}` immediately and every
  `everyMs` (default 5000). The returned function stops the timer and deletes the file.
- `readLive(dir: string, opts?: {now?: number, staleMs?: number, alive?: (pid: number) => boolean}): {kind, label, pid, startedAt, beatAt}[]`
  drops files with `beatAt` older than `staleMs` (default 15000) **or** whose pid is not alive
  (default: `process.kill(pid, 0)` in try/catch), and deletes those stale files.
- Vitals gain `workers.live: {kind, label, startedAt}[]`; the panel shows
  `live    loop "count json files" 2m · team analysis-review 40s`.

- [ ] **Step 1: Failing test**

```js
// scripts/test/heartbeat.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readLive, startHeartbeat } from '../lib/heartbeat.mjs'

const dir = () => mkdtempSync(join(tmpdir(), 'verness-live-'))

test('a running heartbeat is live; stopping removes it', () => {
  const d = dir()
  const stop = startHeartbeat(d, { kind: 'loop', label: 'x' }, { everyMs: 60000, pid: process.pid })
  assert.equal(readLive(d).length, 1)
  stop()
  assert.equal(readLive(d).length, 0)
})

test('stale or dead entries are dropped and cleaned up', () => {
  const d = dir()
  const f = join(d, 'team-999999.json')
  writeFileSync(f, JSON.stringify({ kind: 'team', label: 't', pid: 999999, startedAt: 0, beatAt: 0 }))
  assert.deepEqual(readLive(d, { now: 100000, alive: () => true }), [])
  assert.equal(existsSync(f), false)
})
```

- [ ] **Step 2: Implement** as specified (≈40 lines; `mkdirSync` the dir; `timer.unref()` so a
heartbeat never keeps the process alive; register the stop function on `process.once('exit')`).
- [ ] **Step 3: Wire it.** `loop-task.mjs`: `const stopBeat = startHeartbeat(join(REPO, '.verness', 'live'), { kind: 'loop', label: objective.slice(0, 40) })`
at the start of the loop, and `stopBeat()` in a `finally`. `runTeam`: the same with
`{ kind: 'team', label: team.id }`. `gatherVitals`: `workers.live = readLive(join(REPO, '.verness', 'live'))`.
Add a render-test case with two live workers, and assert the line fits at 64 columns.
- [ ] **Step 4: Commit** — `feat(pet): show running loops and team runs as live workers (T-334)`

---

### Task 5: Who owns the shared profile patch (T-336)

**Problem:** every checkout (clone, worktree) syncs its own persona and model into the one
`$DSH_HOME/profiles/<name>/cordis.patch.yml`, so booting a second checkout silently switches the
first one's live profile.

**Files:**
- Modify: `scripts/verness.mjs` (`writePatch` stamps an owner line; `syncPatch` checks it; `cmdDoctor` shows it)
- Create: `scripts/lib/profile-owner.mjs`
- Test: `scripts/test/profile-owner.test.mjs`

**Interfaces:**
- `OWNER_PREFIX = '# verness-owner: '`
- `ownerLine(repo: string): string` → `# verness-owner: <absolute repo path>`
- `readOwner(patchText: string): string|undefined`
- `ownershipConflict(patchText: string|undefined, repo: string, exists: (p: string) => boolean): {conflict: boolean, owner?: string}`.
  It is a conflict only when an owner is recorded, differs from `repo`, **and** that path still
  exists (a deleted worktree cannot own anything).
- `syncPatch(cfg, {force})`: on conflict, `warn(`the "${name}" profile is currently set up by ${owner}; syncing replaces its persona and model`)`,
  then continue in the REPL. In the plain `sync` CLI verb, refuse and print `re-run with: sync --force`.
  `cmdDoctor` gains a row `owner  <path>  (this checkout | other checkout)`.
- Document the real fix in `docs/06-SETUP-AND-LAUNCHER.md`: give each checkout its own profile by
  setting `profile.name` in that checkout's config (for example `verness-wt1`), then run `setup`.

- [ ] **Step 1: Failing test**

```js
// scripts/test/profile-owner.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ownerLine, ownershipConflict, readOwner } from '../lib/profile-owner.mjs'

test('round trip', () => {
  assert.equal(readOwner(`${ownerLine('/a/b')}\n- id: x\n`), '/a/b')
  assert.equal(readOwner('- id: x\n'), undefined)
})
test('conflict only when another existing checkout owns it', () => {
  const text = `${ownerLine('/other')}\n`
  assert.equal(ownershipConflict(text, '/me', () => true).conflict, true)
  assert.equal(ownershipConflict(text, '/me', () => false).conflict, false, 'a deleted checkout owns nothing')
  assert.equal(ownershipConflict(`${ownerLine('/me')}\n`, '/me', () => true).conflict, false)
  assert.equal(ownershipConflict(undefined, '/me', () => true).conflict, false)
})
```

- [ ] **Step 2: Implement.** Put the pure functions in `scripts/lib/profile-owner.mjs`. `writePatch`
pushes `ownerLine(REPO)` as its first line. `syncPatch` reads the destination file before
overwriting it (`existsSync`), checks for a conflict, and applies the rule above. Thread a `force`
flag from `dispatch` (`case 'sync': syncPatch(cfg, { force: rest.includes('--force'), strict: true })`)
and from the REPL/boot callers (`strict: false`, warn only).
- [ ] **Step 3: Tests, then a manual check with a second worktree** (`git worktree add ../vn2 && cd ../vn2 && node scripts/verness.mjs sync`
→ refused with the owner's path). Remove the worktree afterwards.
- [ ] **Step 4: Commit** — `fix(profile): record which checkout owns the shared patch and warn on takeover (T-336)`
