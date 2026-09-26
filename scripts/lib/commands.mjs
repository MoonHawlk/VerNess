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
 * Discover and load every command module.
 * @returns {Promise<Map<string, object>>} commands by name, including aliases.
 */
export async function loadCommands() {
  const dir = commandsDir()
  const out = new Map()
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.mjs')) continue
    let mod
    try { mod = await import(pathToFileURL(join(dir, f)).href) } catch (e) { warn(`command ${f} failed to load: ${e.message}`); continue }
    // A file registers its default export, plus any named export shaped like a command — so a set
    // of closely related one-liners can live in one file instead of one file each.
    const found = [mod.default, ...Object.values(mod)]
      .filter(c => c?.name !== undefined && typeof c?.run === 'function')
    if (found.length === 0) { warn(`command ${f} exports no { name, run } command`); continue }
    for (const cmd of found) {
      if (out.has(cmd.name) && out.get(cmd.name) !== cmd) warn(`command "${cmd.name}" in ${f} overrides an earlier one`)
      out.set(cmd.name, cmd)
      for (const a of cmd.aliases ?? []) out.set(a, cmd)
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
