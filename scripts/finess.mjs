#!/usr/bin/env node
/**
 * FiNess launcher — one cross-platform entry point for installing, configuring and booting the
 * harness. Everything it does is derived from `finess.config.json`; nothing here is machine- or
 * OS-specific beyond path resolution and process spawning.
 *
 * Commands: setup | start (default) | run <task...> | sync | doctor | graph | help
 * @module scripts/finess
 */

import { spawn, spawnSync } from 'node:child_process'
import * as nodeFs from 'node:fs'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyLine, commandList, loadCommands, runCommand } from './lib/commands.mjs'
import { makeSuggester, readLineWithSuggestions } from './lib/prompt.mjs'
import { appendHistory, loadHistory } from './lib/history.mjs'
import { modelDown, modelStats, modelUp, statsOpts } from './model.mjs'
import { decisionDown } from './decision.mjs'
import { activePersonaId, loadPersonas, personaPrompt, readState, writeState } from './lib/personas.mjs'
import { ACCESS_MODES, accessMode, catalogProviders, chooseFallback, effectiveRoute, fallbackEnv, knownRoutes, loadDotEnv, localModels, routeEnvironment, smallModelNote, warnPreset } from './lib/routes.mjs'
import { listSessions } from './lib/sessions.mjs'
import { animatePet, gatherVitals, petEnabled } from './lib/pet.mjs'
import { loadTeams } from './lib/teams.mjs'
import { notifyDone } from './lib/notify.mjs'
import { CHECKOUT_STAMP, applyAllowBuilds, bundleName, enableBundle, hashPluginDir, isWorktree, pluginNeedsReinstall, profileBundles, readPluginHashes, syncWarnings, undecidedBuilds, writePluginHash } from './lib/profile-setup.mjs'
import { gatherFacts, runChecks } from './lib/engine-checks.mjs'
import { shAsync, spawnAsync } from './lib/util.mjs'
import { loadRecipes } from './lib/recipes.mjs'
import { CAPS, MAX_TASK_CHARS, attachedChars, expandRefs, runShell, shellAttachment } from './lib/attach.mjs'
import { NEW_KEY, appendBrief, composeTask, markSent, moveNotes, pendingNotes, readBrief, readNotes } from './lib/notes.mjs'
import { NODE_MIN, nodeOk } from './lib/node-version.mjs'
import { activeWorkspace, resolveWorkspace, switchWorkspace, takeWorkspaceFlag, workspaceKey, workspaceLabel } from './lib/workspace.mjs'
import { ROUTING_QUESTIONS, askDecision, decisionConfig, decisionFailure, decisionHealth, loadTemperatures, logShadowDecision, modelAnswers, ruleRoute } from './lib/decisions.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUN_DIR_LOCAL = join(REPO, '.finess', 'run')
const WIN = process.platform === 'win32'

/** Defaults for every configurable field; the config file overrides these shallowly per section. */
const DEFAULTS = {
  substrate: { version: '0.1.7-rc.2', pnpmVersion: '11.7.0' },
  profile: { name: 'finess', template: 'headless' },
  model: {
    route: 'ollama-local', displayName: 'Ollama (local)', id: 'qwen3:0.6b',
    baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'OLLAMA_API_KEY',
    apiKeyValue: 'ollama-local-no-auth', contextWindow: 32768, maxTokens: 4096,
    engine: 'ollama', source: undefined, keepAliveMinutes: 10, autoInstallEngine: true,
    reasoning: false, autoServe: true, autoPull: true, fallback: [],
  },
  extraRoutes: {}, activeRoute: '',
  personas: { active: 'generalist', definitions: { generalist: { prefix: '', suffix: '' } } },
  tips: [],
  settings: { toolsMode: 'native', plugins: [], webBundles: [], allowBuilds: {}, linkedSubstratePackages: ['@deepseek-ai/dsh-tools'] },
  pet: { enabled: true, name: 'Ness', animate: true },
  notes: { maxChars: 2000, briefMaxChars: 4000 },
  notify: { afterSeconds: 30, desktop: false },
}

const C = {
  dim: '[2m', red: '[31m', green: '[32m',
  yellow: '[33m', cyan: '[36m', bold: '[1m', off: '[0m',
}
const paint = (c, s) => (process.stdout.isTTY ? c + s + C.off : s)
const step = s => console.log(paint(C.cyan, '==> ') + s)
const ok = s => console.log(paint(C.green, '  ok ') + s)
const warn = s => console.log(paint(C.yellow, '  !! ') + s)
const info = s => console.log(paint(C.dim, '     ' + s))
const die = (s, hint) => {
  console.error(paint(C.red, 'error: ') + s)
  if (hint !== undefined) console.error(paint(C.dim, '  ' + hint))
  process.exit(1)
}

/**
 * Strip `//` line comments (outside strings) and trailing commas, then parse. Lets the setup file
 * carry the explanations that make it editable by hand.
 * @param {string} text - raw file contents.
 * @returns {unknown} the parsed value.
 */
function parseJsonc(text) {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      out += ch
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; out += ch; continue }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue }
    if (ch === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue }
    out += ch
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** @returns {typeof DEFAULTS} the merged configuration. */
function loadConfig() {
  // Provider keys live in the gitignored .env; load it before anything reads a key variable.
  loadDotEnv()
  const file = join(REPO, 'finess.config.json')
  if (!existsSync(file)) { warn('finess.config.json not found - using built-in defaults'); return structuredClone(DEFAULTS) }
  let raw
  try { raw = parseJsonc(readFileSync(file, 'utf8')) } catch (e) { die(`finess.config.json is not valid JSON: ${e.message}`) }
  const cfg = structuredClone(DEFAULTS)
  for (const [k, v] of Object.entries(raw)) {
    cfg[k] = v !== null && typeof v === 'object' && !Array.isArray(v) ? { ...cfg[k], ...v } : v
  }
  return cfg
}

/** @returns {typeof DEFAULTS} the merged configuration, for the `scripts/model.mjs` entry point. */
export const loadConfigForCli = () => loadConfig()

/**
 * Load the command registry with the active persona's own commands layered on top, so `/help` and
 * dispatch both see them exactly while that persona is active.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @returns {Promise<Map<string, object>>} commands by name, including aliases.
 */
async function loadActiveCommands(cfg) {
  const persona = loadPersonas(cfg).get(activePersonaId(cfg))
  return loadCommands({ persona, root: REPO })
}

/**
 * `--list-commands`: print the active command list as JSON on stdout, and nothing else there.
 * Loader warnings (a persona listing a missing command, ...) go to stderr so the JSON stays parseable.
 * @param {typeof DEFAULTS} cfg - configuration.
 */
async function printCommandList(cfg) {
  const log = console.log
  console.log = console.error
  let commands
  try { commands = await loadActiveCommands(cfg) } finally { console.log = log }
  process.stdout.write(`${JSON.stringify(commandList(commands))}\n`)
}

/**
 * Build a command context for a standalone script entry point (loop-task, dashboard and friends),
 * so those tools get the same `dsh` runner, route environment and conversation the REPL uses.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @returns {Promise<object>} the context.
 */
export async function makeCliContext(cfg) {
  const commands = await loadActiveCommands(cfg)
  const convo = conversation()
  return makeCtx(cfg, commands, convo)
}

/**
 * Run a command, inheriting stdio unless capturing.
 * @param {string} cmd - executable name.
 * @param {string[]} args - arguments.
 * @param {{capture?: boolean, env?: Record<string,string>, cwd?: string, allowFail?: boolean}} [opts] - options.
 * @returns {{code: number, out: string}} exit status and captured output.
 */
function sh(cmd, args, opts = {}) {
  const base = {
    cwd: opts.cwd ?? REPO,
    env: { ...process.env, ...opts.env },
    stdio: opts.capture === true ? 'pipe' : 'inherit',
    encoding: 'utf8',
  }
  // Node refuses to spawn a Windows `.cmd` shim without a shell (EINVAL, since 20.12), and
  // npm/pnpm/dsh/engram are all shims. So on Windows we opt into the shell and do the quoting
  // ourselves — never pass an unquoted argument through it.
  // The whole command line is assembled here rather than passed as an args array, which is what
  // Node's DEP0190 warning asks for: with `shell: true` the array would be concatenated unquoted.
  const r = WIN
    ? spawnSync([cmd, ...args.map(winQuote)].join(' '), { ...base, shell: true })
    : spawnSync(cmd, args, base)
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  if (r.status !== 0 && opts.allowFail !== true && opts.capture === true) info(lastLines(out, 3))
  return { code: r.status ?? 1, out }
}

/**
 * The tail of a captured output, for one-line diagnostics.
 * @param {string} text - captured stdout+stderr.
 * @param {number} n - how many trailing lines to keep.
 * @returns {string} the last `n` non-empty-trimmed lines, newline-joined.
 */
function lastLines(text, n) {
  const lines = String(text).split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

/**
 * Quote one argument for `cmd.exe`. Wrapping in double quotes neutralises spaces and the shell
 * metacharacters; embedded quotes are backslash-escaped, and `%` is neutralised with a caret so a
 * task mentioning `%PATH%` is not expanded.
 * @param {string} a - the raw argument.
 * @returns {string} the quoted argument.
 */
function winQuote(a) {
  const s = String(a)
  if (s === '') return '""'
  return `"${s.replaceAll('"', '\\"').replaceAll('%', '%^')}"`
}

/** Cached path to the substrate's JS entry point, so the lookup happens at most once per process. */
let dshEntry

/**
 * Run the substrate directly, never through a shell.
 *
 * `sh()` has to use `cmd.exe` on Windows because `dsh` is a `.cmd` shim, and that mangles real task
 * text three ways: a newline in an argument ends the command, the command line is capped near 8191
 * characters, and `%` is expanded. Resolving the shim to its JS file and spawning `process.execPath`
 * with it sidesteps all three, on every platform.
 * @param {string[]} args - arguments for dsh.
 * @param {{env?: Record<string,string>, capture?: boolean, timeoutMs?: number, cwd?: string}} [opts] - options; `timeoutMs` kills the run and sets `timedOut`; `cwd` (default: this repo) is the agent's working directory.
 * @returns {{code: number, out: string, timedOut?: boolean}} exit status and captured output.
 */
function dsh(args, opts = {}) {
  resolveDshEntry()
  // Fall back to the shim only if the entry point could not be resolved; the caveats above apply.
  if (dshEntry === null) return sh('dsh', args, opts)
  const r = spawnSync(process.execPath, [dshEntry, ...args], {
    cwd: opts.cwd ?? REPO,
    env: { ...process.env, ...opts.env },
    stdio: opts.capture === true ? 'pipe' : 'inherit',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(opts.timeoutMs > 0 ? { timeout: opts.timeoutMs, killSignal: 'SIGKILL' } : {}),
  })
  // A spawn that never started (ENAMETOOLONG on an oversized Windows command line) has no output of its own.
  if (r.error !== undefined && r.error.code !== 'ETIMEDOUT') warn(`the substrate did not start: ${r.error.message}`)
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), timedOut: r.error?.code === 'ETIMEDOUT' }
}

/**
 * `dsh` without blocking the event loop: what lets the team runner's `--parallel` actually overlap
 * runs (T-144). Same entry resolution and the same shim fallback, just awaited.
 * @param {string[]} args - arguments for dsh.
 * @param {{env?: Record<string,string>, capture?: boolean, cwd?: string}} [opts] - options.
 * @returns {Promise<{code: number, out: string}>} exit status and captured output.
 */
function dshAsync(args, opts = {}) {
  resolveDshEntry()
  return dshEntry === null
    ? shAsync('dsh', args, opts)
    : spawnAsync(process.execPath, [dshEntry, ...args], opts)
}

/** Resolve, once, the JS entry point behind the global `dsh` shim; null when it cannot be found. */
function resolveDshEntry() {
  if (dshEntry === undefined) {
    const root = npmRootGlobal()
    const dir = root === undefined ? undefined : join(root, '@deepseek-ai', 'dsh')
    try {
      const bin = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).bin
      const rel = typeof bin === 'string' ? bin : bin?.dsh
      dshEntry = rel === undefined ? null : join(dir, rel)
      if (dshEntry !== null && !existsSync(dshEntry)) dshEntry = null
    } catch { dshEntry = null }
  }
}

/**
 * @param {string} cmd - executable name.
 * @param {string} [arg] - the version flag.
 * @returns {string|undefined} its reported version line, or undefined when absent.
 */
function version(cmd, arg = '--version') {
  const r = sh(cmd, [arg], { capture: true, allowFail: true })
  return r.code === 0 ? r.out.split('\n')[0].trim() : undefined
}

/** @returns {string} `$DSH_HOME`, honouring the environment override. */
const dshHome = () => process.env.DSH_HOME ?? join(homedir(), '.dsh')
/** @param {string} name - profile name. @returns {string} the profile directory. */
const profileDir = name => join(dshHome(), 'profiles', name)

/**
 * The profile's declared dependencies. pnpm exits non-zero on conditions that did not actually stop
 * the install (`ERR_PNPM_IGNORED_BUILDS`, peer warnings), so setup verifies the OUTCOME here
 * instead of trusting an exit code.
 * @param {string} dir - the profile directory.
 * @returns {Record<string, string>} the dependency map, empty when unreadable.
 */
function profileDeps(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies ?? {} } catch { return {} }
}

/** @returns {string|undefined} the global npm root, where the dsh runtime lives. */
function npmRootGlobal() {
  const r = sh('npm', ['root', '-g'], { capture: true, allowFail: true })
  return r.code === 0 ? r.out.split('\n').pop().trim() : undefined
}

// -------------------------------------------------------------- patch generation

/** @param {string} s - arbitrary text. @returns {string} the text as a safe single-quoted YAML scalar. */
const yq = s => `'${String(s).replaceAll("'", "''")}'`

/**
 * Emit `key: value`, using a literal block scalar when the value spans lines — a quoted flow scalar
 * would fold those newlines into spaces and flatten a tip list into one paragraph.
 * @param {string} key - the mapping key.
 * @param {string} value - the scalar value.
 * @param {string} pad - the indentation of the key.
 * @returns {string[]} the rendered lines.
 */
function yblock(key, value, pad) {
  const text = String(value)
  if (!text.includes('\n')) return [`${pad}${key}: ${yq(text)}`]
  return [`${pad}${key}: |-`, ...text.split('\n').map(l => `${pad}  ${l}`)]
}

/**
 * Compose the persona text that reaches the system prompt: its prefix, and its suffix plus the
 * standing tips. This is the M4 persona subsystem's stand-in - one existing seam, no new code.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @param {object} [state] - the launcher state; `.finess/state.json` unless a test passes one.
 * @returns {{prefix: string, suffix: string, name: string}} the resolved persona text.
 */
function resolvePersona(cfg, state = readState()) {
  const id = activePersonaId(cfg, state)
  const persona = loadPersonas(cfg).get(id)
  if (persona === undefined) {
    die(`active persona "${id}" has no definition`, 'add personas/<id>.json, or run: ./turn_on.sh persona list')
  }
  const { prefix, suffix } = personaPrompt(persona, cfg.tips ?? [])
  return { name: id, prefix, suffix, persona }
}

/**
 * Whether a `settings.plugins` row belongs in a profile of the given surface. A row without
 * `surfaces` goes everywhere; `"surfaces": ["web"]` keeps it out of the headless profile.
 * @param {{surfaces?: string[]}} p - the plugin row.
 * @param {string} surface - the profile's template (`headless`, `web`, ...).
 * @returns {boolean} whether the row applies.
 */
export const pluginOnSurface = (p, surface) => p.surfaces === undefined || p.surfaces.includes(surface)

/**
 * Render a profile patch from the configuration, for one surface.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @param {{surface: string, repo?: string, state?: object}} opts - the profile's surface, the checkout
 *   path to give rows with `"repoConfig": true` as `config.repo` (omitted in the committed copy, so no
 *   machine path is ever committed), and the launcher state (`.finess/state.json` unless a test
 *   passes one).
 * @returns {string} the patch text.
 */
export function renderPatch(cfg, { surface, repo, state = readState() }) {
  const persona = resolvePersona(cfg, state)
  const routes = knownRoutes(cfg, { state })
  const eff = effectiveRoute(cfg, { state })
  warnPreset(eff)
  if (eff.error !== undefined) die(eff.error, 'back to the local model: /api local')
  const L = []
  L.push('# GENERATED by scripts/finess.mjs from finess.config.json - do not edit by hand.')
  L.push('# Regenerate with `./turn_on.sh sync` (or .\\turn_on.ps1 sync). It stays committed so')
  L.push('# reviewers see the composed tree, but finess.config.json is the source of truth.')
  // The $DSH_HOME copy names the checkout that wrote it, so another checkout's sync can warn (T-336).
  if (repo !== undefined) L.push(`${CHECKOUT_STAMP}${repo}`)
  L.push('')
  L.push('- insert:')
  for (const p of cfg.settings.plugins ?? []) {
    if (!pluginOnSurface(p, surface)) continue
    L.push(`    - id: ${p.id}`)
    L.push(`      name: ${yq(p.package)}`)
    if (p.enabled === false) L.push('      disabled: true')
    if (p.repoConfig === true && repo !== undefined) {
      L.push('      config:')
      L.push(`        repo: ${yq(repo)}`)
    }
  }
  L.push('    # Model routes. No adapter of ours is needed: dsh-llm-pi-ai serves hand-declared')
  L.push('    # OpenAI-compatible gateways given api + baseURL + a non-empty models list, and')
  L.push('    # catalog providers given only the variable their key is read from.')
  L.push('    - id: llm-pi-ai')
  L.push("      name: '@deepseek-ai/dsh-llm-pi-ai'")
  L.push('      config:')
  L.push('        providers:')
  for (const [name, r] of Object.entries(routes)) {
    L.push(`          ${name}:`)
    L.push(`            displayName: ${yq(r.displayName ?? name)}`)
    if (r.apiKeyEnv !== undefined) L.push(`            apiKeyEnv: ${r.apiKeyEnv}`)
    // A catalog route takes endpoint, protocol and models from the installed adapter. A `models`
    // list would REPLACE that catalog, so nothing else is written for it.
    if (r.kind === 'catalog') continue
    L.push(`            api: ${r.api ?? 'openai-completions'}`)
    L.push(`            baseURL: ${yq(r.baseURL)}`)
    L.push(`            defaultContextWindow: ${r.contextWindow ?? 32768}`)
    L.push(`            defaultMaxTokens: ${r.maxTokens ?? 4096}`)
    L.push('            models:')
    // The local engine serves every registered model, so /model can switch between them.
    const ids = r.kind === 'local' ? localModels(cfg, { state }) : [...new Set([r.id, ...(r.models ?? [])].filter(x => x !== undefined))]
    for (const id of ids) {
      L.push(`              - id: ${yq(id)}`)
      L.push(`                name: ${yq(id === r.id ? (r.displayName ?? id) : id)}`)
      L.push(`                contextWindow: ${r.contextWindow ?? 32768}`)
      if (r.reasoning === false) L.push('                reasoningEfforts: false')
    }
  }
  L.push('')
  // Route and model come from lib/routes.mjs: /api or /model choice, then persona, then config. The
  // choice lives in .finess/state.json so switching never rewrites the commented config file.
  L.push('# A patch replaces the targeted row config wholesale, so every field is restated.')
  L.push(`# Model chosen by: ${eff.source}.`)
  L.push('- id: agent-default-model')
  L.push('  config:')
  L.push(`    provider: ${eff.name}`)
  L.push(`    model: ${yq(eff.model)}`)
  L.push('')
  L.push(`# Persona "${persona.name}" + tips, injected through the existing system-prompt seam.`)
  L.push('- id: system-prompt')
  L.push('  config:')
  L.push(...yblock('personaPrefix', persona.prefix, '    '))
  L.push(...yblock('personaSuffix', `${persona.suffix}\nYour working directory is {{cwd}}.`, '    '))
  L.push('')
  L.push('- id: tools')
  L.push('  config:')
  L.push(`    mode: ${cfg.settings.toolsMode ?? 'native'}`)
  L.push('')
  return L.join('\n')
}

/**
 * Write `profiles/<name>/cordis.patch.yml`, the main profile's patch. The file stays committed so a
 * reviewer sees exactly what the runtime composes, but it is generated - edit the config instead.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @returns {string} the path written.
 */
function writePatch(cfg) {
  const dir = join(REPO, 'profiles', cfg.profile.name)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'cordis.patch.yml')
  writeFileSync(file, renderPatch(cfg, { surface: cfg.profile.template }), 'utf8')
  return file
}

/**
 * The route the next run will use, and the environment it needs.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @returns {{route: string, r: object, env: Record<string,string>}} the resolved route.
 */
function resolveRoute(cfg) {
  const eff = effectiveRoute(cfg)
  warnPreset(eff)
  const { env, missingKey } = routeEnvironment(cfg)
  return { route: eff.name, r: eff.route, model: eff.model, env, missingKey, error: eff.error }
}

/** Refit temperatures, read once per REPL start (`/decisions-data refit` writes them). */
let shadowTemperatures

/**
 * Shadow-route one task: ask the decision model what it would do, log it beside what the rules
 * decide, and change nothing. This is how the labelled set for calibration gets built, and it is the
 * only mode the decision layer runs in until it has earned more (ADR-0009, T-223).
 * @param {typeof DEFAULTS} cfg - configuration.
 * @param {string} text - the task text.
 * @returns {Promise<void>} resolves once the decision is logged.
 */
async function shadowRoute(cfg, text) {
  const dc = decisionConfig(cfg)
  if (dc.enabled !== true || dc.shadow !== true) return
  if (process.env[dc.apiKeyEnv] === undefined) {
    try { process.env[dc.apiKeyEnv] = readFileSync(join(RUN_DIR_LOCAL, 'laya.key'), 'utf8').trim() } catch { /* no key file */ }
  }
  const rules = ruleRoute(text)
  const r = await askDecision(dc, text, ROUTING_QUESTIONS, { retries: 1 })
  if (!r.ok) {
    info(paint(C.dim, `shadow: ${decisionFailure(r)}`))
    return
  }
  shadowTemperatures ??= loadTemperatures()
  const model = modelAnswers(r.body, shadowTemperatures)
  const agree = Object.keys(ROUTING_QUESTIONS).filter(k => model[k].answer === rules[k])
  logShadowDecision({ source: 'repl', task: text.slice(0, 500), ms: r.ms, model, rules, agreement: agree.length })
  info(paint(C.dim, `shadow ${r.ms}ms: model ${model.level.answer}/${model.tier.answer}/${model.pipeline.answer}`
    + ` vs rules ${rules.level}/${rules.tier}/${rules.pipeline} (${agree.length}/3 agree, logged)`))
}

/**
 * The command bar printed when the REPL opens: every quick-tool, grouped, so the options are
 * visible without asking for them. Discoverability is the point — a command nobody can see is a
 * command nobody uses.
 * @param {Map<string, object>} commands - the loaded registry.
 * @returns {string[]} the lines to print.
 */
function commandBar(commands) {
  const groups = new Map()
  for (const cmd of new Set(commands.values())) {
    groups.set(cmd.group ?? 'other', [...(groups.get(cmd.group ?? 'other') ?? []), cmd.name])
  }
  const order = ['core', 'model', 'decisions', 'personas', 'teams', 'telemetry', 'other']
  const width = Math.max(...[...groups.keys()].map(g => g.length))
  return [...groups.keys()]
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map(g => `  ${paint(C.dim, g.padEnd(width))}  ${groups.get(g).sort().map(n => `/${n}`).join('  ')}`)
}

/**
 * Argument candidates per command, recomputed when the dropdown needs them. Kept lazy because some
 * sources (the local model list) shell out, and a keystroke must not pay for that.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @returns {() => Record<string, string[]>} a memoised supplier, refreshed every few seconds.
 */
function makeArgsSupplier(cfg) {
  let cache
  let at = 0
  return () => {
    if (cache !== undefined && Date.now() - at < 5000) return cache
    const personas = [...loadPersonas(cfg).keys()]
    const teams = [...loadTeams().keys()]
    const sessions = listSessions({ limit: 10 }).map(x => x.id.slice(0, 8))
    const list = sh('ollama', ['list'], { capture: true, allowFail: true })
    const models = list.code === 0
      ? list.out.split('\n').slice(1).map(l => l.split(/\s\s+/)[0]).filter(x => x !== undefined && x.trim() !== '')
      : []
    const names = [...new Set([...loadPersonas(cfg).keys()])]
    cache = {
      persona: ['list', 'show', ...personas],
      recipe: [...loadRecipes(join(REPO, 'recipes')).recipes.keys()],
      team: ['list', 'show', 'run', ...teams],
      teams: ['list', 'show', 'run', ...teams],
      delegate: personas,
      task: ['list', '--limit'],
      resume: sessions,
      model: ['reset', ...models],
      models: ['list', 'search', 'add', 'rm', '--use', '--purge', ...models],
      api: ['use', 'models', 'key', 'local', ...catalogProviders(cfg).keys()],
      access: ['read-only', 'workspace', 'full', 'reset'],
      workspace: ['reset'],
      decision: ['up', 'stats', 'down', '--force'],
      dashboard: ['--no-open', '--limit'],
      usage: ['--all', '--limit'],
      cost: ['--all', '--limit'],
      sessions: ['--all', '--limit'],
      tools: ['--all', '--session'],
      help: names.length > 0 ? [] : [],
    }
    at = Date.now()
    return cache
  }
}

/**
 * Tab completion for the REPL: command names after a slash, then that command's own arguments
 * (persona ids, team ids, session ids, local model ids) so the options can be discovered by pressing
 * tab rather than by reading documentation.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @param {Map<string, object>} commands - the loaded registry.
 * @returns {(line: string) => [string[], string]} a readline completer.
 */
function makeCompleter(cfg, commands) {
  return line => {
    if (!line.startsWith('/')) return [[], line]
    const parts = line.split(/\s+/)
    const names = [...new Set([...commands.values()].map(c => c.name))].sort()
    if (parts.length === 1) {
      const hits = names.map(n => `/${n}`).filter(n => n.startsWith(parts[0]))
      return [hits.length > 0 ? hits : names.map(n => `/${n}`), line]
    }
    const cmd = parts[0].replace(/^\//, '').toLowerCase()
    const word = parts[parts.length - 1]
    /** @param {string[]} options - candidate words. @returns {[string[], string]} the completion. */
    const complete = options => {
      const hits = options.filter(o => o.startsWith(word))
      return [hits.length > 0 ? hits : options, word]
    }
    if (cmd === 'persona' || cmd === 'p') return complete(['list', 'show', ...loadPersonas(cfg).keys()])
    if (cmd === 'delegate' && parts.length === 2) return complete([...loadPersonas(cfg).keys()])
    if (cmd === 'recipe' && parts.length === 2) return complete([...loadRecipes(join(REPO, 'recipes')).recipes.keys()])
    if (cmd === 'team' || cmd === 'teams') return complete(['list', 'show', 'run', ...loadTeams().keys()])
    if (cmd === 'resume' || cmd === 'continue') {
      return complete(listSessions({ limit: 10 }).map(x => x.id.slice(0, 8)))
    }
    if (cmd === 'model') {
      const list = sh('ollama', ['list'], { capture: true, allowFail: true })
      const ids = list.code === 0
        ? list.out.split('\n').slice(1).map(l => l.split(/\s\s+/)[0]).filter(x => x !== undefined && x.trim() !== '')
        : []
      return complete(['reset', ...ids])
    }
    if (cmd === 'help' || cmd === '?') return complete(names)
    return [[], line]
  }
}

/**
 * @param {string} identity - a session identity.
 * @returns {string} the short form used in output.
 */
const shortSession = identity => String(identity).replace(/^session-/, '').slice(0, 8)

/**
 * One substrate session, reused across turns.
 *
 * Without this every REPL line was a fresh session, so the model started blind each time - it could
 * not remember the previous answer, let alone build on it. `--session-id` only *adopts* an existing
 * session ("does not exist; omit --session-id to start a new Session"), so the first turn runs
 * without it and we then identify the session it created by diffing the session list. The durable
 * session log stays the single source of truth for context; we only hold its id.
 * Sessions are looked up under the active workspace's key, read per call: `/workspace` moves it.
 * @returns {{id: () => string|undefined, adopt: (id: string) => void, reset: () => void, capture: (before: Set<string>) => void, snapshot: () => Set<string>}} the handle.
 */
function conversation() {
  let id = readState().session
  const key = () => workspaceKey(activeWorkspace().dir)
  return {
    id: () => id,
    adopt: next => { id = next; writeState({ session: next }) },
    reset: () => { id = undefined; writeState({ session: undefined }) },
    snapshot: () => new Set(listSessions({ workspace: key(), limit: 60 }).map(x => x.identity)),
    capture: before => {
      const fresh = listSessions({ workspace: key(), limit: 60 }).find(x => !before.has(x.identity))
      if (fresh !== undefined) { id = fresh.identity; writeState({ session: fresh.identity }) }
    },
  }
}

/**
 * Build the context every quick-tool receives. Commands run in this process: no model call and no
 * tokens, which is the whole reason they live outside the agent loop.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @param {Map<string, object>} commands - the loaded registry.
 * @returns {object} the command context.
 */
function makeCtx(cfg, commands, convo) {
  const { env } = resolveRoute(cfg)
  return {
    conversation: convo,
    cfg,
    commands,
    sh,
    // The team runner sends multi-line prompts, so it gets the shell-free runner; the async one is
    // what lets its --parallel overlap tasks.
    // Agent runs (teams, loop-task) start in the active workspace unless a caller picks a cwd.
    dsh: (a, o = {}) => dsh(a, { cwd: activeWorkspace().dir, ...o }),
    dshAsync: (a, o = {}) => dshAsync(a, { cwd: activeWorkspace().dir, ...o }),
    sync: () => syncPatch(cfg),
    routeEnv: env,
    activePersonaId: activePersonaId(cfg),
    // Sessions live under a directory named after the workspace path.
    workspaceKey: workspaceKey(activeWorkspace().dir),
    builtins: {
      // `/up` warms the model the next task would use, when that is a local one.
      up: async () => {
        const e = effectiveRoute(cfg)
        return (await modelUp(cfg, e.route?.kind === 'local' ? e.model : undefined)) ? 0 : 1
      },
      down: async a => ((await modelDown(cfg, { force: a.includes('--force') })) ? 0 : 1),
      off: async a => ((await cmdOff(cfg, { force: a.includes('--force') })) ? 0 : 1),
      stats: async () => ((await modelStats(cfg)) ? 0 : 1),
      doctor: async () => { await cmdDoctor(cfg); return 0 },
      sync: () => { syncPatch(cfg); return 0 },
      graph: () => { cmdGraph(); return 0 },
      web: a => cmdWeb(cfg, a),
      model: a => cmdModel(cfg, a),
    },
  }
}

/**
 * `/model` - show the resolved model, or override it. The override is state, not config.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @param {string[]} args - an optional model id, or `reset`.
 * @returns {number} exit code.
 */
async function cmdModel(cfg, args) {
  const { route, r, model } = resolveRoute(cfg)
  if (args.length === 0) {
    const state = readState()
    step(`route ${route} (${r.kind}) - model ${model ?? '(none)'}`)
    info(`configured model  : ${r.id ?? '(none)'}`)
    info(`persona preference: ${loadPersonas(cfg).get(activePersonaId(cfg))?.model?.id ?? '(none)'}`)
    info(`/model override   : ${state.model ?? '(none)'}`)
    for (const [, v, s] of await fallbackRows(cfg)) info(`fallback          : ${v} - ${s}${state.route !== undefined || state.model !== undefined ? ' (not applied: you chose a model)' : ''}`)
    const small = smallModelNote(model)
    if (small !== undefined) warn(small)
    const list = sh('ollama', ['list'], { capture: true, allowFail: true })
    if (list.code === 0) {
      info('locally available:')
      for (const l of list.out.split('\n').slice(1, 9)) if (l.trim() !== '') info(`  ${l.split(/\s\s+/)[0]}`)
    }
    info('switch with /model <id>, clear with /model reset')
    return 0
  }
  if (args[0] === 'reset') { writeState({ model: undefined, modelRoute: undefined }); syncPatch(cfg); ok('model override cleared'); return 0 }
  if (r.kind === 'catalog') {
    const known = catalogProviders(cfg).get(route)?.models ?? []
    if (known.length > 0 && !known.includes(args[0])) {
      warn(`${args[0]} is not in the ${route} catalog`)
      info(`list them with /api models ${route}`)
      return 1
    }
  }
  writeState({ model: args[0], modelRoute: route })
  syncPatch(cfg)
  ok(`model override set to ${args[0]} (route ${route})`)
  const small = smallModelNote(args[0])
  if (small !== undefined) warn(small)
  if (r.kind === 'local') info('the engine pulls it on the next run if it is missing - or fetch it now with /models add')
  return 0
}

/**
 * Copy the generated patch into `$DSH_HOME`, where the runtime reads it.
 * @param {typeof DEFAULTS} cfg - configuration.
 */
function syncPatch(cfg) {
  writePatch(cfg)
  const dir = profileDir(cfg.profile.name)
  if (!existsSync(dir)) die(`profile "${cfg.profile.name}" does not exist yet`, 'run: ./turn_on.sh setup')
  // The rows the patch targets (model, system prompt, tools) are identical in the headless and web
  // templates, so a persona or model switch reaches the browser UI too. Each profile gets its own
  // render only so plugin rows limited to one surface (`surfaces`) stay out of the other, and the
  // checkout path (`repoConfig`) lands here, never in the committed copy.
  const targets = [[dir, cfg.profile.template], [profileDir(webProfileName(cfg)), 'web']]
  for (const [d, surface] of targets) {
    if (!existsSync(d)) continue
    const file = join(d, 'cordis.patch.yml')
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : undefined
    for (const w of syncWarnings({ existing, repo: REPO, worktree: isWorktree(REPO) })) warn(w)
    writeFileSync(join(d, 'cordis.patch.yml'), renderPatch(cfg, { surface, repo: REPO }), 'utf8')
    ok(`patch synced -> ${join(d, 'cordis.patch.yml')}`)
  }
}

/**
 * The sibling profile that serves the browser UI. It is kept apart from the main profile so the
 * terminal REPL and the web composer can both be used without re-creating either.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @returns {string} the web profile's name.
 */
const webProfileName = cfg => cfg.profile.webName ?? `${cfg.profile.name}-web`

/**
 * Create a profile from a shipped template if it is missing, then install what every FiNess
 * profile needs: the route adapter, the linked substrate packages and our plugins.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @param {string} name - the profile name.
 * @param {string} template - the shipped template it is created from.
 */
function ensureProfile(cfg, name, template) {
  const want = cfg.substrate.version
  const dir = profileDir(name)
  if (!existsSync(join(dir, 'package.json'))) {
    step(`creating profile "${name}" from the ${template} template`)
    if (dsh(['--profile', name, '--from-default-profile', template, '--dump-config'], { capture: true }).code !== 0) {
      die(`could not create profile "${name}"`)
    }
  }
  ok(`profile ${dir}`)

  // pnpm 11 aborts an install while any dependency's install script is undecided; the decisions
  // live in the config so every machine (macOS or Windows) installs the same way.
  if (applyAllowBuilds(dir, cfg.settings.allowBuilds)) ok('install-script decisions written (settings.allowBuilds)')

  step(`installing profile dependencies (${name})`)
  const piai = '@deepseek-ai/dsh-llm-pi-ai'
  sh('pnpm', ['add', `${piai}@${want}`], { cwd: dir, capture: true, allowFail: true })
  if (profileDeps(dir)[piai] === undefined) warn(`could not install ${piai}@${want}`)
  else ok(`route adapter ${piai}@${profileDeps(dir)[piai]}`)

  // Substrate packages MUST resolve to the runtime's own files: a second copy breaks every tool
  // call, because dsh-tools keys its scheduler with a module-local Symbol.
  const root = npmRootGlobal()
  for (const pkg of cfg.settings.linkedSubstratePackages ?? []) {
    if (root === undefined) { warn(`cannot resolve npm root -g; skipped linking ${pkg}`); break }
    const target = join(root, '@deepseek-ai', 'dsh', 'node_modules', ...pkg.split('/'))
    if (!existsSync(target)) { warn(`${pkg} not found under the dsh runtime (${target})`); continue }
    if (profileDeps(dir)[pkg]?.startsWith('link:') !== true) {
      sh('pnpm', ['remove', pkg], { cwd: dir, capture: true, allowFail: true })
      sh('pnpm', ['add', `link:${target}`], { cwd: dir, capture: true, allowFail: true })
    }
    if (profileDeps(dir)[pkg]?.startsWith('link:') === true) ok(`linked ${pkg} -> runtime copy`)
    else warn(`could not link ${pkg} — tool calls will fail until this is fixed (see docs/RUNBOOK.md)`)
  }

  for (const p of cfg.settings.plugins ?? []) {
    if (!pluginOnSurface(p, template)) continue
    if (p.path === undefined) {
      sh('pnpm', ['add', p.package], { cwd: dir, capture: true, allowFail: true })
      if (profileDeps(dir)[p.package] === undefined) warn(`could not add ${p.package}`)
      else ok(`plugin ${p.package}`)
      continue
    }
    const abs = resolve(REPO, p.path)
    if (!existsSync(abs)) { warn(`plugin path missing: ${p.path}`); continue }
    // pnpm reuses its copy of a same-version `file:` package, so remove it first when its files changed.
    const hash = hashPluginDir(abs)
    const stale = pluginNeedsReinstall({ stored: readPluginHashes(dir)[p.package], current: hash, installed: profileDeps(dir)[p.package] !== undefined })
    if (stale) sh('pnpm', ['remove', p.package], { cwd: dir, capture: true, allowFail: true })
    sh('pnpm', ['add', `file:${abs}`], { cwd: dir, capture: true, allowFail: true })
    if (profileDeps(dir)[p.package] === undefined) warn(`could not add ${p.package} from ${p.path}`)
    else {
      writePluginHash(dir, p.package, hash)
      ok(`plugin ${p.package} <- ${p.path}${stale ? ' (changed, reinstalled)' : ''}`)
    }
  }

  // Browser-UI bundles carry their own patch, so they are added as bundles (the way their authors
  // ask), and only to the web profile: the headless REPL has no browser to render them.
  if (template === 'web') {
    for (const spec of cfg.settings.webBundles ?? []) {
      const pkg = bundleName(spec)
      if (!profileBundles(dir).includes(pkg)) dsh(['plugin', '--profile', name, 'add', spec], { capture: true })
      // `plugin add` only enables a bundle it newly installs; one already present stays off.
      enableBundle(dir, pkg)
      if (profileBundles(dir).includes(pkg)) ok(`web bundle ${pkg}`)
      else warn(`could not add the web bundle ${pkg} (see ${join(dir, '.plugin-manager', 'logs')})`)
    }
  }
  const undecided = undecidedBuilds(dir)
  if (undecided.length > 0) {
    warn(`pnpm stopped on undecided install scripts: ${undecided.join(', ')}`)
    info('decide each in finess.config.json settings.allowBuilds (false = never run it), then re-run setup')
  }
}

// ---------------------------------------------------------------------- commands

/** Install or repair everything the harness needs. @param {typeof DEFAULTS} cfg - configuration. */
async function cmdSetup(cfg) {
  step(`node ${process.versions.node}`)
  if (!nodeOk()) die(`Node ${NODE_MIN.join('.')}+ is required by the substrate`, 'install Node 22.19+ or 24+ and re-run')
  ok('node version satisfies the substrate engine range')

  if (version('pnpm') === undefined) {
    step(`installing pnpm@${cfg.substrate.pnpmVersion} (dsh plugin shells out to it)`)
    if (sh('npm', ['i', '-g', `pnpm@${cfg.substrate.pnpmVersion}`]).code !== 0) die('pnpm install failed')
  }
  ok(`pnpm ${version('pnpm')}`)

  const want = cfg.substrate.version
  const have = version('dsh', '--version')
  if (have !== want) {
    step(`installing @deepseek-ai/dsh@${want}${have === undefined ? '' : ` (found ${have})`}`)
    if (sh('npm', ['i', '-g', `@deepseek-ai/dsh@${want}`]).code !== 0) die('dsh install failed')
  }
  ok(`dsh ${version('dsh', '--version')}`)

  if (!existsSync(join(REPO, 'upstream', 'deepseek-harness', 'package.json'))) {
    step('fetching the read-only upstream submodule (source of truth for seams)')
    sh('git', ['submodule', 'update', '--init', '--depth', '1'], { allowFail: true })
  }
  ok('upstream submodule present')

  ensureProfile(cfg, cfg.profile.name, cfg.profile.template)
  // The browser UI (a composer bar instead of a terminal prompt) lives in a sibling profile.
  if (cfg.profile.template !== 'web') ensureProfile(cfg, webProfileName(cfg), 'web')

  syncPatch(cfg)

  await modelUp(cfg)
  step('setup complete')
  info(WIN ? 'next: .\\turn_on.ps1' : 'next: ./turn_on.sh')
}

/**
 * @param {string} baseURL - the route base URL.
 * @param {number} [ms] - probe budget.
 * @returns {Promise<boolean>} whether an engine server answers there.
 */
async function engineAnswers(baseURL, ms = 2500) {
  try {
    const r = await fetch(`${String(baseURL).replace(/\/v1\/?$/, '')}/api/version`, { signal: AbortSignal.timeout(ms) })
    return r.ok
  } catch { return false }
}

/**
 * Doctor rows for the route: which model runs where, whether its key is present (by name only - a
 * value is never printed), and the sandbox mode the tools run under.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @returns {string[][]} rows of [label, value, status].
 */
function routeRows(cfg) {
  const e = effectiveRoute(cfg)
  const { missingKey } = routeEnvironment(cfg)
  const key = e.route?.apiKeyEnv
  return [
    ['route', e.name, e.error ?? `${e.route.kind}, chosen by ${e.source}`],
    ['model', e.model ?? '-', smallModelNote(e.model) ?? (e.route?.kind === 'local' ? `${localModels(cfg).length} registered locally` : 'served by the provider')],
    ['api key', key ?? '-', missingKey !== undefined ? 'missing - add it to .env' : (key === undefined || e.route.apiKeyValue !== undefined ? 'not needed' : 'set')],
    ['access', accessMode(), 'sandbox for shell and file tools (/access)'],
    ['workspace', activeWorkspace().dir, activeWorkspace().isRepo ? 'this repo (/workspace)' : 'another project (/workspace reset goes back)'],
  ]
}

/** Print what is installed and what is missing. @param {typeof DEFAULTS} cfg - configuration. */
async function cmdDoctor(cfg) {
  const dshv = version('dsh', '--version')
  const engineVer = version(cfg.model.engine ?? 'ollama')
  const engineUp = await engineAnswers(cfg.model.baseURL)
  const rows = [
    ['node', process.versions.node, nodeOk() ? 'ok' : `needs ${NODE_MIN.join('.')}+`],
    ['pnpm', version('pnpm') ?? '-', version('pnpm') === undefined ? 'missing' : 'ok'],
    ['dsh', dshv ?? '-', dshv === cfg.substrate.version ? 'ok' : `want ${cfg.substrate.version}`],
    ['engine', engineVer ?? '-', engineUp ? 'serving' : 'not serving'],
    ['engram', version('engram') ?? '-', version('engram') === undefined ? 'optional' : 'ok'],
    ['profile', profileDir(cfg.profile.name), existsSync(profileDir(cfg.profile.name)) ? 'ok' : 'run setup'],
    ['web ui', profileDir(webProfileName(cfg)), existsSync(join(profileDir(webProfileName(cfg)), 'package.json')) ? 'ok' : 'created on first `web`'],
    ['submodule', 'upstream/deepseek-harness', existsSync(join(REPO, 'upstream/deepseek-harness/package.json')) ? 'ok' : 'run setup'],
    ['persona', activePersonaId(cfg), `${(cfg.tips ?? []).length} tip(s)`],
    ...routeRows(cfg),
    ...(await fallbackRows(cfg)),
    ['decisions', decisionConfig(cfg).baseURL, (await decisionHealth(decisionConfig(cfg))) ? 'serving' : (decisionConfig(cfg).enabled === true ? 'not serving' : 'off (optional)')],
  ]
  const w = Math.max(...rows.map(r => r[0].length))
  for (const [k, v, s] of rows) {
    const bad = /missing|run setup|needs|want|not serving|not declared|no model|too small/.test(s)
    console.log(`  ${k.padEnd(w)}  ${v}  ${paint(bad ? C.yellow : C.dim, `(${s})`)}`)
  }
  // T-452: an engine that is not serving gets the reasons it may not start, each with a fix.
  if (!engineUp) {
    const e = effectiveRoute(cfg)
    const found = runChecks(await gatherFacts({
      baseURL: cfg.model.baseURL, model: e.route?.kind === 'local' ? e.model : undefined,
      engineAnswering: false, binary: engineVer,
    }))
    for (const f of found) { console.log(`  ${paint(C.yellow, '!!')} engine: ${f.message}`); console.log(`     fix: ${f.fix}`) }
  }
}

/**
 * Everything a boot needs before dsh starts: the runtime, the profile, a fresh patch, a warm model
 * and the route's key in the environment.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @param {string} [name] - the profile about to boot.
 * @returns {Promise<{route: string, model: string, env: Record<string, string>}>} the active route,
 *   its model and the environment dsh must run with.
 */
async function prepareBoot(cfg, name = cfg.profile.name) {
  if (version('dsh', '--version') === undefined) die('dsh is not installed', 'run: ./turn_on.sh setup')
  if (!existsSync(join(profileDir(name), 'package.json'))) die(`profile "${name}" is missing`, 'run: ./turn_on.sh setup')
  syncPatch(cfg)
  const ready = await prepareRoute(cfg, new Set())
  if (ready === undefined) die('the selected route cannot run yet (see above)', 'back to the local model: /api local')
  return ready
}

/**
 * Serve the browser UI: a chat window with a message bar, instead of the terminal prompt. It boots
 * the sibling web profile with the same model, persona and plugins, creating it on first use.
 * Extra arguments reach the web app (`--port 8080`, `--no-open`, `--host`).
 * @param {typeof DEFAULTS} cfg - configuration.
 * @param {string[]} rest - arguments passed through to the web app.
 */
async function cmdWeb(cfg, rest) {
  const name = cfg.profile.template === 'web' ? cfg.profile.name : webProfileName(cfg)
  if (version('dsh', '--version') === undefined) die('dsh is not installed', 'run: ./turn_on.sh setup')
  if (!existsSync(join(profileDir(name), 'package.json'))) ensureProfile(cfg, name, 'web')
  const { model, env } = await prepareBoot(cfg, name)
  step(`serving the web UI - persona ${activePersonaId(cfg)}, model ${model}`)
  info('the browser opens on its own; if it does not, open the URL printed below (it carries the login token)')
  info('ctrl+c stops the server')
  const code = dsh(['--profile', name, ...rest], { env }).code
  process.exitCode = code
  return code
}

/**
 * Probe what `model.fallback` needs (the local engine, within 1 s, only when a list is set) and let
 * the pure chooser decide.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @returns {Promise<ReturnType<typeof chooseFallback>>} the decision.
 */
async function pickFallback(cfg) {
  const any = Array.isArray(cfg.model.fallback) && cfg.model.fallback.length > 0
  return chooseFallback(cfg, { engineUp: any ? await engineAnswers(cfg.model.baseURL, 1000) : true })
}

/**
 * Doctor and /model lines for the fallback list: each entry's status and which one would run now.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @returns {Promise<string[][]>} rows of [label, value, status]; empty when no list is set.
 */
async function fallbackRows(cfg) {
  const d = await pickFallback(cfg)
  if (d.candidates.length === 0) return []
  const list = d.candidates.map(c => `${c.route}/${c.id}${c.usable ? '' : ` (${c.why})`}`).join(', ')
  const now = d.use ? `would use ${d.name}/${d.model} now` : (d.reason === undefined ? 'default is fine - none needed' : 'none usable now')
  return [['fallback', list, now]]
}

/**
 * Make the effective route runnable: a local route needs its engine up and the chosen model pulled
 * (once per model per process); an API route needs its key. Says what is wrong instead of failing
 * inside the substrate with a less readable error.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @param {Set<string>} ready - local models already brought up in this process.
 * @returns {Promise<{route: string, model: string, env: Record<string,string>}|undefined>} the run
 *   environment, or undefined when the route cannot run.
 */
async function prepareRoute(cfg, ready, { fallback = false } = {}) {
  const fb = fallback ? await pickFallback(cfg) : undefined
  if (fb?.use === true) {
    // Said every time a fallback is used; never silent. The overlay pins this one task's model.
    console.log(paint(C.yellow, `  !! ${fb.line}`))
    mkdirSync(RUN_DIR_LOCAL, { recursive: true })
    const overlay = join(RUN_DIR_LOCAL, 'fallback.patch.yml')
    const q = x => `'${String(x).replaceAll("'", "''")}'`
    writeFileSync(overlay, `# GENERATED per-task fallback overlay - safe to delete.\n- id: agent-default-model\n  config:\n    provider: ${fb.name}\n    model: ${q(fb.model)}\n`, 'utf8')
    return { route: fb.name, model: fb.model, env: { ...routeEnvironment(cfg).env, ...fallbackEnv(fb.route) }, overlay }
  }
  const { route, r, model, env, missingKey, error } = resolveRoute(cfg)
  if (error !== undefined) { warn(error); return undefined }
  if (missingKey !== undefined) {
    warn(`route ${route} needs ${missingKey}, which is not set`)
    info(`add a line  ${missingKey}=<your key>  to ${join(REPO, '.env')} (gitignored), or /api local`)
    return undefined
  }
  if (r.kind === 'local' && !ready.has(model)) {
    if (!(await modelUp(cfg, model))) { warn(`the local model ${model} is not ready`); return undefined }
    ready.add(model)
  }
  return { route, model, env }
}

/**
 * Boot the harness. With a task it runs one-shot; without, it prompts (headless) or opens the app.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @param {string[]} task - the task words, if any.
 * @param {{noModel?: boolean}} [opts] - `noModel` opens the REPL without booting a model or the
 *   substrate (T-381): quick-tools work, free-text tasks print a hint instead.
 */
async function cmdRun(cfg, task, { noModel = false } = {}) {
  const dshVersion = version('dsh', '--version')
  const ready = new Set()
  let first
  if (noModel) {
    if (task.length > 0) die('--no-model opens the prompt only; a task needs the model', 'run the task without --no-model')
    if (cfg.profile.template !== 'headless') die('--no-model needs a headless profile (the app surface boots the substrate)')
  } else {
    if (dshVersion === undefined) die('dsh is not installed', 'run: ./turn_on.sh setup')
    if (!existsSync(join(profileDir(cfg.profile.name), 'package.json'))) die(`profile "${cfg.profile.name}" is missing`, 'run: ./turn_on.sh setup')
    syncPatch(cfg)
    first = await prepareRoute(cfg, ready, { fallback: true })
    // A one-shot run has nothing to fall back to; the REPL still opens, so /api local or /api use can
    // repair the route (every turn re-checks it).
    if (first === undefined && (task.length > 0 || cfg.profile.template !== 'headless')) {
      die('the selected route cannot run yet (see above)', 'back to the local model: /api local')
    }
  }
  let env = first?.env ?? {}

  const args = ['--profile', cfg.profile.name]
  const convo = conversation()

  if (task.length > 0) {
    // `--continue` (or `-c`) carries the previous conversation into a one-shot run.
    const wants = task[0] === '--continue' || task[0] === '-c'
    const text = (wants ? task.slice(1) : task).join(' ')
    const prior = wants ? convo.id() : undefined
    if (wants && prior === undefined) warn('no previous session recorded; starting a new one')
    const before = prior === undefined ? convo.snapshot() : undefined
    dsh([...args, ...(first?.overlay === undefined ? [] : ['--patch', first.overlay]), ...(prior === undefined ? [] : ['--session-id', prior]), text], { env, cwd: activeWorkspace().dir })
    if (before !== undefined) convo.capture(before)
    return
  }
  if (cfg.profile.template !== 'headless') { step(`booting the ${cfg.profile.template} surface`); dsh(args, { env, cwd: activeWorkspace().dir }); return }

  const commands = await loadActiveCommands(cfg)
  const count = new Set([...commands.values()]).size
  const boot = effectiveRoute(cfg)
  if (petEnabled(cfg)) {
    // The pet is the boot banner: versions and workers at a glance. `/pet` redraws it later.
    const vitals = await gatherVitals(cfg, { dsh: dshVersion, commands: count, session: convo.id() })
    console.log()
    await animatePet(vitals, { columns: process.stdout.columns, rows: process.stdout.rows, cfg })
    console.log()
  } else {
    step(`FiNess ready - persona ${paint(C.bold, activePersonaId(cfg))}, model ${paint(C.bold, boot.model ?? '-')} via ${boot.name} (tools: ${accessMode()})`)
  }
  const bootWs = activeWorkspace()
  if (bootWs.missing !== undefined) warn(`the saved workspace ${bootWs.missing} is gone - the agent works in this repo`)
  if (!bootWs.isRepo) console.log(paint(C.yellow, `  workspace ${bootWs.dir} - tasks run there, not in FiNess (/workspace reset goes back)`))
  console.log(paint(C.dim, `  ${count} quick-tools (tab completes, /help <name> explains):`))
  for (const l of commandBar(commands)) console.log(l)
  info(convo.id() === undefined
    ? 'a new conversation starts with your first task; it is kept for every later turn'
    : `continuing ${shortSession(convo.id())} - /new starts a fresh one`)
  info('type / to see commands as you type - arrows choose, tab or right accepts, enter runs')
  if (noModel) warn('model-less start (--no-model): quick-tools only; restart without the flag to run tasks')
  info('anything without a leading slash is a task for the model; /exit, an empty line or ctrl+c exits')
  info('/btw <note> adds a side note to your next task; #<note> adds a line to the project brief (## escapes)')
  info('!<cmd> runs a shell command here (no tokens; !! attaches its output); @file or @https://... in a task attaches it')
  info('prefer a chat window with a message bar? /web opens the browser UI (ctrl+c there ends this prompt too)')
  // A TTY gets the inline editor (ghost completion + live dropdown); a pipe gets plain readline,
  // because an editor that redraws itself is meaningless without a terminal.
  const interactive = process.stdin.isTTY === true
  // Input history persists across runs (read once here, appended per line): Up/Down reach earlier
  // sessions and plain text suggests recent tasks that start with it (T-303).
  const histFile = join(REPO, '.finess', 'history.jsonl')
  const history = loadHistory(histFile)
  const suggest = makeSuggester(commands, makeArgsSupplier(cfg), () => history)
  const rl = interactive
    ? undefined
    : createInterface({ input: process.stdin, output: process.stdout, completer: makeCompleter(cfg, commands) })
  // A pipe delivers lines whether or not a question is pending, and `rl.question` drops the ones
  // that arrive while a command runs (and never settles at EOF). One iterator buffers them all (T-439).
  const pipeLines = rl?.[Symbol.asyncIterator]()
  // Brief lines added (`#<note>`) since the last task, for a session that already has the rest.
  const briefAdded = []
  // `!!<cmd>` output waiting to ride on the next task (T-181).
  const shellAttached = []
  for (;;) {
    // The prompt carries the live state, so persona, model and conversation are never a guess.
    const id = convo.id()
    const live = effectiveRoute(loadConfig())
    const ws = activeWorkspace()
    const status = [activePersonaId(loadConfig()), `${live.model ?? '-'} @ ${live.name}`, ...(ws.isRepo ? [] : [`in ${workspaceLabel(ws)}`]), id === undefined ? 'new' : shortSession(id)].join(' · ')
    const answer = interactive
      ? await readLineWithSuggestions({ prompt: paint(C.cyan, 'finess> '), status: `  ${status}`, suggest, history })
      : await (async () => {
        process.stdout.write(`\n${paint(C.dim, status)}\n${paint(C.cyan, 'finess> ')}`)
        const next = await pipeLines.next()
        return next.done ? null : next.value
      })()
    if (answer === null) break
    const line = answer.trim()
    if (line === '') break
    history.push(line)
    appendHistory(histFile, line)
    // A leading slash is the only command marker in the REPL, so no phrasing of a real request can
    // be swallowed by the registry; `//` escapes it, sending the rest (one slash kept) to the model.
    const parsed = classifyLine(line)
    /** @type {string} */
    let taskText
    /** @type {string[]} */
    let overlayArgs = []
    // `#<note>` appends to the durable project brief; `##` escapes it, as `//` does for a slash.
    if (parsed.kind === 'brief') {
      const max = Number(loadConfig().notes?.briefMaxChars ?? 4000)
      if (parsed.text === '') {
        const brief = readBrief(REPO)
        console.log(paint(C.cyan, `project brief (${brief.length}/${max} characters, .finess/brief.md)`))
        if (brief === '') info('empty - add a line with #<note>; ## sends a line starting with # as a task')
        for (const l of brief.split('\n').filter(Boolean)) info(l)
        continue
      }
      const r = appendBrief(REPO, parsed.text, max)
      if (r.refused) warn(r.reason === 'cap' ? `the brief is capped at ${max} characters (${r.total} used) - edit .finess/brief.md` : 'empty note')
      else {
        briefAdded.push(r.line)
        ok(`brief updated (${r.total}/${max} characters) - sent with your next task and the first task of every new session`)
        if (r.warn) warn(`the brief is at ${Math.round((100 * r.total) / max)}% of its cap`)
        info('meant as a task? ## sends a line that starts with #')
      }
      continue
    }
    // `!<cmd>` runs locally and costs no tokens; `!!<cmd>` also attaches the output to the next task.
    if (parsed.kind === 'shell') {
      if (parsed.text === '') { info('!<command> runs it here (cmd.exe on Windows, /bin/sh elsewhere); !!<command> also attaches its output to your next task'); continue }
      const mode = accessMode()
      if ((ACCESS_MODES[mode] ?? mode) === 'read-only') {
        warn('access is read-only - ! commands are refused (change it: /access workspace)')
        continue
      }
      const res = runShell(parsed.text, { cwd: activeWorkspace().dir, spawnSync })
      if (res.out !== '') console.log(res.out)
      if (res.error !== undefined) warn(`could not run the shell: ${res.error}`)
      else if (res.timedOut) warn('stopped after 120 s')
      else if (res.code !== 0) info(`exit ${res.code}`)
      if (parsed.attach) {
        // Pending `!!` output shares the attachment total with the next task's `@` references.
        const left = CAPS.total - attachedChars(shellAttached)
        if (left <= 0) warn(`not attached - pending !! output already uses the ${CAPS.total}-character total`)
        else {
          const a = shellAttachment(parsed.text, res, Math.min(CAPS.perItem, left))
          shellAttached.push(a)
          ok(`output attached to your next task (${a.body.length} characters${a.truncated ? ', truncated' : ''})`)
        }
      }
      continue
    }
    if (parsed.kind === 'command') {
      // Re-read the config: an earlier command may have switched persona or model.
      const cfgNow = loadConfig()
      // `/exit` asks through `ctx.quit`; the loop then ends the same way an empty line does.
      let quit = false
      // `/recipe` hands its filled task back through `queueTask`; it then runs as this turn's task.
      let queued
      const { handled, name } = await runCommand(line, { ...makeCtx(cfgNow, commands, convo), quit: () => { quit = true }, queueTask: t => { queued = t } })
      if (quit) break
      // `name` is the resolved one, so `/p` and a prefix like `/pers` reload too.
      if (handled && name === 'persona') {
        // A persona switch may add or drop commands; reload in place so `makeSuggester` and
        // `makeCompleter` (which both hold this same Map) see the new registry with no further
        // plumbing - reassigning `commands` here would leave their closures pointed at the old one.
        const fresh = await loadActiveCommands(cfgNow)
        commands.clear()
        for (const [k, v] of fresh) commands.set(k, v)
      }
      if (!handled) {
        const typed = line.split(/\s+/)[0].replace(/^\//, '').toLowerCase()
        const near = [...new Set([...commands.values()].map(c => c.name))]
          .filter(n => n.startsWith(typed.slice(0, 2)) || n.includes(typed))
          .slice(0, 4)
        warn(`no such command: /${typed}${near.length > 0 ? ` - did you mean ${near.map(n => `/${n}`).join(', ')}?` : ''}`)
        if (near.length === 0) info('press tab on an empty slash to list every command, or run /help')
      }
      if (queued === undefined) continue
      taskText = queued.text
      overlayArgs = queued.overlay === undefined ? [] : ['--patch', queued.overlay]
    } else taskText = parsed.text
    if (noModel) {
      warn('no model in this session (--no-model) - the task was not sent')
      info('restart without --no-model to run tasks; quick-tools (/help) still work here')
      continue
    }
    await shadowRoute(cfg, taskText)
    // A command may have switched route, model or access since the last turn (/api, /models, /access),
    // so the route is re-resolved every turn rather than frozen at boot.
    const turn = await prepareRoute(loadConfig(), ready, { fallback: true })
    if (turn === undefined) continue
    env = turn.env
    if (turn.overlay !== undefined) overlayArgs = [...overlayArgs, '--patch', turn.overlay]
    // Every turn after the first adopts the session the first one created, so the model keeps its
    // own history instead of meeting each question cold.
    const prior = convo.id()
    const before = prior === undefined ? convo.snapshot() : undefined
    // `/btw` notes ride once, on this task, as a delimited context block (scripts/lib/notes.mjs).
    // Notes filed before a session existed (or before a /resume) join the current one first.
    const noteKey = prior ?? NEW_KEY
    if (prior !== undefined) moveNotes(RUN_DIR_LOCAL, NEW_KEY, prior)
    // The brief opens every new session in full; a continuing one gets only the lines added since.
    const brief = prior === undefined ? readBrief(REPO) : briefAdded.join('\n')
    // `@path` and `@https://...` attach a file, a directory listing or a page as text (T-181, T-447).
    const refs = await expandRefs(taskText, { cwd: activeWorkspace().dir, fs: nodeFs, fetch: globalThis.fetch, caps: { total: CAPS.total - attachedChars(shellAttached) } })
    for (const n of refs.notes) info(n)
    for (const w of refs.warnings) warn(w)
    for (const m of refs.missing) info(`${m} is not a file here - left as text`)
    const attachments = [...shellAttached, ...refs.attachments]
    const outgoing = composeTask(taskText, { brief, notes: pendingNotes(readNotes(RUN_DIR_LOCAL, noteKey)), attachments })
    if (outgoing.length > MAX_TASK_CHARS) {
      warn(`the task with its context is ${outgoing.length} characters, over the ${MAX_TASK_CHARS} a command line carries - not sent`)
      // Never leave the next task stuck behind the same pending output.
      if (shellAttached.length > 0) { shellAttached.length = 0; info('the pending !! output was dropped') }
      info('attach less (fewer @ files, a shorter !! output) or trim the brief')
      continue
    }
    const t0 = Date.now()
    const run = dsh([...args, ...overlayArgs, ...(prior === undefined ? [] : ['--session-id', prior]), outgoing], { env, cwd: activeWorkspace().dir })
    notifyDone({ what: taskText, ok: run.code === 0, elapsedMs: Date.now() - t0 }, loadConfig())
    // A failed run may never have reached the model, so its notes stay pending for the next task.
    if (run.code === 0) { markSent(RUN_DIR_LOCAL, noteKey); briefAdded.length = 0; shellAttached.length = 0 }
    if (before !== undefined) {
      convo.capture(before)
      if (convo.id() !== undefined) {
        moveNotes(RUN_DIR_LOCAL, NEW_KEY, convo.id())
        info(`session ${shortSession(convo.id())} - following turns continue it`)
      }
    }
  }
  rl?.close()
}

/**
 * Turn everything off: the web UI server, the decision sidecar and the model engine.
 * The web UI runs in the foreground of whichever terminal launched it, so it is found by its port.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @param {{force?: boolean}} [opts] - `force` also stops servers FiNess did not start.
 * @returns {Promise<boolean>} whether every part shut down cleanly.
 */
async function cmdOff(cfg, opts = {}) {
  step('stopping the web UI')
  if (WIN) {
    const r = sh('powershell', ['-NoProfile', '-Command', 'Get-NetTCPConnection -LocalPort 6173 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }'], { capture: true, allowFail: true })
    ok(r.code === 0 ? 'web UI stopped (if it was running)' : 'no web UI running')
  } else {
    // By port for the default server, and by profile for one started with `web --port <n>`.
    const byPort = sh('lsof', ['-ti', 'tcp:6173', '-sTCP:LISTEN'], { capture: true, allowFail: true }).out
    const byName = sh('pgrep', ['-f', `profile ${webProfileName(cfg)}( |$)`], { capture: true, allowFail: true }).out
    const pids = [...new Set(`${byPort} ${byName}`.split(/\s+/).filter(x => /^\d+$/.test(x)))]
    if (pids.length === 0) ok('no web UI running')
    else {
      for (const pid of pids) { try { process.kill(Number(pid), 'SIGTERM') } catch { warn(`pid ${pid} was already gone`) } }
      ok(`web UI stopped (pid ${pids.join(', ')})`)
    }
  }
  step('stopping the decision sidecar')
  const d = await decisionDown(cfg, opts)
  step('stopping the local model')
  const m = await modelDown(cfg, opts)
  return d && m
}

/** Rebuild the local knowledge graph (AST only, no LLM calls). */
function cmdGraph() {
  if (version('engram') === undefined) die('engram is not installed', 'run: npm i -g @sentropic/engram')
  sh('engram', ['update', '.'])
}

const HELP = `FiNess launcher

  ./turn_on.sh [command]      macOS/Linux        .\\turn_on.ps1 [command]   Windows

commands
  (none)        boot the harness; headless profiles prompt for tasks in a loop
  --no-model    open the prompt without booting a model (alias --no-start): settings,
                  /persona, /config, /help and other quick-tools; tasks print a hint
  "<task>"      run one task and exit
  --workspace <dir>   (before anything else) the agent works in <dir> instead of this repo;
                  kept for later runs, like /workspace <dir>; --workspace reset goes back
  web           open the browser UI: a chat window with a message bar instead of the
                  terminal prompt (same model, persona and plugins; alias: ui)
                  pass-through flags: --port <n>  --no-open  --host <host>
  setup         install/repair pnpm, dsh, the profile, its deps and the local model
  up            start the local model: engine, weights (Hugging Face GGUF), warm-up
  stats         model telemetry: what is loaded, memory held, tok/s, who owns the server
                  (--watch [--interval <s>] repeats it; probes are logged to .finess/probes.jsonl)
  off           turn everything off: web UI, decision sidecar and local model
                  (add --force to also stop servers FiNess did not start)
  down          unload the model, free its memory and stop the engine we started
                  (add --force to stop a server FiNess did not start)
  models        install/list/search local models:  models add <hugging face url | org/repo[:quant]>
  api           use a hosted model:  api use <provider> <model>   (keys go in .env)   api local
  access        how far shell/file tools reach:  access read-only | workspace | full --yes
  doctor        show what is installed and what is missing
  sync          regenerate profiles/<name>/cordis.patch.yml from finess.config.json
  graph         rebuild the Engram knowledge graph (no LLM calls)
  help          this text
  --list-commands   every quick-tool as JSON (name, summary, usage, aliases, web); used by the
                    web UI's commands bridge (packages/commands)

everything is configured in finess.config.json (personas, tips, model, plugins)`

/**
 * Run one command line as the CLI. `scripts/cli.mjs` (the `finess` bin) calls this after its
 * Node-version check.
 * @param {string[]} argv - the words after the script name.
 */
export async function main(argv) {
  const { argv: words, workspace } = takeWorkspaceFlag(argv)
  if (workspace !== undefined) applyWorkspaceFlag(workspace)
  const [first, ...rest] = words
  await dispatch(first, rest, loadConfig())
}

/**
 * `--workspace <dir>`: the same as typing `/workspace <dir>` first, so it persists. Exits on a bad dir.
 * @param {string} input - the directory as given, or `reset`.
 */
function applyWorkspaceFlag(input) {
  const r = input === 'reset' ? { dir: undefined } : resolveWorkspace(input)
  if ('error' in r) die(`--workspace: ${r.error}`, 'give an existing directory, or --workspace reset')
  const { changed, ws } = switchWorkspace(r.dir)
  if (changed) info(ws.isRepo ? 'workspace: back to this repo (new conversation)' : `workspace: ${ws.dir} (new conversation)`)
}

/** @returns {boolean} whether this file is the process entry, even when reached through a symlink. */
function invokedDirectly() {
  if (process.argv[1] === undefined) return false
  const entry = resolve(process.argv[1])
  const self = fileURLToPath(import.meta.url)
  if (entry === self) return true
  try { return realpathSync(entry) === realpathSync(self) } catch { return false }
}

// Only act as a CLI when invoked directly: `scripts/model.mjs` imports this module for its config.
if (invokedDirectly()) await main(process.argv.slice(2))

/**
 * Route one command line.
 * @param {string|undefined} first - the command word, if any.
 * @param {string[]} rest - the remaining words.
 * @param {typeof DEFAULTS} cfg - configuration.
 */
async function dispatch(first, rest, cfg) {
  // A flag, never a command word, so it cannot collide with a quick-tool.
  if (first === '--list-commands') { await printCommandList(cfg); return }
  // A bare word that names a quick-tool runs it; a quoted sentence never does, so
  // `turn_on.cmd "help me fix this"` stays a task while `turn_on.cmd help` is the command.
  const commands = await loadActiveCommands(cfg)
  if (first !== undefined && (first.startsWith('/') || (!first.includes(' ') && commands.has(first.toLowerCase())))) {
    const convo = conversation()
    const { handled, code } = await runCommand([first, ...rest].join(' '), makeCtx(cfg, commands, convo))
    if (handled) { process.exitCode = code; return }
    // A slash word is always meant as a command (the web bridge sends `/name`): an unknown one is
    // an error, never a model task started by accident.
    if (first.startsWith('/') && !first.includes(' ')) {
      warn(`no such command: ${first}`)
      info('list them with: help (or /help in the REPL)')
      process.exitCode = 1
      return
    }
  }
switch (first) {
  case 'up': process.exitCode = (await modelUp(cfg)) ? 0 : 1; break
  case 'stats': process.exitCode = (await modelStats(cfg, statsOpts(rest))) ? 0 : 1; break
  case 'down': process.exitCode = (await modelDown(cfg, { force: rest.includes('--force') })) ? 0 : 1; break
  case 'setup': await cmdSetup(cfg); break
  case 'doctor': await cmdDoctor(cfg); break
  case 'off': case 'stop': process.exitCode = (await cmdOff(cfg, { force: rest.includes('--force') })) ? 0 : 1; break
  case 'sync': syncPatch(cfg); break
  case 'graph': cmdGraph(); break
  case 'help': case '--help': case '-h': console.log(HELP); break
  case 'run': await cmdRun(cfg, rest); break
  case '--no-model': case '--no-start': await cmdRun(cfg, rest, { noModel: true }); break
  case undefined: await cmdRun(cfg, []); break
  default: await cmdRun(cfg, [first, ...rest])
}
}
