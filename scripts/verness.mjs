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
import { modelDown, modelStats, modelUp } from './model.mjs'
import { activePersonaId, loadPersonas, personaPrompt, readState, writeState } from './lib/personas.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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
}

const C = {
  dim: '[2m', red: '[31m', green: '[32m',
  yellow: '[33m', cyan: '[36m', off: '[0m',
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
 * Build the context every quick-tool receives. Commands run in this process: no model call and no
 * tokens, which is the whole reason they live outside the agent loop.
 * @param {typeof DEFAULTS} cfg - configuration.
 * @param {Map<string, object>} commands - the loaded registry.
 * @returns {object} the command context.
 */
function makeCtx(cfg, commands) {
  const { env } = resolveRoute(cfg)
  return {
    cfg,
    commands,
    sh,
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
  const dir = profileDir(cfg.profile.name)
  if (!existsSync(dir)) die(`profile "${cfg.profile.name}" does not exist yet`, 'run: ./turn_on.sh setup')
  writeFileSync(join(dir, 'cordis.patch.yml'), readFileSync(src, 'utf8'), 'utf8')
  ok(`patch synced -> ${join(dir, 'cordis.patch.yml')}`)
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
    if (sh('dsh', ['--profile', name, '--from-default-profile', cfg.profile.template, '--dump-config'], { capture: true }).code !== 0) {
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
  await modelUp(cfg)
  step('setup complete')
  info(WIN ? 'next: .\\turn_on.ps1' : 'next: ./turn_on.sh')
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
    ['submodule', 'upstream/deepseek-harness', existsSync(join(REPO, 'upstream/deepseek-harness/package.json')) ? 'ok' : 'run setup'],
    ['persona', cfg.personas.active, `${(cfg.tips ?? []).length} tip(s)`],
    ['model', cfg.model.id, cfg.activeRoute === '' ? cfg.model.route : cfg.activeRoute],
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
  if (version('dsh', '--version') === undefined) die('dsh is not installed', 'run: ./turn_on.sh setup')
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
  if (task.length > 0) { sh('dsh', [...args, task.join(' ')], { env }); return }
  if (cfg.profile.template !== 'headless') { step(`booting the ${cfg.profile.template} surface`); sh('dsh', args, { env }); return }

  const commands = await loadCommands()
  step(`ready - persona "${activePersonaId(cfg)}", model ${r.id} via ${route}`)
  info(`type a task, or /help for ${new Set([...commands.values()]).size} quick-tools; empty line or ctrl+c exits`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  for (;;) {
    const line = (await rl.question(paint(C.cyan, '\nverness> '))).trim()
    if (line === '') break
    // A leading slash is the only command marker in the REPL, so no phrasing of a real request can
    // be swallowed by the registry.
    if (line.startsWith('/')) {
      // Re-read the config: an earlier command may have switched persona or model.
      const { handled } = await runCommand(line, makeCtx(loadConfig(), commands))
      if (!handled) warn(`no such command: ${line.split(/\s+/)[0]} - try /help`)
      continue
    }
    sh('dsh', [...args, line], { env })
  }
  rl.close()
}

/** Rebuild the local knowledge graph (AST only, no LLM calls). */
function cmdGraph() {
  if (version('engram') === undefined) die('engram is not installed', 'run: npm i -g @sentropic/engram')
  sh('engram', ['update', '.'])
}

const HELP = `VerNess launcher

  ./turn_on.sh [command]      macOS/Linux        .\\turn_on.ps1 [command]   Windows

commands
  (none)        boot the harness; headless profiles prompt for tasks in a loop
  "<task>"      run one task and exit
  setup         install/repair pnpm, dsh, the profile, its deps and the local model
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
    const { handled, code } = await runCommand([first, ...rest].join(' '), makeCtx(cfg, commands))
    if (handled) { process.exitCode = code; return }
  }
switch (first) {
  case 'up': process.exitCode = (await modelUp(cfg)) ? 0 : 1; break
  case 'stats': process.exitCode = (await modelStats(cfg)) ? 0 : 1; break
  case 'down': process.exitCode = (await modelDown(cfg, { force: rest.includes('--force') })) ? 0 : 1; break
  case 'setup': await cmdSetup(cfg); break
  case 'doctor': await cmdDoctor(cfg); break
  case 'sync': syncPatch(cfg); break
  case 'graph': cmdGraph(); break
  case 'help': case '--help': case '-h': console.log(HELP); break
  case 'run': await cmdRun(cfg, rest); break
  case undefined: await cmdRun(cfg, []); break
  default: await cmdRun(cfg, [first, ...rest])
}
}
