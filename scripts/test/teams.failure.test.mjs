/**
 * T-167: `onFailure` policy (`stop` | `skip` | `retry-once`), team default with a task override.
 * Dependents of a failed task are skipped and never run. Fake dispatcher, no model tokens.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadPersonas } from '../lib/personas.mjs'
import { loadTeams, readRun, runTeam, statusRows, validateTeam } from '../lib/teams.mjs'

const root = mkdtempSync(join(tmpdir(), 'finess-t167-'))
after(() => rmSync(root, { recursive: true, force: true }))

const task = (id, extra = {}) => ({ id, prompt: `${id} prompt`, member: 'dev', dependsOn: [], ...extra })
const mkTeam = (tasks, onFailure) => ({
  id: 't167', name: 'T-167', concurrency: 1, onFailure,
  members: [{ role: 'dev', persona: 'software-engineer' }], tasks,
})

/** A fake dispatcher: `failures` maps a task id to how many of its first attempts fail. */
const mkCtx = failures => {
  const calls = []
  const left = { ...failures }
  return {
    calls,
    ctx: {
      cfg: { profile: { name: 'test' }, model: { route: 'test' }, activeRoute: '', tips: [] },
      activePersonaId: 'software-engineer',
      routeEnv: {},
      dshAsync: async a => {
        const id = a.at(-1).split(' ')[0]
        calls.push(id)
        if ((left[id] ?? 0) > 0) { left[id]--; return { code: 1, out: `${id} failed` } }
        return { code: 0, out: `${id} ok` }
      },
    },
  }
}

const go = async (team, failures) => {
  const { ctx, calls } = mkCtx(failures)
  const warn = process.stderr.write.bind(process.stderr)
  const log = console.log
  const err = console.error
  console.log = () => {}
  console.error = () => {}
  process.stderr.write = () => true
  try {
    const res = await runTeam(team, ctx, { runsRoot: root })
    return { ...res, calls, summary: JSON.parse(readFileSync(join(res.dir, 'summary.json'), 'utf8')) }
  } finally { console.log = log; console.error = err; process.stderr.write = warn }
}

const statuses = s => Object.fromEntries(s.tasks.map(t => [t.id, t.status]))

test('default is stop: a failure skips every task not yet started', async () => {
  const r = await go(mkTeam([task('a'), task('b'), task('c')]), { a: 99 })
  assert.deepEqual(r.calls, ['a'])
  assert.deepEqual(statuses(r.summary), { a: 'failed', b: 'skipped', c: 'skipped' })
  assert.equal(r.summary.ok, false)
  assert.equal(r.summary.onFailure, 'stop')
  assert.match(r.summary.tasks[1].skipReason, /stopped/)
})

test('skip: only dependents (transitively) are skipped, independents still run', async () => {
  const r = await go(mkTeam([task('a'), task('b', { dependsOn: ['a'] }), task('c', { dependsOn: ['b'] }), task('d')], 'skip'), { a: 99 })
  assert.deepEqual(r.calls, ['a', 'd'])
  assert.deepEqual(statuses(r.summary), { a: 'failed', b: 'skipped', c: 'skipped', d: 'ok' })
  assert.deepEqual(r.skipped.map(s => s.id), ['b', 'c'])
  assert.match(r.summary.tasks[2].skipReason, /b did not succeed/)
})

test('a task override beats the team default', async () => {
  const t = mkTeam([task('a', { onFailure: 'skip' }), task('b', { dependsOn: ['a'] }), task('c')], 'stop')
  const r = await go(t, { a: 99 })
  assert.deepEqual(statuses(r.summary), { a: 'failed', b: 'skipped', c: 'ok' })
  assert.equal(r.summary.tasks[0].onFailure, 'skip')
  assert.equal(r.summary.tasks[1].onFailure, 'stop')
  // and the reverse: team skip, task stop halts the run
  const r2 = await go(mkTeam([task('a', { onFailure: 'stop' }), task('c')], 'skip'), { a: 99 })
  assert.deepEqual(statuses(r2.summary), { a: 'failed', c: 'skipped' })
})

test('retry-once: a second attempt can succeed and dependents then run', async () => {
  const r = await go(mkTeam([task('a'), task('b', { dependsOn: ['a'] })], 'retry-once'), { a: 1 })
  assert.deepEqual(r.calls, ['a', 'a', 'b'])
  assert.deepEqual(statuses(r.summary), { a: 'ok', b: 'ok' })
  assert.equal(r.summary.tasks[0].attempts, 2)
  assert.equal(r.summary.tasks[1].attempts, 1)
  assert.equal(r.summary.ok, true)
})

test('retry-once: retries exactly once, then behaves like skip', async () => {
  const r = await go(mkTeam([task('a'), task('b', { dependsOn: ['a'] }), task('c')], 'retry-once'), { a: 99 })
  assert.deepEqual(r.calls, ['a', 'a', 'c'])
  assert.deepEqual(statuses(r.summary), { a: 'failed', b: 'skipped', c: 'ok' })
  assert.equal(r.summary.tasks[0].attempts, 2)
})

test('skipped tasks reach summary.md and /team status rows', async () => {
  const r = await go(mkTeam([task('a'), task('b', { dependsOn: ['a'] })], 'skip'), { a: 99 })
  assert.match(readFileSync(join(r.dir, 'summary.md'), 'utf8'), /\bb\b.*skipped/)
  const rows = statusRows(readRun(r.dir))
  assert.deepEqual(rows.map(x => x.slice(0, 3)), [['a', 'software-engineer', 'failed'], ['b', '-', 'skipped']])
})

test('validateTeam rejects unknown onFailure values; loadTeams defaults to stop', () => {
  const personas = loadPersonas({ profile: { name: 'test' } })
  const bad = validateTeam(mkTeam([task('a', { onFailure: 'explode' })], 'nope'), personas)
  assert.ok(bad.some(p => /team onFailure "nope"/.test(p)))
  assert.ok(bad.some(p => /task "a" onFailure "explode"/.test(p)))
  assert.deepEqual(validateTeam(mkTeam([task('a', { onFailure: 'retry-once' })], 'skip'), personas), [])
  for (const t of loadTeams().values()) assert.equal(t.onFailure, 'stop', `${t.id} ships with the default`)
})
