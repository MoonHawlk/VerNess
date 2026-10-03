/**
 * T-448: a long task reaches dsh through stdin (`-`) from a temp file, a short one stays on argv.
 * Real child processes echo their stdin back, so the plumbing is checked end to end, never the
 * checkout's `.finess/` (every stage writes to a temp dir).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ARGV_TASK_MAX, stageTask, wantsStdin } from '../lib/taskarg.mjs'
import { spawnAsync } from '../lib/util.mjs'

const sandbox = () => mkdtempSync(join(tmpdir(), 'finess-taskarg-'))
const ECHO = ['-e', 'process.stdin.pipe(process.stdout)']
/** ~100k characters with everything argv or cmd.exe would mangle. */
const LONG = `--not-a-flag "quoted" %PATH% ünïcödé 漢字 🙂\r\nline two\n`.repeat(2000)

test('wantsStdin: short tasks stay on argv, long ones (or any on the shim) go to stdin', () => {
  assert.equal(wantsStdin(['--profile', 'p', 'fix it']), false)
  assert.equal(wantsStdin(['--profile', 'p', 'x'.repeat(ARGV_TASK_MAX)]), false)
  assert.equal(wantsStdin(['--profile', 'p', 'x'.repeat(ARGV_TASK_MAX + 1)]), true)
  assert.equal(wantsStdin(['--profile', 'p', 'fix it'], { always: true }), true)
  assert.equal(wantsStdin(['--profile', 'p', 'abc'], { max: 2 }), true)
  // Nothing to stage: no task, an empty one, or already `-`.
  assert.equal(wantsStdin([]), false)
  assert.equal(wantsStdin(['--profile', 'p', ''], { always: true }), false)
  assert.equal(wantsStdin(['--profile', 'p', '-'], { always: true }), false)
})

test('stageTask: unchanged args when not wanted or disabled; nothing written', () => {
  const dir = sandbox()
  try {
    const args = ['--profile', 'p', 'short']
    const a = stageTask(args, dir)
    assert.equal(a.args, args)
    assert.equal(a.stdin, undefined)
    a.cleanup()
    const b = stageTask(['--profile', 'p', LONG], dir, { enabled: false })
    assert.equal(b.args.at(-1), LONG)
    assert.equal(b.stdin, undefined)
    assert.deepEqual(readdirSync(dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('stageTask: the task becomes `-`, each stage gets its own file, cleanup removes it', () => {
  const dir = join(sandbox(), 'run')
  try {
    const args = ['--profile', 'p', '--session-id', 's', LONG]
    const a = stageTask(args, dir)
    const b = stageTask(args, dir)
    assert.deepEqual(a.args, ['--profile', 'p', '--session-id', 's', '-'])
    assert.equal(typeof a.stdin, 'number')
    assert.notEqual(a.file, b.file)
    assert.ok(a.file.startsWith(dir) && existsSync(a.file))
    a.cleanup(); a.cleanup()
    b.cleanup()
    assert.deepEqual(readdirSync(dir), [])
  } finally { rmSync(join(dir, '..'), { recursive: true, force: true }) }
})

test('a staged task reaches a synchronous child byte for byte on stdin', () => {
  const dir = sandbox()
  try {
    const s = stageTask([...ECHO, LONG], dir)
    let r
    try {
      r = spawnSync(process.execPath, s.args.slice(0, -1), { stdio: [s.stdin, 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    } finally { s.cleanup() }
    assert.equal(r.status, 0, String(r.stderr))
    assert.ok(Buffer.from(LONG, 'utf8').equals(r.stdout))
    assert.deepEqual(readdirSync(dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('spawnAsync feeds opts.stdin to the child (the dshAsync path), closed stdin otherwise', async () => {
  const dir = sandbox()
  try {
    const s = stageTask([...ECHO, LONG], dir)
    let r
    try { r = await spawnAsync(process.execPath, s.args.slice(0, -1), { capture: true, cwd: dir, stdin: s.stdin }) } finally { s.cleanup() }
    assert.equal(r.code, 0)
    assert.equal(r.out, LONG.trim())
    const empty = await spawnAsync(process.execPath, ECHO, { capture: true, cwd: dir })
    assert.deepEqual(empty, { code: 0, out: '' })
    assert.deepEqual(readdirSync(dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
