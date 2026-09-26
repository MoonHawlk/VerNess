#!/usr/bin/env node
/**
 * VerNess launcher — one cross-platform entry point for installing, configuring and booting the
 * harness. Everything it does is derived from `verness.config.json`; nothing here is machine- or
 * OS-specific beyond path resolution and process spawning.
 *
 * Commands: setup | start (default) | run <task...> | sync | doctor | graph | help
 * @module scripts/verness
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadCommands, runCommand } from './lib/commands.mjs'
import { makeSuggester, readLineWithSuggestions } from './lib/prompt.mjs'
import { modelDown, modelStats, modelUp } from './model.mjs'
import { activePersonaId, loadPersonas, personaPrompt, readState, writeState } from './lib/personas.mjs'
import { listSessions } from './lib/sessions.mjs'
import { gatherVitals, petEnabled, renderPet } from './lib/pet.mjs'
import { loadTeams } from './lib/teams.mjs'
import { ROUTING_QUESTIONS, askDecision, decisionConfig, decisionHealth, logShadowDecision, readAnswer, ruleRoute } from './lib/decisions.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUN_DIR_LOCAL = join(REPO, '.verness', 'run')
const WIN = process.platform === 'win32'
const NODE_MIN = [22, 19, 0]

/** Defaults for every configurable field; the config file overrides these shallowly per section. */
const DEFAULTS = {
  substrate: { version: '0.1.7-rc.2', pnpmVersion: '11.7.0' },
  profile: { name: 'verness', template: 'headless' },
  model: {
    route: 'ollama-local', displayName: 'Ollama (local)', id: 'qwen3:0.6b',
    baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'OLLAMA_API_KEY',
    apiKeyValue: 'ollama-local-no-auth', contextWindow: 32768, maxTokens: 4096,
    engine: 'ollama', source: undefined, keepAliveMinutes: 10, autoInstallEngine: true,
    reasoning: false, autoServe: true, autoPull: true,
  },
  extraRoutes: {}, activeRoute: '',
  personas: { active: 'generalist', definitions: { generalist: { prefix: '', suffix: '' } } },
  tips: [],
  settings: { toolsMode: 'native', plugins: [], linkedSubstratePackages: ['@deepseek-ai/dsh-tools'] },
  pet: { enabled: true, name: 'Ness' },
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
  const file = join(REPO, 'verness.config.json')
  if (!existsSync(file)) { warn('verness.config.json not found - using built-in defaults'); return structuredClone(DEFAULTS) }
  let raw
  try { raw = parseJsonc(readFileSync(file, 'utf8')) } catch (e) { die(`verness.config.json is not valid JSON: ${e.message}`) }
  const cfg = structuredClone(DEFAULTS)
  for (const [k, v] of Object.entries(raw)) {
    cfg[k] = v !== null && typeof v === 'object' && !Array.isArray(v) ? { ...cfg[k], ...v } : v
  }
  return cfg
}

/** @returns {typeof DEFAULTS} the merged configuration, for the `scripts/model.mjs` entry point. */
export const loadConfigForCli = () => loadConfig()

/**
 * Build a command context for a standalone script entry point (loop-task, dashboard and friends),
 * so those tools get the same `dsh` runner, route environment and conversation the REPL uses.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @returns {Promise<object>} the context.
 */
export async function makeCliContext(cfg) {
  const commands = await loadCommands()
  const convo = conversation(REPO.replace(/[\/:]+/g, '-').replace(/^-+|-+$/g, ''))
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
 * @param {{env?: Record<string,string>, capture?: boolean}} [opts] - options.
 * @returns {{code: number, out: string}} exit status and captured output.
 */
function dsh(args, opts = {}) {
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
  // Fall back to the shim only if the entry point could not be resolved; the caveats above apply.
  if (dshEntry === null) return sh('dsh', args, opts)
  const r = spawnSync(process.execPath, [dshEntry, ...args], {
    cwd: REPO,
    env: { ...process.env, ...opts.env },
    stdio: opts.capture === true ? 'pipe' : 'inherit',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
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

/** @returns {boolean} whether the running Node satisfies the substrate engine range. */
function nodeOk() {
  const [maj, min, pat] = process.versions.node.split('.').map(Number)
  if (maj > NODE_MIN[0]) return true
  return maj === NODE_MIN[0] && (min > NODE_MIN[1] || (min === NODE_MIN[1] && pat >= NODE_MIN[2]))
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
 * @returns {{prefix: string, suffix: string, name: string}} the resolved persona text.
 */
function resolvePersona(cfg) {
  const id = activePersonaId(cfg)
  const persona = loadPersonas(cfg).get(id)
  if (persona === undefined) {
    die(`active persona "${id}" has no definition`, 'add personas/<id>.json, or run: ./turn_on.sh persona list')
  }
  const { prefix, suffix } = personaPrompt(persona, cfg.tips ?? [])
  return { name: id, prefix, suffix, persona }
}

/**
 * Render `profiles/<name>/cordis.patch.yml` from the configuration. The file stays committed so a
 * reviewer sees exactly what the runtime composes, but it is generated - edit the config instead.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @returns {string} the path written.
 */
function writePatch(cfg) {
  const persona = resolvePersona(cfg)
  const routes = { [cfg.model.route]: { ...cfg.model, api: 'openai-completions' }, ...cfg.extraRoutes }
  const active = cfg.activeRoute === '' ? cfg.model.route : cfg.activeRoute
  if (routes[active] === undefined) die(`activeRoute = "${active}" is not declared in model.route or extraRoutes`)
  const L = []
  L.push('# GENERATED by scripts/verness.mjs from verness.config.json - do not edit by hand.')
  L.push('# Regenerate with `./turn_on.sh sync` (or .\\turn_on.ps1 sync). It stays committed so')
  L.push('# reviewers see the composed tree, but verness.config.json is the source of truth.')
  L.push('')
  L.push('- insert:')
  for (const p of cfg.settings.plugins ?? []) {
    L.push(`    - id: ${p.id}`)
    L.push(`      name: ${yq(p.package)}`)
    if (p.enabled === false) L.push('      disabled: true')
  }
  L.push('    # Model routes. No adapter of ours is needed: dsh-llm-pi-ai serves hand-declared')
  L.push('    # OpenAI-compatible gateways given api + baseURL + a non-empty models list.')
  L.push('    - id: llm-pi-ai')
  L.push("      name: '@deepseek-ai/dsh-llm-pi-ai'")
  L.push('      config:')
  L.push('        providers:')
  for (const [name, r] of Object.entries(routes)) {
    L.push(`          ${name}:`)
    L.push(`            displayName: ${yq(r.displayName ?? name)}`)
    if (r.apiKeyEnv !== undefined) L.push(`            apiKeyEnv: ${r.apiKeyEnv}`)
    L.push(`            api: ${r.api ?? 'openai-completions'}`)
    L.push(`            baseURL: ${yq(r.baseURL)}`)
    L.push(`            defaultContextWindow: ${r.contextWindow ?? 32768}`)
    L.push(`            defaultMaxTokens: ${r.maxTokens ?? 4096}`)
    L.push('            models:')
    L.push(`              - id: ${yq(r.id)}`)
    L.push(`                name: ${yq(r.displayName ?? r.id)}`)
    L.push(`                contextWindow: ${r.contextWindow ?? 32768}`)
    if (r.reasoning === false) L.push('                reasoningEfforts: false')
  }
  L.push('')
  // Precedence for the model actually used: an explicit /model override, then the active persona's
  // preference, then the route default. The override lives in .verness/state.json so switching never
  // rewrites the commented config file.
  const override = readState().model
  const modelId = override ?? persona.persona?.model?.id ?? routes[active].id
  const modelRoute = persona.persona?.model?.route ?? active
  L.push('# A patch replaces the targeted row config wholesale, so every field is restated.')
  L.push('- id: agent-default-model')
  L.push('  config:')
  L.push(`    provider: ${modelRoute}`)
  L.push(`    model: ${yq(modelId)}`)
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
  const dir = join(REPO, 'profiles', cfg.profile.name)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'cordis.patch.yml')
  writeFileSync(file, L.join('\n'), 'utf8')
  return file
}

/**
 * The route the next run will use, and the environment it needs.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @returns {{route: string, r: object, env: Record<string,string>}} the resolved route.
 */
function resolveRoute(cfg) {
  const route = cfg.activeRoute === '' ? cfg.model.route : cfg.activeRoute
  const r = cfg.extraRoutes[route] ?? cfg.model
  const env = {}
  if (r.apiKeyEnv !== undefined && process.env[r.apiKeyEnv] === undefined && r.apiKeyValue !== undefined) {
    env[r.apiKeyEnv] = r.apiKeyValue
  }
  return { route, r, env }
}

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
  if (!r.ok) { info(paint(C.dim, `shadow: decision service unavailable (${r.error ?? r.status})`)); return }
  const model = {}
  for (const k of Object.keys(ROUTING_QUESTIONS)) {
    const a = readAnswer(r.body, k)
    model[k] = { answer: a.answer, confidence: a.confidence }
  }
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
      team: ['list', 'show', 'run', ...teams],
      teams: ['list', 'show', 'run', ...teams],
      resume: sessions,
      model: ['reset', ...models],
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
 * @param {string} workspaceKey - the workspace filter for session discovery.
 * @returns {{id: () => string|undefined, adopt: (id: string) => void, reset: () => void, capture: (before: Set<string>) => void, snapshot: () => Set<string>}} the handle.
 */
function conversation(workspaceKey) {
  let id = readState().session
  return {
    id: () => id,
    adopt: next => { id = next; writeState({ session: next }) },
    reset: () => { id = undefined; writeState({ session: undefined }) },
    snapshot: () => new Set(listSessions({ workspace: workspaceKey, limit: 60 }).map(x => x.identity)),
    capture: before => {
      const fresh = listSessions({ workspace: workspaceKey, limit: 60 }).find(x => !before.has(x.identity))
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
    // The team runner sends multi-line prompts, so it gets the shell-free runner.
    dsh,
    sync: () => syncPatch(cfg),
    routeEnv: env,
    activePersonaId: activePersonaId(cfg),
    // Sessions live under a directory named after the workspace path.
    workspaceKey: REPO.replace(/[\\/:]+/g, '-').replace(/^-+|-+$/g, ''),
    builtins: {
      up: async () => ((await modelUp(cfg)) ? 0 : 1),
      down: async a => ((await modelDown(cfg, { force: a.includes('--force') })) ? 0 : 1),
      stats: async () => ((await modelStats(cfg)) ? 0 : 1),
      doctor: async () => { await cmdDoctor(cfg); return 0 },
      sync: () => { syncPatch(cfg); return 0 },
      graph: () => { cmdGraph(); return 0 },
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
function cmdModel(cfg, args) {
  const { route, r } = resolveRoute(cfg)
  if (args.length === 0) {
    const state = readState()
    step(`route ${route}`)
    info(`configured model  : ${r.id}`)
    info(`persona preference: ${loadPersonas(cfg).get(activePersonaId(cfg))?.model?.id ?? '(none)'}`)
    info(`/model override   : ${state.model ?? '(none)'}`)
    const list = sh('ollama', ['list'], { capture: true, allowFail: true })
    if (list.code === 0) {
      info('locally available:')
      for (const l of list.out.split('\n').slice(1, 9)) if (l.trim() !== '') info(`  ${l.split(/\s\s+/)[0]}`)
    }
    info('switch with /model <id>, clear with /model reset')
    return 0
  }
  if (args[0] === 'reset') { writeState({ model: undefined }); syncPatch(cfg); ok('model override cleared'); return 0 }
  writeState({ model: args[0] })
  syncPatch(cfg)
  ok(`model override set to ${args[0]} (route ${route})`)
  info('the engine pulls it on the next run if it is not already present')
  return 0
}

/**
 * Copy the generated patch into `$DSH_HOME`, where the runtime reads it.
 * @param {typeof DEFAULTS} cfg - configuration.
 */
function syncPatch(cfg) {
  const src = writePatch(cfg)
  const patchContent = readFileSync(src, 'utf8')
  const dir = profileDir(cfg.profile.name)
  if (!existsSync(dir)) die(`profile "${cfg.profile.name}" does not exist yet`, 'run: ./turn_on.sh setup')
  writeFileSync(join(dir, 'cordis.patch.yml'), patchContent, 'utf8')
  ok(`patch synced -> ${join(dir, 'cordis.patch.yml')}`)
  const webDir = profileDir(`${cfg.profile.name}-web`)
  if (existsSync(webDir)) {
    writeFileSync(join(webDir, 'cordis.patch.yml'), patchContent, 'utf8')
    ok(`patch synced -> ${join(webDir, 'cordis.patch.yml')}`)
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

  const name = cfg.profile.name
  const dir = profileDir(name)
  if (!existsSync(join(dir, 'package.json'))) {
    step(`creating profile "${name}" from the ${cfg.profile.template} template`)
    if (dsh(['--profile', name, '--from-default-profile', cfg.profile.template, '--dump-config'], { capture: true }).code !== 0) {
      die(`could not create profile "${name}"`)
    }
  }
  ok(`profile ${dir}`)

  step('installing profile dependencies')
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
    if (p.path === undefined) {
      sh('pnpm', ['add', p.package], { cwd: dir, capture: true, allowFail: true })
      if (profileDeps(dir)[p.package] === undefined) warn(`could not add ${p.package}`)
      else ok(`plugin ${p.package}`)
      continue
    }
    const abs = resolve(REPO, p.path)
    if (!existsSync(abs)) { warn(`plugin path missing: ${p.path}`); continue }
    sh('pnpm', ['add', `file:${abs}`], { cwd: dir, capture: true, allowFail: true })
    if (profileDeps(dir)[p.package] === undefined) warn(`could not add ${p.package} from ${p.path}`)
    else ok(`plugin ${p.package} <- ${p.path}`)
  }

  syncPatch(cfg)

  // Create the companion web profile so `./turn_on.sh web` opens the browser UI.
  const webName = `${name}-web`
  const webDir = profileDir(webName)
  if (!existsSync(join(webDir, 'package.json'))) {
    step(`creating web profile "${webName}"`)
    if (dsh(['--profile', webName, '--from-default-profile', 'web', '--dump-config'], { capture: true }).code !== 0) {
      warn(`could not create web profile "${webName}" — ./turn_on.sh web will not work until setup succeeds`)
    }
  }
  if (existsSync(join(webDir, 'package.json'))) {
    ok(`web profile ${webDir}`)
    sh('pnpm', ['add', `${piai}@${want}`], { cwd: webDir, capture: true, allowFail: true })
    for (const pkg of cfg.settings.linkedSubstratePackages ?? []) {
      if (root === undefined) { warn(`cannot resolve npm root -g; skipped linking ${pkg} in web profile`); break }
      const target = join(root, '@deepseek-ai', 'dsh', 'node_modules', ...pkg.split('/'))
      if (!existsSync(target)) continue
      if (profileDeps(webDir)[pkg]?.startsWith('link:') !== true) {
        sh('pnpm', ['remove', pkg], { cwd: webDir, capture: true, allowFail: true })
        sh('pnpm', ['add', `link:${target}`], { cwd: webDir, capture: true, allowFail: true })
      }
      if (profileDeps(webDir)[pkg]?.startsWith('link:') === true) ok(`linked ${pkg} -> runtime copy (web profile)`)
    }
    for (const p of cfg.settings.plugins ?? []) {
      if (p.path === undefined) {
        sh('pnpm', ['add', p.package], { cwd: webDir, capture: true, allowFail: true })
        if (profileDeps(webDir)[p.package] !== undefined) ok(`plugin ${p.package} (web profile)`)
      } else {
        const abs = resolve(REPO, p.path)
        if (existsSync(abs)) sh('pnpm', ['add', `file:${abs}`], { cwd: webDir, capture: true, allowFail: true })
      }
    }
  }

  await modelUp(cfg)
  step('setup complete')
  info(WIN ? 'next: .\\turn_on.ps1' : 'next: ./turn_on.sh')
  info(WIN ? 'web UI: .\\turn_on.ps1 web' : 'web UI: ./turn_on.sh web')
}

/**
 * @param {string} baseURL - the route base URL.
 * @returns {Promise<boolean>} whether an engine server answers there.
 */
async function engineAnswers(baseURL) {
  try {
    const r = await fetch(`${String(baseURL).replace(/\/v1\/?$/, '')}/api/version`, { signal: AbortSignal.timeout(2500) })
    return r.ok
  } catch { return false }
}

/** Print what is installed and what is missing. @param {typeof DEFAULTS} cfg - configuration. */
async function cmdDoctor(cfg) {
  const dshv = version('dsh', '--version')
  const rows = [
    ['node', process.versions.node, nodeOk() ? 'ok' : `needs ${NODE_MIN.join('.')}+`],
    ['pnpm', version('pnpm') ?? '-', version('pnpm') === undefined ? 'missing' : 'ok'],
    ['dsh', dshv ?? '-', dshv === cfg.substrate.version ? 'ok' : `want ${cfg.substrate.version}`],
    ['engine', version(cfg.model.engine ?? 'ollama') ?? '-', (await engineAnswers(cfg.model.baseURL)) ? 'serving' : 'not serving'],
    ['engram', version('engram') ?? '-', version('engram') === undefined ? 'optional' : 'ok'],
    ['profile', profileDir(cfg.profile.name), existsSync(profileDir(cfg.profile.name)) ? 'ok' : 'run setup'],
    ['web profile', profileDir(`${cfg.profile.name}-web`), existsSync(profileDir(`${cfg.profile.name}-web`)) ? 'ok' : 'run setup'],
    ['submodule', 'upstream/deepseek-harness', existsSync(join(REPO, 'upstream/deepseek-harness/package.json')) ? 'ok' : 'run setup'],
    ['persona', activePersonaId(cfg), `${(cfg.tips ?? []).length} tip(s)`],
    ['model', readState().model ?? cfg.model.id, cfg.activeRoute === '' ? cfg.model.route : cfg.activeRoute],
    ['decisions', decisionConfig(cfg).baseURL, (await decisionHealth(decisionConfig(cfg))) ? 'serving' : (decisionConfig(cfg).enabled === true ? 'not serving' : 'off (optional)')],
  ]
  const w = Math.max(...rows.map(r => r[0].length))
  for (const [k, v, s] of rows) {
    const bad = /missing|run setup|needs|want|not serving/.test(s)
    console.log(`  ${k.padEnd(w)}  ${v}  ${paint(bad ? C.yellow : C.dim, `(${s})`)}`)
  }
}

/**
 * Boot the harness. With a task it runs one-shot; without, it prompts (headless) or opens the app.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @param {string[]} task - the task words, if any.
 */
async function cmdRun(cfg, task) {
  const dshVersion = version('dsh', '--version')
  if (dshVersion === undefined) die('dsh is not installed', 'run: ./turn_on.sh setup')
  if (!existsSync(join(profileDir(cfg.profile.name), 'package.json'))) die(`profile "${cfg.profile.name}" is missing`, 'run: ./turn_on.sh setup')
  syncPatch(cfg)
  const route = cfg.activeRoute === '' ? cfg.model.route : cfg.activeRoute
  const r = cfg.extraRoutes[route] ?? cfg.model
  if (r.engine !== undefined && !(await modelUp(cfg))) die('the local model is not ready')
  const env = {}
  if (r.apiKeyEnv !== undefined && process.env[r.apiKeyEnv] === undefined) {
    if (r.apiKeyValue === undefined) die(`${r.apiKeyEnv} is not set and no apiKeyValue is configured for route "${route}"`)
    env[r.apiKeyEnv] = r.apiKeyValue
  }

  const args = ['--profile', cfg.profile.name]
  const convo = conversation(REPO.replace(/[\\/:]+/g, '-').replace(/^-+|-+$/g, ''))

  if (task.length > 0) {
    // `--continue` (or `-c`) carries the previous conversation into a one-shot run.
    const wants = task[0] === '--continue' || task[0] === '-c'
    const text = (wants ? task.slice(1) : task).join(' ')
    const prior = wants ? convo.id() : undefined
    if (wants && prior === undefined) warn('no previous session recorded; starting a new one')
    const before = prior === undefined ? convo.snapshot() : undefined
    dsh([...args, ...(prior === undefined ? [] : ['--session-id', prior]), text], { env })
    if (before !== undefined) convo.capture(before)
    return
  }
  if (cfg.profile.template !== 'headless') { step(`booting the ${cfg.profile.template} surface`); dsh(args, { env }); return }

  const commands = await loadCommands()
  const count = new Set([...commands.values()]).size
  if (petEnabled(cfg)) {
    // The pet is the boot banner: versions and workers at a glance. `/pet` redraws it later.
    const vitals = await gatherVitals(cfg, { dsh: dshVersion, commands: count, session: convo.id() })
    console.log()
    for (const l of renderPet(vitals, { columns: process.stdout.columns })) console.log(l)
    console.log()
  } else {
    step(`VerNess ready - persona ${paint(C.bold, activePersonaId(cfg))}, model ${paint(C.bold, r.id)} via ${route}`)
  }
  console.log(paint(C.dim, `  ${count} quick-tools (tab completes, /help <name> explains):`))
  for (const l of commandBar(commands)) console.log(l)
  info(convo.id() === undefined
    ? 'a new conversation starts with your first task; it is kept for every later turn'
    : `continuing ${shortSession(convo.id())} - /new starts a fresh one`)
  info('type / to see commands as you type - arrows choose, tab or right accepts, enter runs')
  info('anything without a leading slash is a task for the model; empty line or ctrl+c exits')
  // A TTY gets the inline editor (ghost completion + live dropdown); a pipe gets plain readline,
  // because an editor that redraws itself is meaningless without a terminal.
  const interactive = process.stdin.isTTY === true
  const suggest = makeSuggester(commands, makeArgsSupplier(cfg))
  const rl = interactive
    ? undefined
    : createInterface({ input: process.stdin, output: process.stdout, completer: makeCompleter(cfg, commands) })
  const history = []
  for (;;) {
    // The prompt carries the live state, so persona, model and conversation are never a guess.
    const id = convo.id()
    const status = [activePersonaId(loadConfig()), readState().model ?? r.id, id === undefined ? 'new' : shortSession(id)].join(' · ')
    const answer = interactive
      ? await readLineWithSuggestions({ prompt: paint(C.cyan, 'verness> '), status: `  ${status}`, suggest, history })
      : await rl.question(`\n${paint(C.dim, status)}\n${paint(C.cyan, 'verness> ')}`)
    if (answer === null) break
    const line = answer.trim()
    if (line === '') break
    history.push(line)
    // A leading slash is the only command marker in the REPL, so no phrasing of a real request can
    // be swallowed by the registry.
    if (line.startsWith('/')) {
      // Re-read the config: an earlier command may have switched persona or model.
      const { handled } = await runCommand(line, makeCtx(loadConfig(), commands, convo))
      if (!handled) {
        const typed = line.split(/\s+/)[0].replace(/^\//, '').toLowerCase()
        const near = [...new Set([...commands.values()].map(c => c.name))]
          .filter(n => n.startsWith(typed.slice(0, 2)) || n.includes(typed))
          .slice(0, 4)
        warn(`no such command: /${typed}${near.length > 0 ? ` - did you mean ${near.map(n => `/${n}`).join(', ')}?` : ''}`)
        if (near.length === 0) info('press tab on an empty slash to list every command, or run /help')
      }
      continue
    }
    await shadowRoute(cfg, line)
    // Every turn after the first adopts the session the first one created, so the model keeps its
    // own history instead of meeting each question cold.
    const prior = convo.id()
    const before = prior === undefined ? convo.snapshot() : undefined
    dsh([...args, ...(prior === undefined ? [] : ['--session-id', prior]), line], { env })
    if (before !== undefined) {
      convo.capture(before)
      if (convo.id() !== undefined) info(`session ${shortSession(convo.id())} - following turns continue it`)
    }
  }
  rl?.close()
}

/**
 * Boot the web surface profile. The model engine is shared with the headless profile; the
 * cordis.patch.yml is kept in sync by `syncPatch` so model/persona config is always current.
 * @param {typeof DEFAULTS} cfg - configuration.
 */
async function cmdRunWeb(cfg) {
  const webName = `${cfg.profile.name}-web`
  const webDir = profileDir(webName)
  if (!existsSync(join(webDir, 'package.json'))) die(`profile "${webName}" does not exist`, 'run: ./turn_on.sh setup')
  syncPatch(cfg)
  const { route, r, env } = resolveRoute(cfg)
  if (r.engine !== undefined && !(await modelUp(cfg))) die('the local model is not ready')
  step('booting the web surface')
  info('open http://localhost:6173 in your browser once the server is ready')
  dsh(['--profile', webName], { env })
}

/** Rebuild the local knowledge graph (AST only, no LLM calls). */
function cmdGraph() {
  if (version('engram') === undefined) die('engram is not installed', 'run: npm i -g @sentropic/engram')
  sh('engram', ['update', '.'])
}

const HELP = `VerNess launcher

  ./turn_on.sh [command]      macOS/Linux        .\\turn_on.ps1 [command]   Windows

commands
  (none)        boot the harness; headless profile prompts for tasks in a loop (CLI)
  web           open the browser UI (dsh-web-ui); requires ./turn_on.sh setup first
  "<task>"      run one task and exit (one-shot, works in both CLI and web profiles)
  setup         install/repair pnpm, dsh, both profiles (CLI + web), deps and local model
  up            start the local model: engine, weights (Hugging Face GGUF), warm-up
  stats         model telemetry: what is loaded, memory held, tok/s, who owns the server
  down          unload the model, free its memory and stop the engine we started
                  (add --force to stop a server VerNess did not start)
  doctor        show what is installed and what is missing
  sync          regenerate profiles/<name>/cordis.patch.yml from verness.config.json
  graph         rebuild the Engram knowledge graph (no LLM calls)
  help          this text

everything is configured in verness.config.json (personas, tips, model, plugins)`

// Only act as a CLI when invoked directly: `scripts/model.mjs` imports this module for its config.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [, , first, ...rest] = process.argv
  const cfg = loadConfig()
  await dispatch(first, rest, cfg)
}

/**
 * Route one command line.
 * @param {string|undefined} first - the command word, if any.
 * @param {string[]} rest - the remaining words.
 * @param {typeof DEFAULTS} cfg - configuration.
 */
async function dispatch(first, rest, cfg) {
  // A bare word that names a quick-tool runs it; a quoted sentence never does, so
  // `turn_on.cmd "help me fix this"` stays a task while `turn_on.cmd help` is the command.
  const commands = await loadCommands()
  if (first !== undefined && (first.startsWith('/') || (!first.includes(' ') && commands.has(first.toLowerCase())))) {
    const convo = conversation(REPO.replace(/[\\/:]+/g, '-').replace(/^-+|-+$/g, ''))
    const { handled, code } = await runCommand([first, ...rest].join(' '), makeCtx(cfg, commands, convo))
    if (handled) { process.exitCode = code; return }
  }
switch (first) {
  case 'up': process.exitCode = (await modelUp(cfg)) ? 0 : 1; break
  case 'stats': process.exitCode = (await modelStats(cfg)) ? 0 : 1; break
  case 'down': process.exitCode = (await modelDown(cfg, { force: rest.includes('--force') })) ? 0 : 1; break
  case 'setup': await cmdSetup(cfg); break
  case 'doctor': await cmdDoctor(cfg); break
  case 'sync': syncPatch(cfg); break
  case 'web': await cmdRunWeb(cfg); break
  case 'graph': cmdGraph(); break
  case 'help': case '--help': case '-h': console.log(HELP); break
  case 'run': await cmdRun(cfg, rest); break
  case undefined: await cmdRun(cfg, []); break
  default: await cmdRun(cfg, [first, ...rest])
}
}
