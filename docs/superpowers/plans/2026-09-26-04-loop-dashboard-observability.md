# WS-D — Loop, dashboard and observability: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Read
> `2026-09-26-00-master-plan.md` first. Requires WS-A Task 1 (`npm test`).

**Goal:** Bounded `/loop-task` rounds, the substrate's own repeat guard instead of ours, and a
dashboard that shows loops, per-tool health and filters, first as a static page and then as an
optional loopback service.

**Architecture:** Every dashboard number comes from a **pure aggregation function** over data the
launcher already reads (session events, `.verness/loops/*.jsonl`, `.verness/decisions/*.jsonl`,
`.verness/runs/**/summary.json`). `scripts/dashboard.mjs` only renders. The standalone service
(`scripts/dashboard-server.mjs`) reuses the same aggregation and render functions; it adds file
watching and HTTP. It must never be required for anything else to work.

**Tech stack:** Node ESM, `node:http`, `node:fs.watch`, Server-Sent Events, `node:test`.

**Spec:** `docs/03-BACKLOG.md` WS-D; `docs/research/task-loop-machinery.md` (loop defences and the
substrate's guard packages); `docs/04-PROGRESS.md` entries "/loop-task" and "standalone dashboard".

## Global Constraints
Inherit the master plan. Also:
- The dashboard is as sensitive as the session logs it renders. The service binds `127.0.0.1` by
  default and **refuses** any other host unless `dashboard.token` (or `VERNESS_DASHBOARD_TOKEN`) is
  set; with a token, every request needs `Authorization: Bearer <token>` or `?token=`.
- Static export stays one self-contained HTML file with no external assets, and it must keep working
  after the service exists (T-278).
- No npm dependencies. No chart library: histograms are inline SVG or CSS bars.

## Review Focus
1. A session log with zero tool calls, a loop log with a partial last line, a team run without
   `summary.json`. Every aggregator is tested with these.
2. HTML injection: persona names, tool names and prompts are user text. Everything goes through the
   existing `esc()`, and the embedded JSON through `.replaceAll('<', '\\u003c')` (already used).
3. `fs.watch` on macOS fires duplicate events and on Linux does not recurse. The service debounces
   (250 ms) and watches each directory explicitly.
4. A round killed by the timeout leaves a partial `--json` stream. `parseRound` must tolerate it and
   the round is classified `timeout`, not `error`.
5. Two dashboards (static `--watch` and the service) running at once must not corrupt each other's
   output file: write to a temp name, then rename.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `scripts/verness.mjs` | modify | `dsh()` accepts `timeoutMs` |
| `scripts/loop-task.mjs` | modify | `--round-timeout`; `timeout` outcome |
| `scripts/lib/obs.mjs` | create | pure aggregators: `toolStats`, `latencyHistogram`, `loopRuns`, `filterSessions` |
| `scripts/dashboard.mjs` | modify | panels for tools, loops; filters; `--watch`; atomic write |
| `scripts/dashboard-server.mjs` | create | loopback service with SSE |
| `scripts/commands/dashboard.mjs` | modify | `--watch`, `--serve` |
| `scripts/test/obs.test.mjs`, `scripts/test/dashboard.server.test.mjs` | create | |

---

### Task 1: Per-round wall-clock budget (T-327)

**Files:**
- Modify: `scripts/verness.mjs` (`dsh(args, opts)`: add `opts.timeoutMs` → `spawnSync` `timeout` + `killSignal: 'SIGTERM'`; return `signal: r.signal ?? undefined` and `timedOut: r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM'`)
- Modify: `scripts/loop-task.mjs` (`opts.roundTimeoutSec`, default 600; CLI flag `--round-timeout <s>`)
- Modify: `scripts/commands/loop-task.mjs` (usage and argument parsing)
- Test: `scripts/test/loop.timeout.test.mjs`

**Interfaces:**
- `runLoopTask(ctx, objective, {roundTimeoutSec?: number, ...})`. When a round's run returns
  `timedOut: true`: log `{round, kind: 'timeout', ...}`, set `outcome = 'timeout'` and
  `detail = 'round N exceeded <s>s'`, and **stop** the loop (a round that hung once will hang again;
  continuing burns the budget).
- The verification call gets the same budget.

- [ ] **Step 1: Failing test with a fake runner**

```js
// scripts/test/loop.timeout.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runLoopTask } from '../loop-task.mjs'

test('a timed-out round stops the loop with outcome timeout', async () => {
  const calls = []
  const ctx = {
    cfg: { profile: { name: 'verness' } },
    routeEnv: {},
    dsh: (args, opts) => { calls.push(opts); return { code: 1, out: '', timedOut: true } },
  }
  const r = await runLoopTask(ctx, 'count files', { maxRounds: 5, roundTimeoutSec: 7, verify: false })
  assert.equal(r.outcome, 'timeout')
  assert.equal(r.rounds, 1)
  assert.equal(calls[0].timeoutMs, 7000)
})
```

Read `runLoopTask`'s option names first (the file uses `opts.maxRounds`? check lines 38–60 and match
them exactly). Importing `scripts/loop-task.mjs` must not run its CLI. It already guards the CLI
at the bottom (line ~219); confirm before writing the test.

- [ ] **Step 2: Run → FAIL. Step 3: Implement.** Pass `{ capture: true, env: ctx.routeEnv, timeoutMs: roundTimeoutSec * 1000 }`
to `run(...)` for rounds and for `verifyRound`. Right after the round's run returns and before
`parseRound`, add:

```js
    if (r.timedOut === true) {
      warn(`round ${round} exceeded ${roundTimeoutSec}s - stopping`)
      log.push({ round, seconds, kind: 'timeout', newCalls: 0, detail: `exceeded ${roundTimeoutSec}s` })
      outcome = 'timeout'
      detail = `round ${round} exceeded ${roundTimeoutSec}s`
      break
    }
```

Use the loop's existing variable names for `outcome`/`detail` (read the file). In `dsh()`:

```js
  const r = spawnSync(process.execPath, [dshEntry, ...args], {
    /* existing options */,
    ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs, killSignal: 'SIGTERM' }),
  })
  const timedOut = r.error?.code === 'ETIMEDOUT'
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), ...(timedOut ? { timedOut } : {}) }
```

- [ ] **Step 4: Tests pass; commit** — `feat(loop): per-round wall-clock budget, timeout stops the loop (T-327)`

---

### Task 2: Use the substrate's repeat guard (T-325)

Law: surface, don't rebuild. The substrate ships `packages/guard/repeat-tool-reminder`. This task
turns it on for our profile and keeps our identical-call check only as the hard backstop.

- [ ] **Step 1: Read it.** `git submodule update --init --depth 1 upstream/deepseek-harness`, then read
`upstream/deepseek-harness/packages/guard/repeat-tool-reminder/` (README, `src/index.ts`, its config
schema). Write down: its package name, its config keys (threshold, window, message), whether it
blocks or only reminds, and which event it listens on. Put these in a new section of
`docs/research/task-loop-machinery.md` titled `repeat-tool-reminder (read 2026-09-26)`.
- [ ] **Step 2: Is it already composed?** `dsh --profile verness --dump-config | grep -i repeat`.
If a row exists, note its `id`. If it does not, it must be `insert:`ed like our own plugins.
- [ ] **Step 3: Configure it from our config.** Add `guards: { repeatToolReminder: { enabled: true, ...keys from Step 1 } }`
to `DEFAULTS` in `scripts/verness.mjs`, and in `writePatch` emit either a config override for the
existing row id or an `insert:` row. Follow the existing `L.push(...)` style and remember that a
patch **replaces the whole row config**, so restate every field.
- [ ] **Step 4: Escalate to a hard block.** If the upstream guard only reminds, keep
`detectStall().repeated` in `scripts/lib/loop.mjs` as the hard stop, and change its message to
`blocked: the same call was repeated after the substrate's reminder`. If upstream already blocks,
delete our identical-call check (keep the churn and no-tool rules, which upstream does not have)
and update the comment in `scripts/lib/loop.mjs`.
- [ ] **Step 5: Verify by boot.** `node scripts/verness.mjs sync`, then a loop that invites
repetition: `/loop-task --rounds 4 read package.json three times and report its name each time`.
Record in `docs/04-PROGRESS.md` whether the reminder appeared in the session (`/tools`, or the
dashboard timeline) and which rule stopped the loop.
- [ ] **Step 6: Commit** — `feat(loop): enable the substrate's repeat-tool-reminder guard (T-325)`

---

### Task 3: Pure aggregators (foundation for T-271, T-272, T-328)

**Files:**
- Create: `scripts/lib/obs.mjs`
- Test: `scripts/test/obs.test.mjs`

**Interfaces:**
- `toolStats(events: object[]): {tool: string, calls: number, failures: number, failureRate: number, ms: number[]}[]`, sorted by calls descending.
- `latencyHistogram(ms: number[], edges = [100, 300, 1000, 3000, 10000, 30000]): {label: string, count: number}[]`. Buckets are `<100ms`, `100-300ms`, …, `>=30s`.
- `loopRuns(lines: string[]): {at, objective, outcome, rounds, tokens, detail}[]`. Parses JSONL, skips bad lines, newest first.
- `filterSessions(sessions, {persona?, route?}): sessions`. A session matches a route if any of its `routes` keys starts with `route`. It matches a persona when `s.persona === persona`; `s.persona` is filled in Task 4.

**Before writing `toolStats`, learn the real event shapes** (do not guess field names):

```bash
node -e "
import('./scripts/lib/sessions.mjs').then(({listSessions, readSessionEvents}) => {
  const s = listSessions({limit: 1})[0]; if (!s) return console.log('no sessions');
  const ev = readSessionEvents(s.dir + '/session.v4.jsonl.zstd');
  for (const t of ['tool/call','tool/result','request/header','system/message'])
    console.log(t, JSON.stringify(ev.find(e => e.type === t), null, 1)?.slice(0, 800));
})"
```

Write the fixture in Step 1 from what this prints. The code below assumes `tool/call` has
`data.id` + `data.name` + a timestamp `at`, and `tool/result` has `data.id` + `data.isError` (or
`data.error`) + `at`. **Adjust both the fixture and the code to the real names.**

- [ ] **Step 1: Failing tests**

```js
// scripts/test/obs.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { filterSessions, latencyHistogram, loopRuns, toolStats } from '../lib/obs.mjs'

const call = (id, name, at) => ({ type: 'tool/call', at, data: { id, name } })
const result = (id, at, isError = false) => ({ type: 'tool/result', at, data: { id, isError } })

test('tool stats pair calls with results', () => {
  const s = toolStats([
    call('1', 'read', 0), result('1', 40),
    call('2', 'read', 100), result('2', 400, true),
    call('3', 'bash', 500), // no result: counted as a call, no latency, not a failure
  ])
  assert.deepEqual(s.map(x => [x.tool, x.calls, x.failures, x.failureRate, x.ms]), [
    ['read', 2, 1, 0.5, [40, 300]],
    ['bash', 1, 0, 0, []],
  ])
})
test('no tool calls, no rows', () => { assert.deepEqual(toolStats([]), []) })

test('histogram buckets', () => {
  const h = latencyHistogram([50, 150, 150, 2000, 40000])
  assert.deepEqual(h.map(b => b.count), [1, 2, 0, 1, 0, 0, 1])
  assert.equal(h[0].label, '<100ms'); assert.equal(h.at(-1).label, '>=30s')
})

test('loop runs: bad lines skipped, newest first', () => {
  const runs = loopRuns([
    JSON.stringify({ at: '2026-09-26T01:00:00Z', objective: 'a', outcome: 'done', rounds: 3 }),
    '{"partial',
    JSON.stringify({ at: '2026-09-26T02:00:00Z', objective: 'b', outcome: 'timeout', rounds: 1 }),
  ])
  assert.deepEqual(runs.map(r => r.objective), ['b', 'a'])
})

test('filters', () => {
  const s = [
    { persona: 'data-scientist', routes: new Map([['ollama-local/q', {}]]) },
    { persona: 'generalist', routes: new Map([['deepseek/v4', {}]]) },
  ]
  assert.equal(filterSessions(s, { persona: 'generalist' }).length, 1)
  assert.equal(filterSessions(s, { route: 'ollama' }).length, 1)
  assert.equal(filterSessions(s, {}).length, 2)
})
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement `scripts/lib/obs.mjs`**

```js
/**
 * Pure aggregations behind the dashboard (static and served). No I/O here: callers read the files,
 * these functions only count, so every number on the page has a unit test.
 * @module scripts/lib/obs
 */

/** @param {object} e - a session event. @returns {number} its time in ms. */
const t = e => (typeof e.at === 'number' ? e.at : Date.parse(e.at))

/**
 * @param {object[]} events - one session's events.
 * @returns {{tool: string, calls: number, failures: number, failureRate: number, ms: number[]}[]} per-tool rows.
 */
export function toolStats(events) {
  const open = new Map()
  const rows = new Map()
  const row = name => rows.get(name) ?? rows.set(name, { tool: name, calls: 0, failures: 0, failureRate: 0, ms: [] }).get(name)
  for (const e of events) {
    if (e.type === 'tool/call') { row(e.data.name).calls++; open.set(e.data.id, { name: e.data.name, at: t(e) }) }
    if (e.type === 'tool/result') {
      const c = open.get(e.data.id)
      if (c === undefined) continue
      open.delete(e.data.id)
      const r = row(c.name)
      r.ms.push(t(e) - c.at)
      if (e.data.isError === true || e.data.error !== undefined) r.failures++
    }
  }
  for (const r of rows.values()) r.failureRate = r.calls === 0 ? 0 : r.failures / r.calls
  return [...rows.values()].sort((a, b) => b.calls - a.calls)
}

/** @param {number[]} ms @param {number[]} [edges] @returns {{label: string, count: number}[]} buckets. */
export function latencyHistogram(ms, edges = [100, 300, 1000, 3000, 10000, 30000]) {
  const fmt = x => (x >= 1000 ? `${x / 1000}s` : `${x}ms`)
  const labels = [`<${fmt(edges[0])}`, ...edges.slice(1).map((e, i) => `${fmt(edges[i])}-${fmt(e)}`), `>=${fmt(edges.at(-1))}`]
  const counts = labels.map(() => 0)
  for (const x of ms) {
    const i = edges.findIndex(e => x < e)
    counts[i === -1 ? edges.length : i]++
  }
  return labels.map((label, i) => ({ label, count: counts[i] }))
}

/** @param {string[]} lines - JSONL lines from `.verness/loops/*.jsonl`. @returns {object[]} runs, newest first. */
export function loopRuns(lines) {
  const out = []
  for (const l of lines) { try { out.push(JSON.parse(l)) } catch { /* partial line */ } }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

/** @param {object[]} sessions @param {{persona?: string, route?: string}} f @returns {object[]} the matching sessions. */
export function filterSessions(sessions, f) {
  return sessions.filter(s => (f.persona === undefined || s.persona === f.persona)
    && (f.route === undefined || [...s.routes.keys()].some(k => k.startsWith(f.route))))
}
```

The histogram test expects the `150` values in bucket `100ms-300ms` (index 1): `edges.findIndex(e => 150 < e)`
is 1. Check.

- [ ] **Step 4: Tests pass; commit** — `feat(obs): pure aggregators for tools, latency, loops and filters`

---

### Task 4: Dashboard panels, filters and loops (T-271, T-272, T-328)

**Files:**
- Modify: `scripts/lib/sessions.mjs` (`summarizeSession` records `persona` and the tool-call events it needs)
- Modify: `scripts/dashboard.mjs` (`render(data)` gains three sections and a filter bar)
- Modify: `scripts/commands/dashboard.mjs` (`--persona <id>`, `--route <prefix>`)
- Test: `scripts/test/dashboard.render.test.mjs`

**Interfaces:**
- `summarizeSession` adds `persona?: string`, read from the `system/message` event: the persona
  prefix is injected there (see T-141 in the archive). Match the prefix text of each known persona,
  using `loadPersonas` passed in via an optional second argument
  `summarizeSession(dir, {personas?: Map})`. It adds `tools: ReturnType<typeof toolStats>`.
- `buildDashboard(cfg, {limit?, persona?, route?})` renders:
  - `<h2 id="tools">Tools</h2>`: table of tool, calls, failures, failure %, p50, p95, and a CSS bar
    histogram of all tool latencies (`latencyHistogram` over every `ms`).
  - `<h2 id="loops">Loops</h2>`: from `.verness/loops/*.jsonl` via `loopRuns`: when, objective (esc),
    outcome, rounds, tokens.
  - A filter bar showing the active `--persona`/`--route` and the counts before/after filtering.
    Static HTML cannot re-filter server-side, so the static page also embeds the persona and route per
    session in `DATA` and adds two `<select>`s that hide rows client-side. A few lines of inline JS in
    the existing `<script>`.

- [ ] **Step 1: Failing render test.** Call the exported `render` function (export it if it is not)
with a hand-built `data` object containing one session with `tools`, one loop run and one team run.
Assert that the HTML contains `id="tools"`, `id="loops"`, the tool name, a `<select` for persona and
route, and that a tool named `<img src=x>` appears escaped as `&lt;img`.
- [ ] **Step 2: Implement** following the file's existing section style (read `render()` fully first; it is lines 159–300).
- [ ] **Step 3: Manual check.** `node scripts/verness.mjs dashboard --no-open`, open the file, confirm
the three panels and that the selects hide rows.
- [ ] **Step 4: Commit** — `feat(dashboard): tools, latency histogram, loops, persona/route filters (T-271, T-272, T-328)`

---

### Task 5: `--watch` rebuild (T-273)

**Files:** `scripts/commands/dashboard.mjs`, `scripts/dashboard.mjs` (atomic write)

- [ ] **Step 1:** Make `buildDashboard` write to `<file>.tmp` and `renameSync` onto the target.
- [ ] **Step 2:** `--watch`: build once, open once, then watch `sessionsRoot()` (and each workspace
subdirectory, since Linux `fs.watch` does not recurse), `.verness/decisions`, `.verness/loops` and
`.verness/runs`. Debounce 250 ms and rebuild. Print `rebuilt <time>` per rebuild; stop on ctrl+c.
Add `<meta http-equiv="refresh" content="5">` **only** in watch mode, so a browser tab follows along.
- [ ] **Step 3: Test** the debounce as a pure function, `debounce(fn, ms, {setTimeout, clearTimeout})`
in `scripts/lib/obs.mjs`, with the fake clock pattern from the WS-C plan (Task 3, Step 1).
- [ ] **Step 4: Commit** — `feat(dashboard): --watch rebuilds on change (T-273)`

---

### Task 6: Standalone dashboard service (T-279, T-274, T-275, T-276, T-277, T-278)

Do this only after Tasks 3–5. Build it in this order; each step is independently shippable.

**Files:**
- Create: `scripts/dashboard-server.mjs` (CLI: `node scripts/dashboard-server.mjs [--port 4180] [--host 127.0.0.1]`)
- Modify: `scripts/verness.mjs` (`DEFAULTS.dashboard = { port: 4180, host: '127.0.0.1', token: undefined, environments: [] }`)
- Modify: `scripts/commands/dashboard.mjs` (`--serve` starts it detached and records its pid in `.verness/run/dashboard.json`, the same run-state pattern as `scripts/decision.mjs`)
- Test: `scripts/test/dashboard.server.test.mjs`

**Interfaces:**
- `createDashboardServer({host, port, token?, build: () => string, watchDirs: string[]}): {server: http.Server, close(): Promise<void>}`
  - `GET /` → the HTML from `build()` (the static page plus a tiny SSE client that reloads on `update`).
  - `GET /events` → `text/event-stream`, sends `event: update` after each debounced change.
  - `GET /export` → the same HTML as a download (`content-disposition: attachment; filename=verness-dashboard.html`). That is the static export (T-278).
  - Auth: when `token` is set, missing or wrong token → `401`. When `host` is not a loopback address
    (`127.0.0.1`, `::1`, `localhost`) and no token is set → **throw before listening** with
    `refusing to bind <host> without dashboard.token`.
- Environments (T-276): `dashboard.environments: [{name, dshHome, workspace?}]`. `sessions.mjs`'s
  `sessionsRoot()` gets an optional `dshHome` parameter; the server aggregates per environment and
  adds an `env` column plus an environment `<select>`. With `[]`, one environment named `local`
  uses the current `DSH_HOME`.

- [ ] **Step 1 (T-279): measure the read path.** Time `listSessions({limit: 200})` on this machine
(`node -e` with `performance.now()`), and the same through `@deepseek-ai/dsh-session-query` if it
installs cleanly in a temp dir. Record both in `docs/04-PROGRESS.md`. Rule: keep `lib/sessions.mjs`
unless it is more than 3× slower, and cache summaries by `(path, mtime)` in the server either way.
- [ ] **Step 2: Failing server test**

```js
// scripts/test/dashboard.server.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDashboardServer } from '../dashboard-server.mjs'

test('refuses a non-loopback bind without a token', () => {
  assert.throws(() => createDashboardServer({ host: '0.0.0.0', port: 0, build: () => 'x', watchDirs: [] }), /without dashboard.token/)
})

test('serves the page on loopback, and requires the token when one is set', async () => {
  const { server, close } = createDashboardServer({ host: '127.0.0.1', port: 0, token: 's3cret', build: () => '<h1>ok</h1>', watchDirs: [] })
  await new Promise(r => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal((await fetch(`${base}/`)).status, 401)
    const ok = await fetch(`${base}/`, { headers: { authorization: 'Bearer s3cret' } })
    assert.equal(ok.status, 200)
    assert.match(await ok.text(), /<h1>ok<\/h1>/)
    const exp = await fetch(`${base}/export?token=s3cret`)
    assert.match(exp.headers.get('content-disposition'), /attachment/)
  } finally { await close() }
})
```

- [ ] **Step 3: Implement** with `node:http` only. Compare tokens with `crypto.timingSafeEqual` over
equal-length buffers. The SSE handler keeps a `Set` of responses and writes `event: update\ndata: 1\n\n`.
The watcher reuses `debounce` from Task 5. `close()` ends every SSE response, closes the watchers,
and awaits `server.close`.
- [ ] **Step 4: Lifecycle.** `/dashboard --serve` spawns `process.execPath scripts/dashboard-server.mjs`
detached (`child.unref()`), waits for `GET /` to answer (≤ 3 s), records the pid, and prints the URL
(with `?token=` when a token is configured). `/dashboard --stop` stops only a server VerNess started.
Extend `off` (the launcher verb added in commit 6bc91a6) to stop it too. The harness must run
with the server down: nothing else may import the server.
- [ ] **Step 5: Environments (T-276)** as specified. Test `aggregate across two DSH_HOMEs` with two
temp dirs containing fake session directories. Reuse the zstd fixture approach: write a real
`.jsonl.zstd` with `zlib.zstdCompressSync` (Node ≥ 22.15) in the test.
- [ ] **Step 6: Commit per step:** `perf(dashboard): measure session read path (T-279)`,
`feat(dashboard): loopback service with SSE and token auth (T-274, T-275, T-277, T-278)`,
`feat(dashboard): several environments side by side (T-276)`.

---

### Task 7: Engram on the upstream substrate (T-102, T-103, T-104)

Time-boxed investigations. Each ends with a written verdict in `docs/04-PROGRESS.md`.

- [ ] **T-102 (≤ 2 h):** `engram clone` the substrate at the pinned tag into `.refs/dsh-graph`
(outside the submodule, per ADR-0002). Build it code-only. Pick 5 real questions from this plan's
Task 2 and WS-G ("where is `tools/pre-execute` declared?", "what does `goal-round-driver` listen
to?", …). Answer each twice, once by `grep` and once by `engram query`, counting the tokens read
(characters / 4). Record a table. Verdict: keep the graph if it saves ≥ 50% on at least 3 of 5.
- [ ] **T-103:** When `packages/contracts` (WS-F) exists, rebuild the project graph and decide
whether to commit `.engram/graph.json` + `GRAPH_REPORT.md`: yes if a fresh clone answering one
question with it is cheaper than re-running `engram update`.
- [ ] **T-104:** Skip unless the local route runs a model ≥ 7B. Then run `engram extract --backend ollama`
over `docs/` once and record time, tokens and whether the extracted relations are correct on 10
samples.
