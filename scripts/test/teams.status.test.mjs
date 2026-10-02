/**
 * T-170: `/team status [<id>]` and `summary.json`. The runner writes a machine-readable summary in
 * definition order; the reader finds the newest run by stamp and falls back to the task transcripts
 * for runs made before `summary.json` existed. Temp-dir fixtures, a fake runner, no model tokens.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import teamCmd from '../commands/team.mjs'
import { latestRun, readRun, runTeam, statusRows } from '../lib/teams.mjs'

const root = mkdtempSync(join(tmpdir(), 'finess-t170-'))
after(() => rmSync(root, { recursive: true, force: true }))

/**
 * Run `fn` with console output captured.
 * @param {() => Promise<any>|any} fn - the code to run.
 * @returns {Promise<{value: any, out: string}>} its result and what it printed.
 */
const quiet = async fn => {
  const log = console.log
  const lines = []
  console.log = (...a) => lines.push(a.join(' '))
  try { return { value: await fn(), out: lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '') } } finally { console.log = log }
}

const transcript = (id, persona, exit, seconds) => [
  `# ${id}`, '', `- persona: ${persona} (Name)`, `- exit: ${exit}`, `- seconds: ${seconds}`, '', '## Output', '', 'x', '',
].join('\n')

test('runTeam writes summary.json in definition order with per-task status', async () => {
  const runsRoot = join(root, 'run-e2e')
  const team = {
    id: 't170', name: 'T-170 check', concurrency: 2,
    members: [{ role: 'dev', persona: 'software-engineer' }],
    tasks: [
      { id: 'slow', prompt: 'slow task', member: 'dev', dependsOn: [] },
      { id: 'fast', prompt: 'fast task', member: 'dev', dependsOn: [] },
      { id: 'last', prompt: 'last task', member: 'dev', dependsOn: ['slow', 'fast'] },
    ],
  }
  const ctx = {
    cfg: { profile: { name: 'test' }, model: { route: 'test' }, activeRoute: '', tips: [] },
    activePersonaId: 'software-engineer',
    routeEnv: {},
    dshAsync: async a => {
      const p = a.at(-1)
      await new Promise(r => setTimeout(r, p.startsWith('slow') ? 60 : 5))
      return { code: p.startsWith('fast') ? 3 : 0, out: `ran ${p.split('\n')[0]}` }
    },
  }
  const { value: { dir } } = await quiet(() => runTeam(team, ctx, { runsRoot }))
  assert.ok(dir.startsWith(runsRoot))
  assert.ok(existsSync(join(dir, 'summary.md')))
  const s = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'))
  assert.equal(s.v, 1)
  assert.equal(s.team, 't170')
  assert.equal(s.ok, false)
  assert.deepEqual(s.tasks.map(t => t.id), ['slow', 'fast', 'last'], 'definition order, not completion order')
  assert.deepEqual(s.tasks.map(t => t.status), ['ok', 'failed', 'skipped'], 'a dependent of a failed task is skipped')
  assert.deepEqual(s.tasks.map(t => t.exit), [0, 3, null])
  assert.ok(s.tasks.filter(t => t.status !== 'skipped').every(t => typeof t.seconds === 'number'))
  assert.equal(s.tasks[0].file, 'slow.md', 'a basename, portable across machines')
  assert.equal(s.tasks[0].persona, 'software-engineer')

  const run = readRun(latestRun('t170', runsRoot).dir)
  assert.equal(run.source, 'summary.json')
  assert.equal(run.state, 'complete')
  assert.deepEqual(statusRows(run).map(r => r.slice(0, 4)), [
    ['slow', 'software-engineer', 'ok', '0'],
    ['fast', 'software-engineer', 'failed', '3'],
    ['last', '-', 'skipped', '-'],
  ])
})

test('latestRun picks the lexically newest stamp, per team and across teams', () => {
  const r = join(root, 'latest')
  for (const d of ['alpha/2026-09-01T10-00-00-000Z', 'alpha/2026-09-03T10-00-00-000Z', 'beta/2026-09-02T10-00-00-000Z', 'beta/2026-09-10T08-00-00-000Z']) {
    mkdirSync(join(r, d), { recursive: true })
  }
  writeFileSync(join(r, 'alpha', 'stray.txt'), 'not a run')
  assert.equal(latestRun('alpha', r).stamp, '2026-09-03T10-00-00-000Z')
  assert.deepEqual(latestRun(undefined, r), { team: 'beta', stamp: '2026-09-10T08-00-00-000Z', dir: join(r, 'beta', '2026-09-10T08-00-00-000Z') })
})

test('latestRun is undefined for a missing root, an unknown team or a team with no runs', () => {
  assert.equal(latestRun(undefined, join(root, 'nope')), undefined)
  assert.equal(latestRun('ghost', join(root, 'nope')), undefined)
  mkdirSync(join(root, 'empty', 'quiet'), { recursive: true })
  assert.equal(latestRun('quiet', join(root, 'empty')), undefined)
  assert.equal(latestRun(undefined, join(root, 'empty')), undefined)
})

test('readRun falls back to the task transcripts for a legacy run', () => {
  const dir = join(root, 'legacy', 'old', '2026-08-01T00-00-00-000Z')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'a.md'), transcript('a', 'software-engineer', 0, '12.5'))
  writeFileSync(join(dir, 'b.md'), transcript('b', 'qa-engineer', 'null', '3.0'))
  writeFileSync(join(dir, 'a.patch.yml'), 'x: 1')
  let run = readRun(dir)
  assert.equal(run.source, 'transcripts')
  assert.equal(run.state, 'incomplete', 'no summary.md: still running or interrupted')
  assert.equal(run.team, 'old')
  assert.deepEqual(statusRows(run), [
    ['a', 'software-engineer', 'ok', '0', '12.5'],
    ['b', 'qa-engineer', 'failed', '-', '3.0'],
  ])
  writeFileSync(join(dir, 'summary.md'), '# old')
  run = readRun(dir)
  assert.equal(run.state, 'complete')
})

test('/team status prints the newest run and returns 0; 1 when there are none', async () => {
  const r = join(root, 'cmd')
  const dir = join(r, 'gone-team', '2026-09-05T00-00-00-000Z')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'summary.json'), `﻿${JSON.stringify({ v: 1, team: 'gone-team', stamp: '2026-09-05T00-00-00-000Z', tasks: [
    { id: 'write', persona: 'technical-writer', status: 'ok', exit: 0, seconds: 4.2 },
    { id: 'review', persona: null, status: 'not-run', exit: null, seconds: null },
  ] })}`)
  const ctx = { runsRoot: r }
  let res = await quiet(() => teamCmd.run(ctx, ['status', 'gone-team']))
  assert.equal(res.value, 0, 'readable even though teams/gone-team.json does not exist')
  assert.match(res.out, /team gone-team: run 2026-09-05T00-00-00-000Z/)
  assert.match(res.out, /write\s+technical-writer\s+ok\s+0\s+4\.2/)
  assert.match(res.out, /review\s+-\s+not-run\s+-\s+-/)
  res = await quiet(() => teamCmd.run(ctx, ['status']))
  assert.equal(res.value, 0)
  res = await quiet(() => teamCmd.run({ runsRoot: join(root, 'cmd-none') }, ['status', 'x']))
  assert.equal(res.value, 1)
})
