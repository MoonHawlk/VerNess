/**
 * T-169: `/delegate` runs a single-task ad-hoc team; `/task list` shows runs newest first.
 * Fake dispatcher, temp runs root, no model tokens.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import delegateCmd from '../commands/delegate.mjs'
import taskCmd from '../commands/task.mjs'
import { listRuns } from '../lib/teams.mjs'

const root = mkdtempSync(join(tmpdir(), 'finess-t169-'))
after(() => rmSync(root, { recursive: true, force: true }))

const quiet = async fn => {
  const log = console.log
  const lines = []
  console.log = (...a) => lines.push(a.join(' '))
  try { return { value: await fn(), out: lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '') } } finally { console.log = log }
}

const mkCtx = (runsRoot, code = 0, calls = []) => ({
  cfg: { profile: { name: 'test' }, model: { route: 'test' }, activeRoute: '', tips: [] },
  activePersonaId: 'software-engineer',
  routeEnv: {},
  runsRoot,
  dshAsync: async (a, o) => { calls.push(a); calls.opts = [...(calls.opts ?? []), o]; return { code, out: 'done' } },
})

test('delegate runs one task under the persona and writes run artifacts', async () => {
  const runsRoot = join(root, 'a')
  const calls = []
  const { value } = await quiet(() => delegateCmd.run(mkCtx(runsRoot, 0, calls), ['software-engineer', 'fix', 'the', 'bug']))
  assert.equal(value, 0)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].at(-1).startsWith('fix the bug'))
  assert.ok(calls[0].includes('--patch'))
  // The prompt is marked as the task, so a long one reaches dsh through stdin (T-448).
  assert.equal(calls.opts[0].task, true)
  const runs = listRuns({ root: runsRoot })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].team, 'delegate')
  assert.equal(runs[0].status, 'ok')
  assert.deepEqual(runs[0].personas, ['software-engineer'])
  assert.ok(existsSync(join(runs[0].dir, 'summary.json')))
})

test('delegate rejects unknown persona and empty task without dispatching', async () => {
  const calls = []
  const ctx = mkCtx(join(root, 'b'), 0, calls)
  assert.equal((await quiet(() => delegateCmd.run(ctx, ['no-such-persona', 'x']))).value, 1)
  assert.equal((await quiet(() => delegateCmd.run(ctx, ['software-engineer']))).value, 1)
  assert.equal(calls.length, 0)
})

test('a failing delegation exits 1 and lists as failed', async () => {
  const runsRoot = join(root, 'c')
  assert.equal((await quiet(() => delegateCmd.run(mkCtx(runsRoot, 2), ['software-engineer', 'x']))).value, 1)
  assert.equal(listRuns({ root: runsRoot })[0].status, 'failed')
})

test('/task list shows runs newest first with status; cancel is refused', async () => {
  const runsRoot = join(root, 'd')
  const mk = (team, stamp, summary) => {
    const d = join(runsRoot, team, stamp)
    mkdirSync(d, { recursive: true })
    if (summary) writeFileSync(join(d, 'summary.json'), JSON.stringify({ team, stamp, tasks: [{ id: 't', persona: 'p', status: summary }] }))
    else writeFileSync(join(d, 't.md'), '# t\n\n- persona: p (P)\n')
  }
  mk('alpha', '2026-01-01T00-00-00-000Z', 'ok')
  mk('beta', '2026-03-01T00-00-00-000Z', 'failed')
  mk('alpha', '2026-02-01T00-00-00-000Z', null)
  const rows = listRuns({ root: runsRoot })
  assert.deepEqual(rows.map(r => r.id), ['beta/2026-03-01T00-00-00-000Z', 'alpha/2026-02-01T00-00-00-000Z', 'alpha/2026-01-01T00-00-00-000Z'])
  assert.deepEqual(rows.map(r => r.status), ['failed', 'running', 'ok'])
  assert.equal(listRuns({ root: runsRoot, limit: 1 }).length, 1)
  const { value, out } = await quiet(() => taskCmd.run({ runsRoot }, ['list']))
  assert.equal(value, 0)
  assert.ok(out.indexOf('beta') < out.indexOf('alpha'))
  assert.equal((await quiet(() => taskCmd.run({ runsRoot }, ['cancel', 'x']))).value, 1)
})
