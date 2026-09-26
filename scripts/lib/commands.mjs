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
 * Load one command file and register its default export plus any named export shaped like a
 * command — so a set of closely related one-liners can live in one file instead of one file each.
 * @param {Map<string, object>} out - the registry to fill.
 * @param {string} dir - the directory the file lives in.
 * @param {string} f - the file name (must end in `.mjs`).
 * @param {(cmd: object) => boolean} [accept] - called before a name is registered; returning
 *   `false` refuses the command (with a warning) instead of adding it. Defaults to accepting
 *   everything, which is how the global directory has always behaved.
 * @returns {Promise<void>}
 */
async function loadCommandFile(out, dir, f, accept = () => true) {
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
    for (const a of cmd.aliases ?? []) out.set(a, cmd)
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
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith('.mjs')) await loadCommandFile(out, dir, f)
    }
  }

  const id = typeof persona === 'string' ? persona : persona?.id
  const names = typeof persona === 'string' ? undefined : persona?.commands
  if (id !== undefined && names !== undefined) {
    const personaDir = join(root, 'personas', id, 'commands')
    for (const name of names) {
      const f = `${name}.mjs`
      if (!existsSync(join(personaDir, f))) { warn(`persona "${id}" lists command "${name}" but ${join(personaDir, f)} is missing`); continue }
      await loadCommandFile(out, personaDir, f, n => {
        if (out.has(n)) { warn(`persona "${id}" command "${n}" collides with a global command — refused`); return false }
        return true
      })
    }
  }
  return out
}

/**
 * Resolve and run one command line.
 * @param {string} input - the raw input, with or without a leading `/`.
 * @param {object} ctx - the command context (config, personas, helpers).
 * @returns {Promise<{handled: boolean, code?: number}>} whether a command matched, and its status.
 */
export async function runCommand(input, ctx) {
  const words = input.trim().replace(/^\//, '').split(/\s+/).filter(w => w !== '')
  if (words.length === 0) return { handled: false }
  const cmd = ctx.commands.get(words[0].toLowerCase())
  if (cmd === undefined) return { handled: false }
  const code = await cmd.run(ctx, words.slice(1))
  return { handled: true, code: code ?? 0 }
}
