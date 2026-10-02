/**
 * `scripts/lib/release-notes.mjs` — the grouping behind `scripts/tools/release-notes.mjs`, on
 * fixture strings (no git), so the result is the same on every clone and after every new tag.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { doneIndex, groupCommits, nextVersion, parseSubject, renderEntry, setupTriggers, shorten, taskIds } from '../lib/release-notes.mjs'

const DONE = [
  '## Round',
  '- [x] T-148 `/exit` (alias `/quit`): ends the REPL like an empty line; `web: false`',
  '- [x] T-374..T-378 Web commands bridge (ADR-0011): `@verness/commands` registers every quick-tool',
  '- [x] T-387 Validator edges: `__proto__` keys reported',
  '- [x] T-388 The inline persona removed from the config. Verified by tests',
  '- [x] T-135 Registry conformance test',
  '- [x] T-140L Tier L entry',
].join('\n')

test('taskIds expands ranges and keeps letter suffixes distinct', () => {
  assert.deepEqual(taskIds('close T-374..T-376, T-148 and T-140L'), ['T-374', 'T-375', 'T-376', 'T-148', 'T-140L'])
})

test('parseSubject reads type, scope and IDs; a non-conventional subject has type ""', () => {
  assert.deepEqual(parseSubject('feat(commands): /exit ends the REPL (T-148)'), { type: 'feat', scope: 'commands', text: '/exit ends the REPL (T-148)', ids: ['T-148'] })
  assert.equal(parseSubject('Merge branch x').type, '')
})

test('doneIndex maps every ID of a range line to one key', () => {
  const ix = doneIndex(DONE)
  assert.equal(ix.get('T-376').key, 'T-374..T-378')
  assert.equal(ix.get('T-140L').key, 'T-140L')
  assert.equal(ix.has('T-140'), false)
})

test('shorten stops at the first top-level separator, never inside parentheses or code', () => {
  assert.equal(shorten('`/exit` (alias `/quit`): ends the REPL'), '`/exit` (alias `/quit`)')
  assert.equal(shorten('Unique match (`a: b`; c) and more. Rest'), 'Unique match (`a: b`; c) and more')
  assert.ok(shorten('word '.repeat(60), 40).endsWith('…'))
})

test('groupCommits: one bullet per done line, strongest type wins, the rest go to review', () => {
  const commits = [
    { hash: 'a1', subject: 'docs: close T-148, T-135; new T-431..T-432' },
    { hash: 'a2', subject: 'test(commands): conformance (T-135)' },
    { hash: 'a3', subject: 'fix(commands): BOM (T-376)' },
    { hash: 'a4', subject: 'feat(commands): bridge plugin (T-376)' },
    { hash: 'a5', subject: 'feat(commands): /exit (T-148)' },
    { hash: 'a6', subject: 'fix(contracts): validator edges (T-387)' },
    { hash: 'a7', subject: 'chore(config): drop inline persona (T-388)' },
    { hash: 'a8', subject: 'fix(commands): /mo resolves to /model' },
    { hash: 'a9', subject: 'feat(pet): off switch (T-433)' },
  ]
  const { sections, unplaced, open } = groupCommits(commits, doneIndex(DONE))
  assert.deepEqual(sections.Added, ['Web commands bridge (ADR-0011) (T-374..T-378)', '`/exit` (alias `/quit`) (T-148)'])
  assert.deepEqual(sections.Fixed, ['Validator edges (T-387)'])
  assert.deepEqual(sections.Changed, ['The inline persona removed from the config (T-388)'])
  assert.deepEqual(unplaced, ['T-135 (only docs a1, test a2)', 'Added? off switch (T-433) (task not in 03-BACKLOG-DONE.md: a9)', 'Fixed? /mo resolves to /model (no task ID: a8)'])
  assert.deepEqual(open, ['T-431', 'T-432', 'T-433'])
})

test('setupTriggers ignores the root package.json; nextVersion follows the pre-1.0 rule', () => {
  assert.deepEqual(setupTriggers(['package.json', 'packages/commands/package.json', 'verness.config.json', 'docs/x.md']), ['packages/commands/package.json', 'verness.config.json'])
  assert.equal(nextVersion('v0.4.0', true), 'v0.5.0')
  assert.equal(nextVersion('v0.4.0', false), 'v0.4.1')
})

test('renderEntry omits empty sections and adds Upgrade only when setup inputs changed', () => {
  const base = { version: 'v0.5.0', date: '2026-10-01', sections: { Added: ['x (T-1)'], Changed: [], Fixed: [] }, merges: [], unplaced: [], open: [] }
  const plain = renderEntry({ ...base, triggers: [] })
  assert.match(plain, /^## v0\.5\.0 — 2026-10-01/)
  assert.match(plain, /### Added\n- x \(T-1\)/)
  assert.doesNotMatch(plain, /### (Changed|Fixed|Upgrade)|<!--/)
  assert.match(renderEntry({ ...base, triggers: ['pnpm-lock.yaml'] }), /### Upgrade\nRun `\.\/turn_on\.sh setup`/)
})
