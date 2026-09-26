/**
 * The pet — a small companion that greets you when the REPL boots and answers `/pet` later. It is a
 * status panel with a face: versions (launcher, substrate installed vs pinned, engine, node) and
 * workers (model engine, decision sidecar, last loop, last team run), with a mood derived from them.
 *
 * Split in two on purpose: `gatherVitals` does the probing (async, every probe in parallel and
 * capped at a few hundred milliseconds, so boot never waits on a dead port), and `renderPet` is a
 * pure function of the vitals, so it can be tested without a network or a terminal.
 *
 * The only processes spawned are two `git` calls (no shell, run alongside the HTTP probes); versions
 * otherwise come from files, HTTP and the `dsh` version the launcher already computed. Nothing here
 * costs a token.
 * @module scripts/lib/pet
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { decisionConfig } from './decisions.mjs'
import { activePersonaId, loadPersonas, readState } from './personas.mjs'
import { loadTeams } from './teams.mjs'
import { REPO, paint } from './util.mjs'

/** Per-probe budget. Refused connections return at once; this only bounds a hung listener. */
const PROBE_MS = 600

/** @param {string} baseURL - an OpenAI-style base URL. @returns {string} the engine's API root. */
const apiRoot = baseURL => String(baseURL).replace(/\/v1\/?$/, '')

/**
 * @param {string} url - absolute URL.
 * @returns {Promise<{ok: boolean, body?: any}>} whether it answered 2xx, and its JSON body if any.
 */
async function probe(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(PROBE_MS) })
    if (!r.ok) return { ok: false }
    return { ok: true, body: await r.json().catch(() => undefined) }
  } catch { return { ok: false } }
}

/**
 * @param {string[]} args - git arguments.
 * @returns {Promise<string|undefined>} stdout, or undefined on failure or timeout.
 */
const git = args => new Promise(done => {
  execFile('git', args, { cwd: REPO, encoding: 'utf8', timeout: PROBE_MS * 2 }, (err, out) => done(err ? undefined : out.trim()))
})

/**
 * The short commit of the checkout, plus `*` when tracked files have changes. Submodules are skipped:
 * `upstream/` is read-only by convention and walking a whole substrate tree would dominate boot time.
 * @returns {Promise<string|undefined>} e.g. `a934f9f*`, or undefined outside a repository.
 */
async function commit() {
  const [head, dirty] = await Promise.all([
    git(['rev-parse', '--short', 'HEAD']),
    git(['status', '--porcelain', '--untracked-files=no', '--ignore-submodules']),
  ])
  return head === undefined ? undefined : `${head}${dirty !== undefined && dirty !== '' ? '*' : ''}`
}

/** @returns {{outcome: string, at: number, objective: string}|undefined} the newest `/loop-task` record. */
function lastLoop() {
  const dir = join(REPO, '.verness', 'loops')
  if (!existsSync(dir)) return undefined
  const days = readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()
  for (const f of days.reverse()) {
    const lines = readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(l => l !== '')
    for (const l of lines.reverse()) {
      try {
        const r = JSON.parse(l)
        return { outcome: r.outcome ?? '?', at: Date.parse(r.at), objective: String(r.objective ?? '') }
      } catch { /* a torn line from a crashed run - try the one before */ }
    }
  }
  return undefined
}

/** @returns {{team: string, at: number}|undefined} the newest `/team run` output directory. */
function lastTeamRun() {
  const root = join(REPO, '.verness', 'runs')
  if (!existsSync(root)) return undefined
  let best
  for (const team of readdirSync(root)) {
    let runs
    try { runs = readdirSync(join(root, team)) } catch { continue }
    for (const run of runs) {
      const at = statSync(join(root, team, run)).mtimeMs
      if (best === undefined || at > best.at) best = { team, at }
    }
  }
  return best
}

/**
 * Probe everything the panel shows. Every probe runs concurrently; a failed probe becomes a
 * `down`/unknown value, never an exception, because a greeting must not be able to stop the boot.
 * @param {object} cfg - the merged VerNess configuration.
 * @param {{dsh?: string, commands?: number, session?: string}} [known] - facts the caller already
 *   holds: the installed `dsh` version line, the quick-tool count, the conversation id.
 * @returns {Promise<object>} the vitals `renderPet` draws.
 */
export async function gatherVitals(cfg, known = {}) {
  const route = cfg.activeRoute === '' || cfg.activeRoute === undefined ? cfg.model.route : cfg.activeRoute
  const r = cfg.extraRoutes?.[route] ?? cfg.model
  const local = r.engine !== undefined
  const dc = decisionConfig(cfg)

  const [version, ps, health, sha] = await Promise.all([
    local ? probe(`${apiRoot(r.baseURL)}/api/version`) : Promise.resolve(undefined),
    local ? probe(`${apiRoot(r.baseURL)}/api/ps`) : Promise.resolve(undefined),
    probe(`${dc.baseURL}/health`),
    commit(),
  ])

  let pkg
  try { pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) } catch { pkg = {} }
  const state = readState()
  const loaded = (ps?.body?.models ?? []).map(m => ({ name: m.name ?? m.model, vram: m.size_vram ?? m.size ?? 0 }))

  let personas = 0
  let teams = 0
  try { personas = loadPersonas(cfg).size } catch { /* shown as 0 */ }
  try { teams = loadTeams().size } catch { /* shown as 0 */ }

  return {
    name: cfg.pet?.name ?? 'Ness',
    persona: activePersonaId(cfg),
    model: state.model ?? r.id,
    route,
    session: known.session,
    versions: {
      verness: pkg.version ?? '?',
      commit: sha,
      node: process.versions.node,
      dsh: { installed: known.dsh, pinned: cfg.substrate?.version },
      engine: local ? { name: r.engine, version: version?.body?.version } : undefined,
    },
    workers: {
      engine: local
        ? { up: version?.ok === true, loaded, want: state.model ?? r.id }
        : { remote: true, baseURL: r.baseURL },
      decision: { up: health.ok, enabled: dc.enabled === true },
    },
    roster: { personas, teams, commands: known.commands },
    recent: { loop: lastLoop(), team: lastTeamRun() },
    now: Date.now(),
  }
}

/**
 * Does the installed substrate match the pin? The version line may carry a prefix (`dsh 0.1.7`), so
 * containment is the test rather than equality.
 * @param {{installed?: string, pinned?: string}} dsh - installed and pinned versions.
 * @returns {boolean|undefined} undefined when either side is unknown.
 */
export function dshMatches(dsh) {
  if (dsh.installed === undefined || dsh.pinned === undefined) return undefined
  return dsh.installed.includes(dsh.pinned)
}

/**
 * The pet's mood, and the one sentence it says about it. Worried beats sleepy beats happy: a broken
 * thing matters more than an idle one.
 * @param {object} v - vitals from `gatherVitals`.
 * @returns {{mood: 'happy'|'sleepy'|'worried', says: string}} the mood and its line.
 */
export function moodOf(v) {
  const problems = []
  if (dshMatches(v.versions.dsh) === false) problems.push(`dsh is ${v.versions.dsh.installed}, pinned ${v.versions.dsh.pinned}`)
  const e = v.workers.engine
  if (e.remote !== true && !e.up) problems.push('the model engine is not answering - try /up')
  if (v.workers.decision.enabled && !v.workers.decision.up) problems.push('decisions are enabled but the sidecar is down - /decision up')
  if (problems.length > 0) return { mood: 'worried', says: problems[0] }
  if (e.remote !== true && e.loaded.length === 0) return { mood: 'sleepy', says: 'engine is up but no model is warm - the first task wakes it' }
  return { mood: 'happy', says: 'all workers awake. what are we building?' }
}

/**
 * Ness's face, per mood: eyes, a mouth between two blushing cheeks, and a mark floating above.
 * Odd-width pieces on an odd-width face, so everything centres exactly. ASCII only - legacy
 * consoles mangle the rest.
 */
const FACES = {
  happy: { mark: '', eyes: '^   ^', mouth: 'w' },
  sleepy: { mark: 'z', eyes: '-   -', mouth: 'o' },
  worried: { mark: '!', eyes: 'o   o', mouth: '~' },
}
/** Width of the sheep, and of the face between its cheeks. */
const SHEEP = { w: 17, face: 7 }

/**
 * Ness is a baby sheep: a tuft of wool on top, floppy ears, a face with blushing cheeks, a fluffy
 * body and two little hooves. Only the face changes with the mood, so the outline stays put.
 * @param {'happy'|'sleepy'|'worried'} mood - the mood.
 * @returns {string[]} nine lines (the mood mark, then the sheep), each exactly 17 columns wide.
 */
export function petArt(mood) {
  const f = FACES[mood] ?? FACES.happy
  const center = (s, n) => {
    const left = Math.floor((n - s.length) / 2)
    return ' '.repeat(left) + s + ' '.repeat(n - s.length - left)
  }
  const rows = [
    '     .-~-~-.',
    '   .(  ~ ~  ).',
    ' __(.-------.)__',
    `(__/|${center(f.eyes, SHEEP.face)}|\\__)`,
    `    |${center(`.${center(f.mouth, 3)}.`, SHEEP.face)}|`,
    "   (~'-----'~)",
    '  (~ ~ ~ ~ ~ ~)',
    '   `-"-----"-`',
  ]
  return [`${' '.repeat(12)}${f.mark}`, ...rows].map(l => l.padEnd(SHEEP.w))
}

/** @param {number} ms - a duration. @returns {string} a compact age: `42s`, `5m`, `3h`, `2d`. */
export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

/**
 * @param {string} s - text.
 * @param {number} n - maximum visible width.
 * @returns {string} the text, cut with `~` when it would not fit.
 */
const fit = (s, n) => (s.length <= n ? s : n <= 0 ? '' : `${s.slice(0, n - 1)}~`)

/**
 * The panel as `[label, [text, colour][]]` rows. Kept uncoloured until the last moment so width is
 * measured on what the reader sees, not on escape codes.
 * @param {object} v - vitals.
 * @returns {[string, [string, string?][]][]} the rows.
 */
function panelRows(v) {
  const V = v.versions
  const match = dshMatches(V.dsh)
  const dsh = V.dsh.installed === undefined
    ? [[`dsh ? (pinned ${V.dsh.pinned ?? '?'})`, 'dim']]
    : match
      ? [[`dsh ${V.dsh.pinned}`], [' pinned', 'green']]
      : [[`dsh ${V.dsh.installed}`], [` != pin ${V.dsh.pinned ?? '?'}`, 'yellow']]
  const versions = [[`node ${V.node}  `], ...dsh]
  if (V.engine !== undefined) versions.push([`  ${V.engine.name} ${V.engine.version ?? '?'}`])

  const e = v.workers.engine
  const engine = e.remote === true
    ? [['model   ', 'dim'], [`remote ${v.route}`, 'cyan']]
    : e.up
      ? [['model   ', 'dim'], ['up', 'green'], [e.loaded.length > 0
          ? ` - ${e.loaded.map(m => `${m.name} warm${m.vram > 0 ? ` ${Math.round(m.vram / 2 ** 20)} MiB` : ''}`).join(', ')}`
          : ' - idle, nothing loaded']]
      : [['model   ', 'dim'], ['down', 'red'], [` - ${v.route}`]]
  const d = v.workers.decision
  const decision = [['decide  ', 'dim'], d.up ? ['up', 'green'] : d.enabled ? ['down', 'red'] : ['off', 'dim'],
    [d.up ? (d.enabled ? ' - shadow logging' : ' - running, not enabled') : d.enabled ? ' - enabled but unreachable' : ' - shadow disabled']]

  const recent = []
  const { loop, team } = v.recent
  if (loop !== undefined) recent.push([`loop ${loop.outcome} ${ago(v.now - loop.at)} ago`])
  if (team !== undefined) recent.push([`${recent.length > 0 ? '  ' : ''}team ${team.team} ${ago(v.now - team.at)} ago`])
  if (recent.length === 0) recent.push(['nothing run yet', 'dim'])

  const R = v.roster
  return [
    ['versions', versions],
    ['workers', engine],
    ['', decision],
    ['recent', recent],
    ['roster', [[`${v.persona}`, 'bold'], [` of ${R.personas} persona(s)  ${R.teams} team(s)${R.commands !== undefined ? `  ${R.commands} quick-tools` : ''}`]]],
    ['session', [[v.session === undefined ? 'new - starts with your first task' : v.session.replace(/^session-/, '').slice(0, 8)]]],
  ]
}

/**
 * Draw the pet beside its panel, or above it when the terminal is too narrow for both.
 * @param {object} v - vitals from `gatherVitals`.
 * @param {{columns?: number}} [opts] - terminal width; undefined (a pipe) means stacked.
 * @returns {string[]} the lines to print.
 */
export function renderPet(v, opts = {}) {
  const { mood, says } = moodOf(v)
  const art = petArt(mood)
  const title = [[v.name, 'bold'], [` - VerNess ${v.versions.verness}${v.versions.commit !== undefined ? ` (${v.versions.commit})` : ''}  `], [`${v.model} via ${v.route}`, 'dim']]
  const rows = [['', title], ...panelRows(v)]
  const label = Math.max(...rows.map(([l]) => l.length))
  const cols = opts.columns
  const side = cols !== undefined && cols >= 64
  // One column of slack: a line that fills the last column makes conhost wrap an empty line.
  const room = side ? cols - art[0].length - 6 : (cols ?? Infinity) - 3

  const draw = ([l, parts]) => {
    let left = room - (parts === title ? 0 : label + 2)
    const text = parts.map(([s, c]) => {
      const cut = fit(s, left)
      left -= cut.length
      return cut === '' || c === undefined ? cut : paint(c, cut)
    }).join('')
    return parts === title ? text : `${paint('dim', l.padEnd(label))}  ${text}`
  }
  const panel = rows.map(draw)
  const speech = `${paint('cyan', `${v.name}:`)} ${fit(says, room - v.name.length - 2)}`

  // The mood-mark line above the sheep is only worth a row when it carries a mark.
  const shown = art[0].trim() === '' ? art.slice(1) : art
  if (!side) return [...shown.map(a => `  ${paint('cyan', a)}`.trimEnd()), `  ${speech}`, '', ...panel.map(p => `  ${p}`)]
  // Side by side, bottom-aligned: the title sits by the sheep's wool and Ness speaks beside its hooves.
  const beside = [...panel, '', speech]
  const height = Math.max(shown.length, beside.length)
  const artAt = height - shown.length
  const textAt = height - beside.length
  const out = []
  for (let i = 0; i < height; i++) {
    const a = shown[i - artAt] ?? ' '.repeat(art[0].length)
    out.push(`  ${paint('cyan', a)}   ${beside[i - textAt] ?? ''}`.trimEnd())
  }
  return out
}

/**
 * Should the pet greet at boot? Config `pet.enabled` (default true), overridden off by
 * `VERNESS_NO_PET=1`, and only on a real terminal so piped output stays clean.
 * @param {object} cfg - configuration.
 * @returns {boolean} whether to draw it.
 */
export function petEnabled(cfg) {
  if (process.env.VERNESS_NO_PET !== undefined && process.env.VERNESS_NO_PET !== '' && process.env.VERNESS_NO_PET !== '0') return false
  return cfg.pet?.enabled !== false && process.stdout.isTTY === true
}
