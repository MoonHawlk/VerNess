/**
 * T-144: `/team run --parallel N` must actually overlap tasks. Proves it twice: through `runTeam`
 * with a fake runner (the scheduler awaits, so tasks interleave), and with real child processes
 * through `spawnAsync` (the mechanism the real runner uses does not block the event loop).
 * Spends no model tokens. Run: node scripts/test/teams.parallel.mjs
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { runTeam } from '../lib/teams.mjs'
import { REPO, spawnAsync } from '../lib/util.mjs'

const SLEEP = 400
let failed = 0
const check = (label, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}  (${detail})`)
  if (!cond) failed++
}

const team = {
  id: '_test-t144-parallel',
  name: 'T-144 parallel check',
  concurrency: 1,
  members: [{ role: 'dev', persona: 'software-engineer' }],
  tasks: [
    { id: 'a', prompt: 'task a', member: 'dev', dependsOn: [] },
    { id: 'b', prompt: 'task b', member: 'dev', dependsOn: [] },
    { id: 'c', prompt: 'task c', member: 'dev', dependsOn: ['a', 'b'] },
  ],
}

const fakeCtx = () => {
  const starts = []
  return {
    starts,
    ctx: {
      cfg: { profile: { name: 'test' }, model: { route: 'test' }, activeRoute: '', tips: [] },
      activePersonaId: 'software-engineer',
      routeEnv: {},
      dshAsync: async args => {
        starts.push({ prompt: args.at(-1), at: Date.now() })
        await new Promise(r => setTimeout(r, SLEEP))
        return { code: 0, out: `ran ${args.at(-1).split('\n')[0]}` }
      },
    },
  }
}

const silenced = async fn => {
  const log = console.log
  console.log = () => {}
  const w = process.stdout.write.bind(process.stdout)
  process.stdout.write = () => true
  try { return await fn() } finally { console.log = log; process.stdout.write = w }
}

try {
  // Concurrency 2: a and b overlap (~1 sleep), then c (~1 sleep) -> ~2 sleeps total.
  {
    const { ctx, starts } = fakeCtx()
    const t0 = Date.now()
    const { results } = await silenced(() => runTeam(team, ctx, { concurrency: 2 }))
    const ms = Date.now() - t0
    const gap = Math.abs(starts[0].at - starts[1].at)
    check('--parallel 2 starts independent tasks together', gap < SLEEP / 2, `a/b start gap ${gap}ms`)
    check('--parallel 2 wall time ~2 sleeps, not 3', ms < SLEEP * 2.75, `${ms}ms`)
    check('dependent task still waits for both', starts[2].at - Math.max(starts[0].at, starts[1].at) >= SLEEP - 20, `c started ${starts[2].at - starts[0].at}ms after a`)
    check('all three succeed', results.length === 3 && results.every(r => r.code === 0), `${results.length} results`)
  }
  // Concurrency 1: strictly sequential -> ~3 sleeps.
  {
    const { ctx } = fakeCtx()
    const t0 = Date.now()
    await silenced(() => runTeam(team, ctx, { concurrency: 1 }))
    const ms = Date.now() - t0
    check('concurrency 1 stays sequential', ms >= SLEEP * 3 - 30, `${ms}ms`)
  }
  // The real mechanism: two child processes at once through spawnAsync.
  {
    const script = `setTimeout(() => console.log('slept'), ${SLEEP})`
    const t0 = Date.now()
    const rs = await Promise.all([
      spawnAsync(process.execPath, ['-e', script], { capture: true }),
      spawnAsync(process.execPath, ['-e', script], { capture: true }),
    ])
    const ms = Date.now() - t0
    check('spawnAsync children overlap', ms < SLEEP * 2 - 50, `${ms}ms for two ${SLEEP}ms children`)
    check('spawnAsync captures output and exit code', rs.every(r => r.code === 0 && r.out === 'slept'), JSON.stringify(rs))
    const bad = await spawnAsync('definitely-not-a-real-binary-t144', [], { capture: true })
    check('spawn failure resolves with code 1', bad.code === 1, `code ${bad.code}`)
  }
} finally {
  rmSync(join(REPO, '.verness', 'runs', team.id), { recursive: true, force: true })
}

if (failed > 0) { console.log(`${failed} check(s) failed`); process.exit(1) }
console.log('all checks passed')
