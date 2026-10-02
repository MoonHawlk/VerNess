/**
 * Quick-tool registry. Every file in `scripts/commands/*.mjs` that default-exports
 * `{ name, summary, usage?, args?, group?, run(ctx, args) }` becomes a command, reachable as
 * `/name` inside the REPL and as `name` on the command line. Adding a command is adding one file —
 * no registration list to keep in sync.
 *
 * Commands run IN the launcher process: they cost no tokens and no model call. That is the point —
 * `/cost`, `/usage`, `/agents`, `/persona` are launcher concerns, not things to ask a model about.
 * @module scripts/lib/commands
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { REPO, warn } from './util.mjs'

/** @returns {string} the command directory. */
export const commandsDir = () => join(REPO, 'scripts', 'commands')

/**
 * A persona `id` or command `name` used to build a path must be a plain, single path segment —
 * file-based personas (`personas/<id>.json`) are schema-validated, but inline config personas
 * (`verness.config.json`) are not (Ruling R4), so a value like `../evil` must be rejected here
 * before it is ever joined into a path.
 */
const SAFE_NAME = /^[a-z][a-z0-9-]*$/

/**
 * Load one command file and register its default export plus any named export shaped like a
 * command — so a set of closely related one-liners can live in one file instead of one file each.
 * @param {Map<string, object>} out - the registry to fill.
 * @param {string} dir - the directory the file lives in.
 * @param {string} f - the file name (must end in `.mjs`).
 * @param {(cmd: object) => boolean} [accept] - called before a name is registered; returning
 *   `false` refuses the command (with a warning) instead of adding it. Defaults to accepting
 *   everything, which is how the global directory has always behaved.
 * @param {Map<string, string>} [owner] - filled with `name -> ownerLabel` for every command
 *   registered here, so a later collision warning can name the actual owner.
 * @param {string} [ownerLabel] - the label to record in `owner` for commands from this file.
 * @returns {Promise<void>}
 */
async function loadCommandFile(out, dir, f, accept = () => true, owner, ownerLabel) {
  let mod
  try { mod = await import(pathToFileURL(join(dir, f)).href) } catch (e) { warn(`command ${f} failed to load: ${e.message}`); return }
  // A module namespace's `Object.values` already includes its `default` key, so spreading both
  // would process a default-only export twice (and, for a persona command, spuriously warn that
  // it "collides" with the copy of itself just registered a line earlier).
  const found = [...new Set([mod.default, ...Object.values(mod)])]
    .filter(c => c?.name !== undefined && typeof c?.run === 'function')
  if (found.length === 0) { warn(`command ${f} exports no { name, run } command`); return }
  for (const cmd of found) {
    const names = [cmd.name, ...(cmd.aliases ?? [])]
    if (!names.every(n => accept(n))) continue
    if (out.has(cmd.name) && out.get(cmd.name) !== cmd) warn(`command "${cmd.name}" in ${f} overrides an earlier one`)
    out.set(cmd.name, cmd)
    owner?.set(cmd.name, ownerLabel)
    for (const a of cmd.aliases ?? []) { out.set(a, cmd); owner?.set(a, ownerLabel) }
  }
}

/**
 * Discover and load every command module: the global `scripts/commands/*.mjs`, then — when a
 * persona is given — that persona's own commands, layered on top.
 *
 * A persona command is only ever additive: one whose name (or alias) collides with an
 * already-registered global is refused with a warning rather than shadowing it (a persona cannot
 * redefine `/help`), and one listed in the persona but missing on disk is warned about and
 * skipped. With no `opts`, behaviour is exactly the pre-persona one — the registry holds only the
 * globals.
 * @param {object} [opts] - options.
 * @param {string|{id: string, commands?: string[]}} [opts.persona] - the active persona (an id, or
 *   a normalized persona carrying its own `commands` list — only the latter has anything to load).
 * @param {string} [opts.root] - the repo root to resolve `scripts/commands` and
 *   `personas/<id>/commands` under. Defaults to `REPO`.
 * @returns {Promise<Map<string, object>>} commands by name, including aliases.
 */
export async function loadCommands({ persona, root = REPO } = {}) {
  const dir = join(root, 'scripts', 'commands')
  const out = new Map()
  const owner = new Map()
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith('.mjs')) await loadCommandFile(out, dir, f, () => true, owner, 'a global command')
    }
  }

  const id = typeof persona === 'string' ? persona : persona?.id
  const names = typeof persona === 'string' ? undefined : persona?.commands
  if (id !== undefined && names !== undefined) {
    if (!SAFE_NAME.test(id)) { warn(`persona id "${id}" is not a safe path component (expected ${SAFE_NAME.source}) — skipping its commands`); return out }
    const personaDir = join(root, 'personas', id, 'commands')
    for (const name of names) {
      if (!SAFE_NAME.test(name)) { warn(`persona "${id}" command name "${name}" is not a safe path component (expected ${SAFE_NAME.source}) — skipping`); continue }
      const f = `${name}.mjs`
      if (!existsSync(join(personaDir, f))) { warn(`persona "${id}" lists command "${name}" but ${join(personaDir, f)} is missing`); continue }
      await loadCommandFile(out, personaDir, f, n => {
        if (out.has(n)) { warn(`persona "${id}" command "${n}" collides with ${owner.get(n) ?? 'a global command'} — refused`); return false }
        return true
      }, owner, `persona "${id}"'s command`)
    }
  }
  return out
}

/**
 * The machine-readable command list behind `verness.mjs --list-commands`: one entry per command,
 * its aliases folded in, sorted by name. `web` is false for a command whose definition sets
 * `web: false` (it only makes sense in the terminal), so the web commands bridge skips it.
 * @param {Map<string, object>} commands - the registry, as `loadCommands` returns it.
 * @returns {{name: string, summary: string, usage: string, aliases: string[], web: boolean}[]} the list.
 */
export function commandList(commands) {
  return [...new Set(commands.values())]
    .map(cmd => ({
      name: cmd.name,
      summary: cmd.summary ?? '',
      usage: cmd.usage ?? `/${cmd.name}`,
      aliases: [...(cmd.aliases ?? [])],
      web: cmd.web !== false,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Resolve a typed command word against the registry. An exact name or alias always wins; otherwise
 * the word is a prefix, and it resolves only when the names and aliases starting with it all belong
 * to one command (a command's name and its alias count once).
 * @param {string} word - the typed word, without the leading `/`.
 * @param {Map<string, object>} commands - the loaded registry (names and aliases).
 * @returns {{name?: string, candidates: string[]}} the resolved command's canonical name, if any,
 *   and every command name the word could mean (sorted; more than one means ambiguous).
 */
export function resolveCommand(word, commands) {
  const typed = word.toLowerCase()
  if (typed === '') return { candidates: [] }
  const exact = commands.get(typed)
  if (exact !== undefined) return { name: exact.name, candidates: [exact.name] }
  const hits = new Set()
  for (const [key, cmd] of commands) if (key.startsWith(typed)) hits.add(cmd.name)
  const candidates = [...hits].sort()
  if (candidates.length === 1) return { name: candidates[0], candidates }
  // A name that every other candidate extends is the one meant: `/mo` is `/model`, not `/models`.
  const shortest = candidates.reduce((a, b) => (b.length < a.length ? b : a), candidates[0] ?? '')
  if (candidates.length > 1 && candidates.every(c => c.startsWith(shortest))) return { name: shortest, candidates }
  return { candidates }
}

/**
 * Classify one REPL line. A leading `/` marks a command; a leading `//` escapes that, so the line is
 * a task with one slash removed (`//etc/hosts is odd` sends `/etc/hosts is odd`); anything else is a
 * task as typed. A leading `#` appends the rest to the project brief (`kind: 'brief'`, text '' for a
 * bare `#`, which shows it); `##` escapes that the same way `//` does (T-147).
 * @param {string} line - the raw input line.
 * @returns {{kind: 'empty'} | {kind: 'command' | 'task' | 'brief', text: string}} what the line is.
 */
export function classifyLine(line) {
  const text = line.trim()
  if (text === '') return { kind: 'empty' }
  if (text.startsWith('//')) return { kind: 'task', text: text.slice(1) }
  if (text.startsWith('/')) return { kind: 'command', text }
  if (text.startsWith('##')) return { kind: 'task', text: text.slice(1) }
  if (text.startsWith('#')) return { kind: 'brief', text: text.slice(1).trim() }
  return { kind: 'task', text }
}

/**
 * Resolve and run one command line. The command word may be a unique prefix (`/pers` runs
 * `/persona`); an ambiguous prefix lists the candidates and runs nothing, and still counts as
 * handled, so the line is never passed on to the model as a task.
 * @param {string} input - the raw input, with or without a leading `/`.
 * @param {object} ctx - the command context (config, personas, helpers).
 * @returns {Promise<{handled: boolean, code?: number, name?: string, ambiguous?: string[]}>} whether
 *   a command matched, its status and canonical name, and the candidates of an ambiguous prefix.
 */
export async function runCommand(input, ctx) {
  const words = input.trim().replace(/^\//, '').split(/\s+/).filter(w => w !== '')
  if (words.length === 0) return { handled: false }
  const { name, candidates } = resolveCommand(words[0], ctx.commands)
  if (name === undefined && candidates.length > 1) {
    warn(`/${words[0].toLowerCase()} is ambiguous: ${candidates.map(n => `/${n}`).join(', ')} - type more of the name`)
    return { handled: true, code: 1, ambiguous: candidates }
  }
  const cmd = name === undefined ? undefined : ctx.commands.get(name)
  if (cmd === undefined) return { handled: false }
  const code = await cmd.run(ctx, words.slice(1))
  return { handled: true, code: code ?? 0, name }
}
