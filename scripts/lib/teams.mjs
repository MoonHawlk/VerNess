/**
 * Teams: several personas working a task list.
 *
 * A team lives in `teams/<id>.json`: `members` bind a role to a persona, `tasks` are the units of
 * work, each naming the member that owns it and optionally the tasks it depends on. The runner
 * executes them respecting dependencies, with a configurable amount of concurrency, and writes every
 * transcript to `.finess/runs/<team>/<stamp>/`.
 *
 * Each task is a separate substrate run wearing its own persona, applied as a `--patch` overlay so
 * the shared profile is never mutated. That is what makes concurrent, differently-skilled tasks
 * possible today, without waiting for the supervisor subsystem (M7).
 *
 * Failure policy (T-167): `onFailure` is `stop` (default: nothing new starts), `skip` (only the
 * failed task's dependents are skipped) or `retry-once` (one more attempt, then `skip`). A team sets
 * the default; a task overrides it. Dependents of a failed task never run: they are `skipped`.
 * @module scripts/lib/teams
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { loadPersonas, writePersonaOverlay } from './personas.mjs'
import { parseJsonc, REPO, human, info, ok, paint, step, table, warn } from './util.mjs'

/** Accepted `onFailure` values; the first is the default. */
export const FAILURE_POLICIES = ['stop', 'skip', 'retry-once']

/** @returns {string} the teams directory. */
export const teamsDir = () => join(REPO, 'teams')

/** @returns {string} where team runs are recorded: `.finess/runs/<team>/<stamp>/`. */
export const runsDir = () => join(REPO, '.finess', 'runs')

/**
 * Load every team definition.
 * @returns {Map<string, object>} teams by id.
 */
export function loadTeams() {
  const out = new Map()
  const dir = teamsDir()
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const id = f.replace(/\.json$/, '')
    try {
      const raw = parseJsonc(readFileSync(join(dir, f), 'utf8'))
      out.set(raw.id ?? id, {
        id: raw.id ?? id,
        name: raw.name ?? id,
        description: raw.description ?? '',
        concurrency: raw.concurrency ?? 1,
        onFailure: raw.onFailure ?? 'stop',
        members: raw.members ?? [],
        tasks: (raw.tasks ?? []).map((t, i) => ({
          id: t.id ?? `task-${i + 1}`,
          prompt: t.prompt ?? '',
          member: t.member ?? t.persona,
          dependsOn: t.dependsOn ?? [],
          onFailure: t.onFailure,
        })),
        source: `teams/${f}`,
      })
    } catch (e) {
      warn(`teams/${f} is not valid JSON: ${e.message}`)
    }
  }
  return out
}

/**
 * Validate a team against the available personas.
 * @param {object} team - a loaded team.
 * @param {Map<string, object>} personas - available personas.
 * @returns {string[]} problems found; empty means runnable.
 */
export function validateTeam(team, personas) {
  const problems = []
  const policyOk = p => FAILURE_POLICIES.includes(p)
  if (team.onFailure !== undefined && !policyOk(team.onFailure)) problems.push(`team onFailure "${team.onFailure}" must be one of ${FAILURE_POLICIES.join(', ')}`)
  const byRole = new Map(team.members.map(m => [m.role ?? m.persona, m]))
  for (const m of team.members) {
    if (!personas.has(m.persona)) problems.push(`member "${m.role ?? m.persona}" names unknown persona "${m.persona}"`)
  }
  const ids = new Set(team.tasks.map(t => t.id))
  for (const t of team.tasks) {
    if (t.prompt.trim() === '') problems.push(`task "${t.id}" has an empty prompt`)
    if (t.member !== undefined && !byRole.has(t.member) && !personas.has(t.member)) {
      problems.push(`task "${t.id}" names unknown member/persona "${t.member}"`)
    }
    if (t.onFailure !== undefined && !policyOk(t.onFailure)) {
      problems.push(`task "${t.id}" onFailure "${t.onFailure}" must be one of ${FAILURE_POLICIES.join(', ')}`)
    }
    for (const d of t.dependsOn) if (!ids.has(d)) problems.push(`task "${t.id}" depends on unknown task "${d}"`)
  }
  return problems
}

/**
 * Resolve the persona a task should wear.
 * @param {object} team - the team.
 * @param {object} task - the task.
 * @param {Map<string, object>} personas - available personas.
 * @param {string} fallbackId - the active persona, used when a task names none.
 * @returns {object|undefined} the persona, or undefined when unresolvable.
 */
function personaFor(team, task, personas, fallbackId) {
  const member = team.members.find(m => (m.role ?? m.persona) === task.member)
  const id = member?.persona ?? task.member ?? fallbackId
  return personas.get(id)
}

/**
 * Run a team's task list.
 * @param {object} team - the team to run.
 * @param {object} ctx - the command context (`cfg`, `sh`, `activePersona`, `runTask`).
 * @param {{concurrency?: number, only?: string[], dryRun?: boolean, runsRoot?: string}} [opts] - run
 *   options; `runsRoot` overrides `.finess/runs` (tests).
 * @returns {Promise<{dir: string, results: object[], skipped: object[]}>} the output directory, the
 *   results of tasks that ran, and the skipped tasks (`{id, reason}`).
 */
export async function runTeam(team, ctx, opts = {}) {
  const personas = loadPersonas(ctx.cfg)
  const problems = validateTeam(team, personas)
  if (problems.length > 0) {
    for (const p of problems) warn(p)
    return { dir: '', results: [], skipped: [] }
  }

  const selected = opts.only === undefined || opts.only.length === 0
    ? team.tasks
    : team.tasks.filter(t => opts.only.includes(t.id))
  if (selected.length === 0) { warn('no matching tasks'); return { dir: '', results: [], skipped: [] } }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(opts.runsRoot ?? runsDir(), team.id, stamp)
  const concurrency = Math.max(1, Number(opts.concurrency ?? team.concurrency ?? 1))

  step(`team ${team.name}: ${selected.length} task(s), concurrency ${concurrency}`)
  if (opts.dryRun === true) {
    for (const t of selected) {
      const p = personaFor(team, t, personas, ctx.activePersonaId)
      info(`${t.id}  persona ${p?.id ?? '?'}${t.dependsOn.length > 0 ? `  after ${t.dependsOn.join(', ')}` : ''}`)
      info(`   ${t.prompt.length > 120 ? `${t.prompt.slice(0, 117)}...` : t.prompt}`)
    }
    return { dir: '', results: [], skipped: [] }
  }
  mkdirSync(dir, { recursive: true })

  /** The policy in force for a task: its own, else the team's. */
  const policyOf = t => t.onFailure ?? team.onFailure ?? 'stop'
  /** @type {Map<string, object>} */
  const done = new Map()
  /** @type {object[]} */
  const skipped = []
  let halted = false
  const pending = [...selected]
  const running = new Set()
  const results = []

  /**
   * Execute one task in its own substrate run.
   * @param {object} t - the task.
   * @returns {Promise<object>} the result record.
   */
  const execute = async t => {
    const persona = personaFor(team, t, personas, ctx.activePersonaId)
    // One overlay per task, kept beside its transcript: concurrent tasks must not share the file.
    const overlay = writePersonaOverlay(persona, ctx.cfg, join(dir, `${t.id}.patch.yml`))
    const context = t.dependsOn
      .map(d => done.get(d))
      .filter(r => r !== undefined && r.output !== '')
      .map(r => `### Result of ${r.id} (${r.persona})\n${r.output.slice(-4000)}`)
      .join('\n\n')
    const prompt = context === '' ? t.prompt : `${t.prompt}\n\n--- context from upstream tasks ---\n${context}`
    const t0 = Date.now()
    // ctx.dsh spawns the substrate's JS entry directly: a prompt carrying newlines or several
    // kilobytes of upstream context would be truncated by cmd.exe otherwise. The async variant is
    // what makes concurrency real: a synchronous spawn blocks the event loop, so Promise.race below
    // would only ever see one task at a time (T-144).
    const run = ctx.dshAsync ?? ctx.dsh ?? ((a, o) => ctx.sh('dsh', a, o))
    const maxAttempts = policyOf(t) === 'retry-once' ? 2 : 1
    let r
    let attempts = 0
    do {
      attempts++
      r = await run(['--profile', ctx.cfg.profile.name, '--patch', overlay, prompt], { capture: true, env: ctx.routeEnv })
      if (r.code !== 0 && attempts < maxAttempts) warn(`${t.id} (${persona.id}) exit ${r.code}, retrying once`)
    } while (r.code !== 0 && attempts < maxAttempts)
    const seconds = (Date.now() - t0) / 1000
    const rec = { id: t.id, persona: persona.id, code: r.code, seconds, attempts, output: r.out, file: join(dir, `${t.id}.md`) }
    writeFileSync(rec.file, [
      `# ${t.id}`, '',
      `- persona: ${persona.id} (${persona.name})`,
      `- exit: ${r.code}`,
      `- seconds: ${seconds.toFixed(1)}`,
      attempts > 1 ? `- attempts: ${attempts}` : '',
      t.dependsOn.length === 0 ? '' : `- after: ${t.dependsOn.join(', ')}`,
      '', '## Prompt', '', '```', prompt, '```', '', '## Output', '', r.out, '',
    ].filter(l => l !== '').join('\n'), 'utf8')
    done.set(t.id, rec)
    results.push(rec)
    if (r.code !== 0 && policyOf(t) === 'stop') halted = true
    const mark = r.code === 0 ? ok : warn
    mark(`${t.id} (${persona.id}) ${r.code === 0 ? 'done' : `exit ${r.code}`} in ${seconds.toFixed(1)}s -> ${human(Buffer.byteLength(r.out))}`)
    return rec
  }

  /** Move a pending task to `skipped`. */
  const skip = (t, reason) => {
    pending.splice(pending.indexOf(t), 1)
    skipped.push({ id: t.id, reason })
    warn(`${t.id} skipped: ${reason}`)
  }

  while (pending.length > 0 || running.size > 0) {
    // Dependents of a failed or skipped task never run (to a fixpoint, so chains cascade); a halt
    // (`stop`) skips everything not yet started. Tasks already running are left to finish.
    for (let again = true; again;) {
      again = false
      for (const t of [...pending]) {
        const bad = t.dependsOn.find(d => (done.has(d) && done.get(d).code !== 0) || skipped.some(s => s.id === d))
        if (bad !== undefined) { skip(t, `${bad} did not succeed`); again = true } else if (halted) { skip(t, 'run stopped after a failure'); again = true }
      }
    }
    if (pending.length === 0 && running.size === 0) break
    const ready = pending.filter(t => t.dependsOn.every(d => done.has(d)))
    if (ready.length === 0 && running.size === 0) {
      warn(`deadlock: ${pending.map(t => t.id).join(', ')} wait on tasks that never ran`)
      break
    }
    while (ready.length > 0 && running.size < concurrency) {
      const t = ready.shift()
      pending.splice(pending.indexOf(t), 1)
      const p = execute(t).finally(() => running.delete(p))
      running.add(p)
    }
    if (running.size > 0) await Promise.race(running)
  }

  writeFileSync(join(dir, 'summary.md'), [
    `# ${team.name} — ${stamp}`, '',
    ...table(['task', 'persona', 'status', 'exit', 'seconds'], summaryRows(selected, results, skipped)),
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(buildSummary(team, stamp, concurrency, selected, results, skipped), null, 2)}\n`, 'utf8')
  step('team run complete')
  for (const l of table(['task', 'persona', 'status', 'exit', 'seconds'], summaryRows(selected, results, skipped))) console.log(`  ${l}`)
  info(`transcripts: ${dir}`)
  return { dir, results, skipped }
}

/**
 * Rows of the run's end-of-run table, in definition order.
 * @param {object[]} selected - the tasks selected for this run.
 * @param {object[]} results - per-task result records.
 * @param {{id: string, reason: string}[]} skipped - skipped tasks.
 * @returns {string[][]} rows of task, persona, status, exit, seconds.
 */
function summaryRows(selected, results, skipped) {
  const byId = new Map(results.map(r => [r.id, r]))
  return selected.map(t => {
    const r = byId.get(t.id)
    if (r === undefined) return [t.id, '-', skipped.some(s => s.id === t.id) ? 'skipped' : 'not-run', '-', '-']
    return [t.id, r.persona, r.code === 0 ? 'ok' : 'failed', String(r.code), r.seconds.toFixed(1)]
  })
}

/**
 * A task's status word from its exit code.
 * @param {number|null|undefined} code - the exit code; `undefined` means the task never ran.
 * @returns {'ok'|'failed'|'not-run'} the status (`skipped` is recorded by the runner, not derived).
 */
const statusOf = code => (code === undefined ? 'not-run' : code === 0 ? 'ok' : 'failed')

/**
 * The machine-readable record of a run, written as `summary.json` beside `summary.md` (T-170).
 * Tasks keep the selected (definition) order, not completion order, and tasks a deadlock left
 * unstarted appear as `not-run`. `file` is a basename so the JSON stays portable across machines.
 * @param {object} team - the team.
 * @param {string} stamp - the run's directory name.
 * @param {number} concurrency - the effective concurrency.
 * @param {object[]} selected - the tasks selected for this run.
 * @param {object[]} results - per-task result records from the runner.
 * @param {{id: string, reason: string}[]} [skipped] - tasks the failure policy skipped.
 * @returns {object} the summary.
 */
export function buildSummary(team, stamp, concurrency, selected, results, skipped = []) {
  const byId = new Map(results.map(r => [r.id, r]))
  const skipById = new Map(skipped.map(s => [s.id, s.reason]))
  const tasks = selected.map(t => {
    const r = byId.get(t.id)
    return {
      id: t.id,
      member: t.member ?? null,
      persona: r?.persona ?? null,
      dependsOn: t.dependsOn,
      status: skipById.has(t.id) && r === undefined ? 'skipped' : statusOf(r === undefined ? undefined : r.code),
      onFailure: t.onFailure ?? team.onFailure ?? 'stop',
      attempts: r?.attempts ?? 0,
      skipReason: skipById.get(t.id) ?? null,
      exit: r === undefined ? null : r.code,
      seconds: r === undefined ? null : Number(r.seconds.toFixed(1)),
      file: r === undefined ? null : basename(r.file),
    }
  })
  return {
    v: 1,
    team: team.id,
    name: team.name,
    stamp,
    finishedAt: new Date().toISOString(),
    concurrency,
    onFailure: team.onFailure ?? 'stop',
    ok: tasks.every(t => t.status === 'ok'),
    tasks,
  }
}

/**
 * Directory names inside `dir`, sorted ascending; empty when `dir` is missing.
 * @param {string} dir - the directory.
 * @returns {string[]} sub-directory names.
 */
const subdirs = dir => {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(n => {
    try { return statSync(join(dir, n)).isDirectory() } catch { return false }
  }).sort()
}

/**
 * Find the newest recorded run. Stamps are ISO timestamps with `:` and `.` replaced, so a lexical
 * sort is chronological on every platform (mtime is not: copies and checkouts reset it).
 * @param {string} [teamId] - a team id; omitted means the newest run of any team.
 * @param {string} [root] - the runs root (defaults to `.finess/runs`).
 * @returns {{team: string, stamp: string, dir: string}|undefined} the run, or undefined when none.
 */
export function latestRun(teamId, root = runsDir()) {
  const teams = teamId === undefined ? subdirs(root) : subdirs(root).filter(t => t === teamId)
  let best
  for (const team of teams) {
    const stamp = subdirs(join(root, team)).at(-1)
    if (stamp !== undefined && (best === undefined || stamp > best.stamp)) best = { team, stamp, dir: join(root, team, stamp) }
  }
  return best
}

/**
 * Read a run directory: `summary.json` when present, otherwise the `<task>.md` headers (runs made
 * before `summary.json` existed, or a run still in progress).
 * @param {string} dir - the run directory.
 * @returns {{team: string, stamp: string, dir: string, state: 'complete'|'incomplete', source: string, tasks: object[]}} the run.
 */
export function readRun(dir) {
  const stamp = basename(dir)
  const team = basename(join(dir, '..'))
  const jsonPath = join(dir, 'summary.json')
  if (existsSync(jsonPath)) {
    try {
      const s = JSON.parse(readFileSync(jsonPath, 'utf8').replace(/^﻿/, ''))
      return { team: s.team ?? team, stamp: s.stamp ?? stamp, dir, state: 'complete', source: 'summary.json', tasks: s.tasks ?? [] }
    } catch { /* unreadable: fall back to the transcripts */ }
  }
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'summary.md').sort() : []
  const tasks = files.map(f => {
    const body = readFileSync(join(dir, f), 'utf8')
    const exitRaw = /^- exit: (-?\d+|null)\s*$/m.exec(body)?.[1]
    const secondsRaw = /^- seconds: ([\d.]+)\s*$/m.exec(body)?.[1]
    const exit = exitRaw === undefined || exitRaw === 'null' ? null : Number(exitRaw)
    return {
      id: f.replace(/\.md$/, ''),
      persona: /^- persona: (\S+)/m.exec(body)?.[1] ?? null,
      status: exitRaw === undefined ? 'not-run' : statusOf(exit),
      exit,
      seconds: secondsRaw === undefined ? null : Number(secondsRaw),
      file: f,
    }
  })
  const state = existsSync(join(dir, 'summary.md')) ? 'complete' : 'incomplete'
  return { team, stamp, dir, state, source: 'transcripts', tasks }
}

/**
 * Table rows for `/team status`.
 * @param {{tasks: object[]}} run - a run from `readRun`.
 * @returns {string[][]} rows of task, persona, status, exit, seconds.
 */
export function statusRows(run) {
  return run.tasks.map(t => [
    t.id,
    t.persona ?? '-',
    t.status ?? '?',
    t.exit === null || t.exit === undefined ? '-' : String(t.exit),
    typeof t.seconds === 'number' ? t.seconds.toFixed(1) : '-',
  ])
}
