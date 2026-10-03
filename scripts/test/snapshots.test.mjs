/**
 * `/diff` and `/undo` (T-454): the pure planning helpers, then a real temp git repo where a
 * simulated task edits, deletes and adds files and `/undo --yes` puts it back.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import diffCmd from '../commands/diff.mjs'
import undoCmd from '../commands/undo.mjs'
import { KEEP, parseNameStatus, planUndo, pushSnapshot, readSnapshots, safeRel, snapshotRecord, takeSnapshot, truncateLines, undoPlan } from '../lib/snapshots.mjs'

test('snapshotRecord uses HEAD when stash create printed nothing', () => {
  const clean = snapshotRecord({ stash: '\n', head: 'h1', untracked: ['b', 'a'], at: 't' })
  assert.deepEqual(clean, { at: 't', base: 'h1', clean: true, head: 'h1', untracked: ['a', 'b'], stats: {} })
  const dirty = snapshotRecord({ stash: 's1\n', head: 'h1', untracked: [], at: 't', task: 'x' })
  assert.equal(dirty.base, 's1')
  assert.equal(dirty.clean, false)
  assert.equal(dirty.task, 'x')
})

test('pushSnapshot keeps the newest KEEP, newest first', () => {
  let list = []
  for (let i = 0; i < KEEP + 3; i++) list = pushSnapshot(list, { n: i })
  assert.equal(list.length, KEEP)
  assert.equal(list[0].n, KEEP + 2)
  assert.deepEqual(pushSnapshot(undefined, { n: 1 }), [{ n: 1 }])
})

test('parseNameStatus reads -z output', () => {
  assert.deepEqual(parseNameStatus('M\0a.txt\0D\0dir/b c.txt\0A\0n.md\0'), [
    { status: 'M', path: 'a.txt' }, { status: 'D', path: 'dir/b c.txt' }, { status: 'A', path: 'n.md' },
  ])
  assert.deepEqual(parseNameStatus(''), [])
})

test('planUndo deletes only files that were not untracked before and flags drifted ones', () => {
  const snapshot = { untracked: ['old.txt', 'kept.txt'], stats: { 'old.txt': { size: 1, mtimeMs: 5 }, 'kept.txt': { size: 2, mtimeMs: 6 } } }
  const plan = planUndo({
    snapshot,
    changed: [{ status: 'M', path: 'z.js' }, { status: 'D', path: 'a.js' }],
    untrackedNow: ['old.txt', 'kept.txt', 'new.txt', '../escape.txt'],
    statNow: f => (f === 'old.txt' ? { size: 9, mtimeMs: 5 } : { size: 2, mtimeMs: 6 }),
  })
  assert.deepEqual(plan.remove, ['new.txt'])
  assert.deepEqual(plan.drifted, ['old.txt'])
  assert.deepEqual(plan.restore.map(c => c.path), ['a.js', 'z.js'])
})

test('safeRel refuses paths that leave the workspace', () => {
  assert.equal(safeRel('a/b.txt'), true)
  assert.equal(safeRel('../x'), false)
  assert.equal(safeRel('..'), false)
  assert.equal(safeRel(''), false)
  assert.equal(safeRel(join(tmpdir(), 'x')), false)
})

test('truncateLines caps and counts', () => {
  assert.deepEqual(truncateLines('a\nb\nc\n', 2), { lines: ['a', 'b'], dropped: 1 })
  assert.deepEqual(truncateLines('', 2), { lines: [], dropped: 0 })
})

/** @param {string} cwd @param {...string} args @returns {string} stdout. */
function g(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}

/** Silence command output while running it. */
function quiet(fn) {
  const log = console.log
  const out = []
  console.log = (...a) => out.push(a.join(' '))
  try { return { code: fn(), out: out.join('\n') } } finally { console.log = log }
}

test('a task edits, deletes and adds files; /undo --yes restores the snapshot', () => {
  const base = mkdtempSync(join(tmpdir(), 'finess-snap-'))
  const repo = join(base, 'repo')
  const root = join(base, 'snapshots')
  mkdirSync(repo)
  try {
    g(repo, 'init', '-q')
    g(repo, 'config', 'user.name', 'FiNess Test')
    g(repo, 'config', 'user.email', 'test@example.invalid')
    g(repo, 'config', 'core.autocrlf', 'false')
    writeFileSync(join(repo, '.gitignore'), 'build/\n')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    writeFileSync(join(repo, 'gone.txt'), 'keep me\n')
    writeFileSync(join(repo, 'staged.txt'), 'base\n')
    g(repo, 'add', '.')
    g(repo, 'commit', '-q', '-m', 'init')

    // Pre-task state: a dirty tracked file, a staged change, an untracked file, an ignored file.
    writeFileSync(join(repo, 'a.txt'), 'one\nuser edit\n')
    writeFileSync(join(repo, 'staged.txt'), 'staged by user\n')
    g(repo, 'add', 'staged.txt')
    writeFileSync(join(repo, 'notes.txt'), 'mine\n')
    mkdirSync(join(repo, 'build'))

    const ctx = { workspaceDir: repo, snapshotRoot: root }
    const stashBefore = g(repo, 'stash', 'list')
    const snap = takeSnapshot(repo, { root, task: 'refactor' })
    assert.ok(snap.ok)
    assert.equal(snap.record.clean, false)
    assert.deepEqual(snap.record.untracked, ['notes.txt'])
    assert.equal(g(repo, 'stash', 'list'), stashBefore, 'stash create must not touch the stash list')
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'one\nuser edit\n', 'snapshot leaves the tree alone')

    // The "task": edit, delete, add an untracked file, add an ignored file.
    writeFileSync(join(repo, 'a.txt'), 'model rewrote this\n')
    rmSync(join(repo, 'gone.txt'))
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src', 'new.js'), 'export {}\n')
    writeFileSync(join(repo, 'build', 'out.bin'), 'artifact')

    const d = quiet(() => diffCmd.run(ctx, []))
    assert.equal(d.code, 0)
    assert.match(d.out, /a\.txt/)
    assert.match(d.out, /gone\.txt/)
    assert.match(d.out, /\+ src\/new\.js/)
    assert.match(d.out, /model rewrote this/)

    const plan = undoPlan(repo, readSnapshots(repo, root)[0])
    assert.deepEqual(plan.remove, ['src/new.js'])
    assert.deepEqual(plan.restore.map(c => `${c.status} ${c.path}`), ['M a.txt', 'D gone.txt'])

    // Without --yes nothing changes.
    const dry = quiet(() => undoCmd.run(ctx, []))
    assert.equal(dry.code, 0)
    assert.match(dry.out, /--yes/)
    assert.ok(existsSync(join(repo, 'src', 'new.js')))
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'model rewrote this\n')

    const res = quiet(() => undoCmd.run(ctx, ['--yes']))
    assert.equal(res.code, 0, res.out)
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'one\nuser edit\n')
    assert.equal(readFileSync(join(repo, 'gone.txt'), 'utf8'), 'keep me\n')
    assert.equal(existsSync(join(repo, 'src', 'new.js')), false)
    assert.equal(readFileSync(join(repo, 'notes.txt'), 'utf8'), 'mine\n', 'pre-existing untracked file kept')
    assert.ok(existsSync(join(repo, 'build', 'out.bin')), 'ignored files are never deleted')
    // The user's staged change survives in the index.
    assert.equal(g(repo, 'diff', '--cached', '--name-only').trim(), 'staged.txt')
    assert.equal(g(repo, 'show', ':staged.txt'), 'staged by user\n')

    const again = quiet(() => undoCmd.run(ctx, []))
    assert.match(again.out, /already matches/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a clean snapshot restores to HEAD; outside git both commands say so and nothing is taken', () => {
  const base = mkdtempSync(join(tmpdir(), 'finess-snap-'))
  const repo = join(base, 'repo')
  const plain = join(base, 'plain')
  const root = join(base, 'snapshots')
  mkdirSync(repo)
  mkdirSync(plain)
  try {
    g(repo, 'init', '-q')
    g(repo, 'config', 'user.name', 'FiNess Test')
    g(repo, 'config', 'user.email', 'test@example.invalid')
    g(repo, 'config', 'core.autocrlf', 'false')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    g(repo, 'add', '.')
    g(repo, 'commit', '-q', '-m', 'init')
    const snap = takeSnapshot(repo, { root })
    assert.ok(snap.ok && snap.record.clean)
    assert.equal(snap.record.base, g(repo, 'rev-parse', 'HEAD').trim())
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    assert.equal(quiet(() => undoCmd.run({ workspaceDir: repo, snapshotRoot: root }, ['--yes'])).code, 0)
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'one\n')

    const none = takeSnapshot(plain, { root })
    assert.equal(none.ok, false)
    assert.deepEqual(readSnapshots(plain, root), [])
    assert.match(quiet(() => diffCmd.run({ workspaceDir: plain, snapshotRoot: root }, [])).out, /not a git repository/)
    assert.match(quiet(() => undoCmd.run({ workspaceDir: plain, snapshotRoot: root }, ['--yes'])).out, /not a git repository/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
