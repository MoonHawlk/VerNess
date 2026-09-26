/**
 * Teams: several personas working a task list.
 *
 * A team lives in `teams/<id>.json`: `members` bind a role to a persona, `tasks` are the units of
 * work, each naming the member that owns it and optionally the tasks it depends on. The runner
 * executes them respecting dependencies, with a configurable amount of concurrency, and writes every
 * transcript to `.verness/runs/<team>/<stamp>/`.
 *
 * Each task is a separate substrate run wearing its own persona, applied as a `--patch` overlay so
 * the shared profile is never mutated. That is what makes concurrent, differently-skilled tasks
 * possible today, without waiting for the supervisor subsystem (M7).
 * @module scripts/lib/teams
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadPersonas, writePersonaOverlay } from './personas.mjs'
import { parseJsonc, REPO, human, info, ok, paint, step, table, warn } from './util.mjs'

/** @returns {string} the teams directory. */
export const teamsDir = () => join(REPO, 'teams')

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
        members: raw.members ?? [],
        tasks: (raw.tasks ?? []).map((t, i) => ({
          id: t.id ?? `task-${i + 1}`,
          prompt: t.prompt ?? '',
          member: t.member ?? t.persona,
          dependsOn: t.dependsOn ?? [],
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
 * @param {{concurrency?: number, only?: string[], dryRun?: boolean}} [opts] - run options.
 * @returns {Promise<{dir: string, results: object[]}>} the output directory and per-task results.
 */
export async function runTeam(team, ctx, opts = {}) {
  const personas = loadPersonas(ctx.cfg)
  const problems = validateTeam(team, personas)
  if (problems.length > 0) {
    for (const p of problems) warn(p)
    return { dir: '', results: [] }
  }

  const selected = opts.only === undefined || opts.only.length === 0
    ? team.tasks
    : team.tasks.filter(t => opts.only.includes(t.id))
  if (selected.length === 0) { warn('no matching tasks'); return { dir: '', results: [] } }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(REPO, '.verness', 'runs', team.id, stamp)
  const concurrency = Math.max(1, Number(opts.concurrency ?? team.concurrency ?? 1))

  step(`team ${team.name}: ${selected.length} task(s), concurrency ${concurrency}`)
  if (opts.dryRun === true) {
    for (const t of selected) {
      const p = personaFor(team, t, personas, ctx.activePersonaId)
      info(`${t.id}  persona ${p?.id ?? '?'}${t.dependsOn.length > 0 ? `  after ${t.dependsOn.join(', ')}` : ''}`)
      info(`   ${t.prompt.length > 120 ? `${t.prompt.slice(0, 117)}...` : t.prompt}`)
    }
    return { dir: '', results: [] }
  }
  mkdirSync(dir, { recursive: true })

  /** @type {Map<string, object>} */
  const done = new Map()
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
    const overlay = writePersonaOverlay(persona, ctx.cfg)
    const context = t.dependsOn
      .map(d => done.get(d))
      .filter(r => r !== undefined && r.output !== '')
      .map(r => `### Result of ${r.id} (${r.persona})\n${r.output.slice(-4000)}`)
      .join('\n\n')
    const prompt = context === '' ? t.prompt : `${t.prompt}\n\n--- context from upstream tasks ---\n${context}`
    const t0 = Date.now()
    // ctx.dsh spawns the substrate's JS entry directly: a prompt carrying newlines or several
    // kilobytes of upstream context would be truncated by cmd.exe otherwise.
    const run = ctx.dsh ?? ((a, o) => ctx.sh('dsh', a, o))
    const r = run(['--profile', ctx.cfg.profile.name, '--patch', overlay, prompt], { capture: true, env: ctx.routeEnv })
    const seconds = (Date.now() - t0) / 1000
    const rec = { id: t.id, persona: persona.id, code: r.code, seconds, output: r.out, file: join(dir, `${t.id}.md`) }
    writeFileSync(rec.file, [
      `# ${t.id}`, '',
      `- persona: ${persona.id} (${persona.name})`,
      `- exit: ${r.code}`,
      `- seconds: ${seconds.toFixed(1)}`,
      t.dependsOn.length === 0 ? '' : `- after: ${t.dependsOn.join(', ')}`,
      '', '## Prompt', '', '```', prompt, '```', '', '## Output', '', r.out, '',
    ].filter(l => l !== '').join('\n'), 'utf8')
    done.set(t.id, rec)
    results.push(rec)
    const mark = r.code === 0 ? ok : warn
    mark(`${t.id} (${persona.id}) ${r.code === 0 ? 'done' : `exit ${r.code}`} in ${seconds.toFixed(1)}s -> ${human(Buffer.byteLength(r.out))}`)
    return rec
  }

  while (pending.length > 0 || running.size > 0) {
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
    ...table(['task', 'persona', 'exit', 'seconds'], results.map(r => [r.id, r.persona, String(r.code), r.seconds.toFixed(1)])),
    '',
  ].join('\n'), 'utf8')
  step('team run complete')
  for (const l of table(['task', 'persona', 'exit', 'seconds'], results.map(r => [r.id, r.persona, String(r.code), r.seconds.toFixed(1)]))) console.log(`  ${l}`)
  info(`transcripts: ${dir}`)
  return { dir, results }
}
