/**
 * Render the pet from fixed vitals: every mood, the side-by-side and stacked layouts, width limits,
 * and plain output when stdout is not a terminal. `renderPet` is pure, so no network is involved.
 *
 *   node scripts/test/pet.render.mjs
 */
import assert from 'node:assert/strict'

import { ago, moodOf, petArt, renderPet } from '../lib/pet.mjs'

const NOW = Date.parse('2026-09-26T12:00:00Z')
const base = () => ({
  name: 'Ness',
  persona: 'generalist',
  model: 'qwen3:0.6b',
  route: 'ollama-local',
  session: 'session-a55aee3c-7456-4bd4-b39b-aa77d350aff9',
  versions: {
    verness: '0.0.1', commit: 'abc1234', node: '24.14.0',
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

// Moods: worried beats sleepy beats happy.
assert.equal(moodOf(base()).mood, 'happy')
const sleepy = base(); sleepy.workers.engine.loaded = []
assert.equal(moodOf(sleepy).mood, 'sleepy')
const down = base(); down.workers.engine.up = false
assert.equal(moodOf(down).mood, 'worried')
assert.match(moodOf(down).says, /\/up/)
const drift = base(); drift.versions.dsh.installed = '0.1.6'
assert.equal(moodOf(drift).mood, 'worried')
assert.match(moodOf(drift).says, /pinned 0\.1\.7-rc\.2/)
const sidecar = base(); sidecar.workers.decision.enabled = true; sidecar.workers.engine.loaded = []
assert.equal(moodOf(sidecar).mood, 'worried', 'a broken worker outranks an idle one')
const remote = base(); remote.workers.engine = { remote: true, baseURL: 'https://x' }
assert.equal(moodOf(remote).mood, 'happy', 'a remote route is never "down" just because we do not probe it')

// Art: fixed width per mood, so the side-by-side panel stays aligned.
const outline = petArt('happy').slice(1)
for (const m of ['happy', 'sleepy', 'worried']) {
  const a = petArt(m)
  assert.equal(a.length, 18)
  assert.ok(a.every(l => l.length === 41), `${m} art is 41 columns wide`)
  // Only the eyes change with the mood: every other row of the sheep is the same in every mood.
  const sheep = a.slice(1)
  for (let r = 0; r < sheep.length; r++) if (r !== 3) assert.equal(sheep[r], outline[r], `${m} outline row ${r}`)
  assert.equal(sheep[4][8] + sheep[4][11], '▀▀', `${m} lower lids`)
}
assert.equal(outline[3][8] + outline[3][11], '▄▄', 'happy eyes open')
assert.equal(petArt('sleepy')[4][8] + petArt('sleepy')[4][11], '░░', 'sleepy eyes closed')
assert.match(petArt('sleepy')[0], /z/)
assert.match(petArt('worried')[0], /!/)
assert.equal(petArt('happy')[0].trim(), '', 'happy needs no mark')

// Wide terminal: art beside the panel, every line within the width.
const wide = renderPet(base(), { columns: 120 })
assert.ok(!wide.some(l => ANSI.test(l)), 'stdout is not a TTY here, so no escape codes')
assert.ok(wide.some(l => l.includes('█') && l.includes('versions')), 'side by side')
assert.ok(wide.every(l => l.length < 120), 'fits 120 columns, leaving the last one free')
const text = wide.join('\n')
for (const want of ['VerNess 0.0.1 (abc1234)', 'dsh 0.1.7-rc.2 pinned', 'ollama 0.32.13', 'up - qwen3:0.6b warm 800 MiB',
  'decide  off', 'loop done 2h ago', 'team analysis-review 3d ago', 'a55aee3c', 'Ness: all workers awake']) {
  assert.ok(text.includes(want), `panel shows "${want}"`)
}

// Narrow terminal and pipes (columns undefined): stacked, and still within the width when known.
const narrow = renderPet(base(), { columns: 50 })
assert.ok(!narrow.some(l => l.includes('█') && l.includes('versions')), 'stacked under 97 columns')
assert.ok(!renderPet(base(), { columns: 40 }).some(l => l.includes('█')), 'no sheep when she would wrap')
assert.ok(narrow.every(l => l.length < 50), 'fits 50 columns, leaving the last one free')
const panelOf = lines => lines.slice(lines.indexOf('') + 1)
assert.ok(panelOf(narrow).some(l => l.includes('~')), 'long lines are cut, visibly')
const piped = renderPet(base(), {})
assert.ok(piped.some(l => l.includes('hf') || l.includes('qwen3')) && panelOf(piped).every(l => !l.includes('~')), 'a pipe is never truncated')

// Unknowns render as unknown rather than crashing.
const bare = base()
bare.versions.dsh.installed = undefined; bare.versions.commit = undefined; bare.session = undefined
bare.recent = { loop: undefined, team: undefined }; bare.roster.commands = undefined
const bareText = renderPet(bare, { columns: 90 }).join('\n')
assert.ok(bareText.includes('dsh ? (pinned 0.1.7-rc.2)'))
assert.ok(bareText.includes('nothing run yet'))
assert.ok(bareText.includes('new - starts with your first task'))

// Drift shows both sides.
assert.ok(renderPet(drift, { columns: 120 }).join('\n').includes('dsh 0.1.6 != pin 0.1.7-rc.2'))

assert.equal(ago(42e3), '42s')
assert.equal(ago(5 * 60e3), '5m')
assert.equal(ago(-1), '0s', 'clock skew never prints a negative age')

console.log('pet render: all assertions passed')
