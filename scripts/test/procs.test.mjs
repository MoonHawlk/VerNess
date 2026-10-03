/**
 * Tree kill and the run registry (T-169, T-433). Effects are injected; one test kills a real dummy
 * process tree. Everything lives in a temp dir, never the checkout's `.finess/`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cancelJob, isAlive, killCommand, killTree, readJobs, registerJob } from '../lib/procs.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'finess-procs-'))

test('killCommand is taskkill /T /F on Windows and nothing elsewhere', () => {
  assert.deepEqual(killCommand(42, 'win32'), { cmd: 'taskkill', args: ['/PID', '42', '/T', '/F'] })
  assert.equal(killCommand(42, 'darwin'), null)
  assert.equal(killCommand(42, 'linux'), null)
})

test('killTree: Windows spawns taskkill with an args array', () => {
  const calls = []
  assert.equal(killTree(7, { platform: 'win32', spawn: (c, a) => calls.push([c, a]) }), true)
  assert.deepEqual(calls, [['taskkill', ['/PID', '7', '/T', '/F']]])
})

test('killTree: POSIX signals the group, SIGTERM then SIGKILL after the grace', () => {
  const sent = []
  let later
  killTree(7, { platform: 'linux', kill: (p, s) => sent.push([p, s]), timer: fn => { later = fn } })
  assert.deepEqual(sent, [[-7, 'SIGTERM']])
  later()
  assert.deepEqual(sent, [[-7, 'SIGTERM'], [-7, 0], [-7, 'SIGKILL']])
  const forced = []
  killTree(8, { platform: 'darwin', force: true, kill: (p, s) => forced.push([p, s]), timer: () => assert.fail('no grace when forced') })
  assert.deepEqual(forced, [[-8, 'SIGKILL']])
})

test('killTree rejects a bad pid and survives a missing process', () => {
  assert.equal(killTree(0), false)
  assert.equal(killTree(-3), false)
  assert.equal(killTree(9, { platform: 'linux', kill: () => { throw new Error('ESRCH') } }), false)
})

test('registry: register, read, remove; stale entries are pruned on read', () => {
  const root = tmp()
  const job = registerJob(root, { kind: 'team', label: 'demo' })
  job.track({ pid: process.pid, once: () => {} })
  const jobs = readJobs(root)
  assert.equal(jobs.length, 1)
  assert.deepEqual([jobs[0].kind, jobs[0].label, jobs[0].owner, jobs[0].pids], ['team', 'demo', process.pid, [process.pid]])
  assert.ok(jobs[0].heartbeat !== '' && jobs[0].started !== '')

  writeFileSync(join(root, 'dead.json'), JSON.stringify({ id: 'dead', kind: 'loop', label: 'x', started: '', owner: 999999, pids: [] }))
  writeFileSync(join(root, 'junk.json'), '{"owner":"nope"}')
  const alive = p => p === process.pid
  assert.deepEqual(readJobs(root, { alive }).map(j => j.id), [job.id])
  assert.deepEqual(readdirSync(root).sort(), [`${job.id}.json`])

  job.remove()
  assert.deepEqual(readJobs(root), [])
  assert.equal(existsSync(join(root, `${job.id}.json`)), false)
})

test('registry: dead child pids are dropped from a live job', () => {
  const root = tmp()
  writeFileSync(join(root, 'a.json'), JSON.stringify({ id: 'a', kind: 'delegate', label: 'l', started: '', owner: 1, pids: [2, 3] }))
  assert.deepEqual(readJobs(root, { alive: p => p !== 3 })[0].pids, [2])
})

test('cancelJob flags the job and kills each pid tree; unknown and ambiguous ids fail', () => {
  const root = tmp()
  const mk = (id, pids) => writeFileSync(join(root, `${id}.json`), JSON.stringify({ id, kind: 'team', label: id, started: id, owner: 1, pids }))
  mk('team-aa1', [10, 11])
  mk('team-aa2', [])
  const alive = () => true
  const killed = []
  const r = cancelJob(root, 'team-aa1', { alive, kill: p => { killed.push(p); return true } })
  assert.equal(r.ok, true)
  assert.deepEqual(killed, [10, 11])
  assert.equal(JSON.parse(readFileSync(join(root, 'team-aa1.json'), 'utf8')).cancelled, true)
  assert.equal(cancelJob(root, 'team-aa', { alive }).ok, false)
  assert.match(cancelJob(root, 'nope', { alive }).error, /no running job/)
  assert.equal(cancelJob(root, 'team-aa2', { alive, kill: () => assert.fail('nothing to kill') }).killed.length, 0)
})

test('the owner sees a cancel flag written by another process', () => {
  const root = tmp()
  const job = registerJob(root, { kind: 'loop', label: 'o' })
  assert.equal(job.cancelled(), false)
  cancelJob(root, job.id)
  assert.equal(job.cancelled(), true)
  job.remove()
})

test('a real process tree dies with killTree (child and grandchild)', async () => {
  const grand = 'setInterval(() => {}, 1000)'
  // The child starts a grandchild and prints its pid so the test can check that it died too.
  const src = `const g = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grand)}], { stdio: 'ignore' }); console.log(g.pid); setInterval(() => {}, 1000)`
  const c = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true })
  const gpid = await new Promise(res => c.stdout.once('data', d => res(Number(String(d).trim()))))
  assert.ok(isAlive(c.pid) && isAlive(gpid))
  const closed = new Promise(res => c.once('close', res))
  assert.equal(killTree(c.pid, { grace: 300 }), true)
  await closed
  for (let i = 0; i < 40 && isAlive(gpid); i++) await new Promise(r => setTimeout(r, 100))
  assert.equal(isAlive(gpid), false, 'grandchild survived')
})

test('spawnAsync registered in a job: /task cancel takes down the child and its grandchild', async () => {
  const { spawnAsync } = await import('../lib/util.mjs')
  const root = tmp()
  const job = registerJob(root, { kind: 'delegate', label: 'e2e' })
  const src = "const g = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(g.pid); setInterval(() => {}, 1000)"
  let gpid
  const run = spawnAsync(process.execPath, ['-e', src], { capture: true, onSpawn: c => { job.track(c); c.stdout.once('data', d => { gpid = Number(String(d).trim()) }) } })
  for (let i = 0; i < 50 && gpid === undefined; i++) await new Promise(r => setTimeout(r, 100))
  assert.ok(isAlive(gpid))
  assert.equal(readJobs(root)[0].pids.length, 1)
  assert.equal(cancelJob(root, job.id).killed.length, 1)
  await run
  for (let i = 0; i < 40 && isAlive(gpid); i++) await new Promise(r => setTimeout(r, 100))
  assert.equal(isAlive(gpid), false, 'grandchild survived')
  assert.equal(job.cancelled(), true)
  job.remove()
})
