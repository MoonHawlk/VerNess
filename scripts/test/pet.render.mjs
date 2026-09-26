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
for (const m of ['happy', 'sleepy', 'worried']) {
  const a = petArt(m)
  assert.equal(a.length, 6)
  assert.ok(a.every(l => l.length === 12), `${m} art is 12 columns wide`)
}
assert.match(petArt('sleepy')[0], /z Z/)

// Wide terminal: art beside the panel, every line within the width.
const wide = renderPet(base(), { columns: 100 })
assert.ok(!wide.some(l => ANSI.test(l)), 'stdout is not a TTY here, so no escape codes')
assert.ok(wide.some(l => l.includes('/\\_____/\\') && l.includes('versions')), 'side by side')
assert.ok(wide.every(l => l.length <= 100), 'fits 100 columns')
const text = wide.join('\n')
for (const want of ['VerNess 0.0.1 (abc1234)', 'dsh 0.1.7-rc.2 pinned', 'ollama 0.32.13', 'up - qwen3:0.6b warm 800 MiB',
  'decide  off', 'loop done 2h ago', 'team analysis-review 3d ago', 'a55aee3c', 'Ness: all workers awake']) {
  assert.ok(text.includes(want), `panel shows "${want}"`)
}

// Narrow terminal and pipes (columns undefined): stacked, and still within the width when known.
const narrow = renderPet(base(), { columns: 50 })
assert.ok(!narrow.some(l => l.includes('/\\_____/\\') && l.includes('versions')), 'stacked under 64 columns')
assert.ok(narrow.every(l => l.length <= 50), 'fits 50 columns')
assert.ok(narrow.some(l => l.includes('~')), 'long lines are cut, visibly')
const piped = renderPet(base(), {})
assert.ok(piped.some(l => l.includes('hf') || l.includes('qwen3')) && piped.every(l => !l.includes('~')), 'a pipe is never truncated')

// Unknowns render as unknown rather than crashing.
const bare = base()
bare.versions.dsh.installed = undefined; bare.versions.commit = undefined; bare.session = undefined
bare.recent = { loop: undefined, team: undefined }; bare.roster.commands = undefined
const bareText = renderPet(bare, { columns: 90 }).join('\n')
assert.ok(bareText.includes('dsh ? (pinned 0.1.7-rc.2)'))
assert.ok(bareText.includes('nothing run yet'))
assert.ok(bareText.includes('new - starts with your first task'))

// Drift shows both sides.
assert.ok(renderPet(drift, { columns: 100 }).join('\n').includes('dsh 0.1.6 != pin 0.1.7-rc.2'))

assert.equal(ago(42e3), '42s')
assert.equal(ago(5 * 60e3), '5m')
assert.equal(ago(-1), '0s', 'clock skew never prints a negative age')

console.log('pet render: all assertions passed')
