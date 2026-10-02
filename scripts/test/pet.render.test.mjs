/**
 * The pet's render, written against the shape rather than the drawing: moods come from `PET_MOODS`
 * (broken, idle, ok), every frame of a mood has the same size, animation frames are ASCII only, and
 * the panel fits the terminal. `renderPet` is pure, so no network or terminal is involved. Checks that
 * only hold for the current drawing (the sheep) sit in one clearly named test at the end.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PET_MOODS, activityOf, ago, moodOf, petAnimFrames, petArt, petFrames, petIntro, renderPet } from '../lib/pet.mjs'

const NOW = Date.parse('2026-09-26T12:00:00Z')
const base = () => ({
  name: 'Ness',
  persona: 'generalist',
  model: 'qwen3:0.6b',
  route: 'ollama-local',
  session: 'session-a55aee3c-7456-4bd4-b39b-aa77d350aff9',
  versions: {
    finess: '0.0.1', commit: 'abc1234', node: '24.14.0',
    dsh: { installed: '0.1.7-rc.2', pinned: '0.1.7-rc.2' },
    engine: { name: 'ollama', version: '0.32.13' },
  },
  workers: {
    engine: { up: true, loaded: [{ name: 'qwen3:0.6b', vram: 800 * 2 ** 20 }] },
    decision: { up: false, enabled: false },
  },
  roster: { personas: 5, teams: 1, commands: 18 },
  recent: { loop: { outcome: 'done', at: NOW - 2 * 3600e3, objective: 'x' }, team: { team: 'analysis-review', at: NOW - 3 * 86400e3 } },
  now: NOW,
})
const ANSI = /\x1b\[/
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '')
const [BROKEN, IDLE, OK] = PET_MOODS

/** Run `fn` with `process.stdout.isTTY` forced to false, so `paint` emits no escape codes. */
function offTTY(fn) {
  const was = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
  try { return fn() } finally {
    if (was === undefined) delete process.stdout.isTTY
    else Object.defineProperty(process.stdout, 'isTTY', was)
  }
}

test('three distinct moods, frozen', () => {
  assert.equal(PET_MOODS.length, 3)
  assert.equal(new Set(PET_MOODS).size, 3)
  assert.ok(Object.isFrozen(PET_MOODS))
})

test('broken > idle > ok', () => {
  assert.equal(moodOf(base()).mood, OK)
  const idle = base(); idle.workers.engine.loaded = []
  assert.equal(moodOf(idle).mood, IDLE)
  const down = base(); down.workers.engine.up = false
  assert.equal(moodOf(down).mood, BROKEN)
  assert.match(moodOf(down).says, /\/up/)
  const drift = base(); drift.versions.dsh.installed = '0.1.6'
  assert.equal(moodOf(drift).mood, BROKEN)
  assert.match(moodOf(drift).says, /pinned 0\.1\.7-rc\.2/)
  const sidecar = base(); sidecar.workers.decision.enabled = true; sidecar.workers.engine.loaded = []
  assert.equal(moodOf(sidecar).mood, BROKEN, 'a broken worker outranks an idle one')
  const both = base(); both.workers.engine.up = false; both.workers.engine.loaded = []
  assert.equal(moodOf(both).mood, BROKEN, 'broken beats idle')
  const remote = base(); remote.workers.engine = { remote: true, baseURL: 'https://x' }
  assert.equal(moodOf(remote).mood, OK, 'a remote route is never "down" just because we do not probe it')
})

test('every mood moodOf returns is in PET_MOODS', () => {
  const cases = [base(), base(), base()]
  cases[1].workers.engine.loaded = []
  cases[2].workers.engine.up = false
  for (const v of cases) assert.ok(PET_MOODS.includes(moodOf(v).mood))
})

const animW = petAnimFrames(PET_MOODS[0])[0][0].length
const animH = petAnimFrames(PET_MOODS[0])[0].length
const artW = petArt(PET_MOODS[0])[0].length
const artH = petArt(PET_MOODS[0]).length

for (const mood of PET_MOODS) {
  test(`${mood}: every animation frame has the same size, ASCII only`, () => {
    const frames = petAnimFrames(mood)
    assert.ok(frames.length >= 1)
    for (const [i, f] of frames.entries()) {
      assert.equal(f.length, animH, `frame ${i} height`)
      for (const l of f) {
        assert.equal(l.length, animW, `frame ${i} width of "${l}"`)
        assert.match(l, /^[\x20-\x7e]*$/, `frame ${i} is ASCII only: "${l}"`)
      }
    }
  })

  test(`${mood}: resting art has the same size as every other mood`, () => {
    const art = petArt(mood)
    assert.equal(art.length, artH, 'height')
    for (const l of art) assert.equal(l.length, artW, `width of "${l}"`)
  })

  test(`${mood}: panel fits the terminal, side by side or stacked`, () => {
    const v = base()
    if (mood === IDLE) v.workers.engine.loaded = []
    if (mood === BROKEN) v.workers.engine.up = false
    assert.equal(moodOf(v).mood, mood)
    for (const cols of [160, 120, 97, 80, 50, 40]) {
      for (const l of renderPet(v, { columns: cols })) assert.ok(strip(l).length < cols, `${cols} columns, last one free: "${l}"`)
    }
  })
}

test('wide terminal: art beside the panel, and the panel says what matters', () => {
  const wide = offTTY(() => renderPet(base(), { columns: 120 }))
  assert.ok(!wide.some(l => ANSI.test(l)), 'no escape codes off a TTY')
  const art = petArt(OK).map(l => l.trimEnd()).filter(l => l.trim() !== '')
  const last = art[art.length - 1]
  assert.ok(wide.some(l => l.includes(last) && l.length > last.length + 4), 'side by side: text beside the bottom art row')
  const text = wide.join('\n')
  for (const want of ['FiNess 0.0.1 (abc1234)', 'dsh 0.1.7-rc.2 pinned', 'ollama 0.32.13', 'up - qwen3:0.6b warm 800 MiB',
    'decide  off', 'loop done 2h ago', 'team analysis-review 3d ago', 'a55aee3c', 'Ness: all workers awake']) {
    assert.ok(text.includes(want), `panel shows "${want}"`)
  }
})

test('narrow terminal and pipes: stacked, cut visibly when narrow, never cut in a pipe', () => {
  offTTY(() => {
    const panelOf = lines => lines.slice(lines.indexOf('') + 1)
    const narrow = renderPet(base(), { columns: 50 })
    assert.ok(panelOf(narrow).some(l => l.includes('~')), 'long lines are cut, visibly')
    const art = petArt(OK).slice(1)
    assert.ok(!renderPet(base(), { columns: artW }).some(l => art.some(a => a.trim() !== '' && l.includes(a.trim()))), 'no art when it would wrap')
    const piped = renderPet(base(), {})
    assert.ok(piped.some(l => l.includes('qwen3')) && panelOf(piped).every(l => !l.includes('~')), 'a pipe is never truncated')
    assert.ok(!piped.some(l => ANSI.test(l)), 'no escape codes in a pipe')
  })
})

test('unknown values render instead of crashing', () => {
  const bare = base()
  bare.versions.dsh.installed = undefined; bare.versions.commit = undefined; bare.session = undefined
  bare.recent = { loop: undefined, team: undefined }; bare.roster.commands = undefined
  const text = offTTY(() => renderPet(bare, { columns: 90 })).join('\n')
  assert.ok(text.includes('dsh ? (pinned 0.1.7-rc.2)'))
  assert.ok(text.includes('nothing run yet'))
  assert.ok(text.includes('new - starts with your first task'))
  const worse = base(); worse.versions.dsh = {}; worse.versions.engine = undefined
  assert.ok(renderPet(worse, { columns: 80 }).length > 0)
})

test('version drift shows both sides', () => {
  const drift = base(); drift.versions.dsh.installed = '0.1.6'
  assert.ok(offTTY(() => renderPet(drift, { columns: 120 })).join('\n').includes('dsh 0.1.6 != pin 0.1.7-rc.2'))
})

test('ago', () => {
  assert.equal(ago(42e3), '42s')
  assert.equal(ago(5 * 60e3), '5m')
  assert.equal(ago(3 * 3600e3), '3h')
  assert.equal(ago(2 * 86400e3), '2d')
  assert.equal(ago(-1), '0s', 'clock skew never prints a negative age')
})

for (const mood of PET_MOODS) {
  test(`${mood}: resting art is ASCII only (T-434) and is frame 0 of the mood's track`, () => {
    for (const l of petArt(mood)) assert.match(l, /^[\x20-\x7e]*$/, `ASCII only: "${l}"`)
    assert.deepEqual(petFrames(mood).frames[0].lines, petArt(mood), 'the animator starts from what is drawn')
  })

  test(`${mood}: timings are sane (T-335a)`, () => {
    const p = petFrames(mood)
    assert.equal(typeof p.loop, 'boolean')
    assert.ok(p.jitter >= 0 && p.jitter <= 1)
    assert.ok(p.frames.length >= 2, 'she moves')
    for (const f of p.frames) assert.ok(Number.isInteger(f.ms) && f.ms >= 80 && f.ms <= 10000, `${mood}: ${f.ms} ms`)
    assert.deepEqual(p.frames.map(f => f.lines), petAnimFrames(mood))
  })

  for (const kind of ['cheer', 'sigh']) {
    test(`${mood}: the ${kind} intro plays once, ends on the resting art, never touches the mark row`, () => {
      const t = petIntro(kind, mood)
      assert.equal(t.loop, false)
      assert.deepEqual(t.frames.at(-1).lines, petArt(mood))
      for (const f of t.frames) {
        assert.equal(f.lines[0], petArt(mood)[0], 'row 0 is not drawn for a happy sheep')
        assert.equal(f.lines.length, artH)
        for (const l of f.lines) assert.ok(l.length === artW && /^[\x20-\x7e]*$/.test(l), `"${l}"`)
      }
    })
  }
}

test('activity: recent /loop-task results add an intro, problems and stale results do not', () => {
  assert.deepEqual(activityOf(base()), { state: 'ready', mood: OK }, 'the loop in base() is two hours old')
  const done = base(); done.recent.loop = { outcome: 'done', at: NOW - 60e3, objective: 'x' }
  assert.deepEqual(activityOf(done), { state: 'done', mood: OK, intro: 'cheer' })
  const failed = base(); failed.recent.loop = { outcome: 'stalled', at: NOW - 60e3, objective: 'x' }
  assert.deepEqual(activityOf(failed), { state: 'failed', mood: OK, intro: 'sigh' })
  const idle = base(); idle.workers.engine.loaded = []
  assert.equal(activityOf(idle).state, 'idle')
  const down = structuredClone(done); down.workers.engine.up = false
  assert.deepEqual(activityOf(down), { state: 'problem', mood: BROKEN }, 'a problem is shown, not a celebration')
  const future = base(); future.recent.loop = { outcome: 'done', at: NOW + 60e3, objective: 'x' }
  assert.equal(activityOf(future).intro, undefined, 'clock skew earns nothing')
  const none = base(); none.recent = {}
  assert.equal(activityOf(none).state, 'ready')
})

// Specific to the current drawing (the ASCII sheep, 9 x 21). Delete or rewrite with the drawing.
test('drawing-specific: the sheep changes only her eye and her mark with the mood', () => {
  const outline = petArt('happy').slice(1)
  for (const m of PET_MOODS) {
    const a = petArt(m)
    assert.equal(a.length, 9)
    assert.ok(a.every(l => l.length === 21), `${m} art is 21 columns wide`)
    const sheep = a.slice(1)
    for (let r = 0; r < sheep.length; r++) if (r !== 3) assert.equal(sheep[r], outline[r], `${m} outline row ${r}`)
  }
  assert.equal(petArt('happy')[4][4], 'o', 'happy eye open')
  assert.equal(petArt('sleepy')[4][4], '-', 'sleepy eye closed')
  assert.equal(petFrames('happy').frames[1].lines[4][4], '-', 'the blink closes it')
  assert.match(petArt('sleepy')[0], /z/)
  assert.match(petArt('worried')[0], /!/)
  assert.doesNotMatch(petFrames('worried').frames[1].lines[0], /!/, 'the pulse hides the !')
  assert.equal(petArt('happy')[0].trim(), '', 'happy needs no mark')
  const zRow = f => f.lines.findIndex(l => /z/i.test(l))
  assert.deepEqual(petFrames('sleepy').frames.map(zRow), [0, 3, 2, 1], 'the z drifts up, then restarts')
  const wide = offTTY(() => renderPet(base(), { columns: 120 }))
  assert.ok(wide.some(l => l.includes('|||') && l.includes('Ness:')), 'side by side at 120, speech by her hooves')
  assert.ok(!offTTY(() => renderPet(base(), { columns: 70 })).some(l => l.includes('`;') && l.includes('versions')), 'stacked under 77 columns')
  assert.ok(!offTTY(() => renderPet(base(), { columns: 22 })).some(l => l.includes('|||')), 'no sheep when she would wrap')
})
