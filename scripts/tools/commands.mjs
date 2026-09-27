#!/usr/bin/env node
/**
 * `commands` — every quick-tool: the global ones and each persona's own, with group, owner, usage
 * and the file that defines it. Flags any persona command that would clash with a global.
 *
 *   node scripts/tools/commands.mjs            everything
 *   node scripts/tools/commands.mjs dd         only commands whose name, alias or summary contains "dd"
 * @module scripts/tools/commands
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { loadCommands } from '../lib/commands.mjs'
import { loadPersonas } from '../lib/personas.mjs'
import { REPO, helpIf, parseArgs, table } from './_lib.mjs'

const args = parseArgs(process.argv.slice(2))
helpIf(args, `
commands [filter]
  every global quick-tool (scripts/commands/) and every persona command (personas/<id>/commands/),
  with group, aliases, owner and file; warns about persona commands that clash with a global`)

const filter = args._[0]?.toLowerCase()
const globals = await loadCommands()
const rows = []
const seen = new Set()
for (const cmd of globals.values()) {
  if (seen.has(cmd)) continue
  seen.add(cmd)
  rows.push([`/${cmd.name}`, (cmd.aliases ?? []).map(a => `/${a}`).join(' '), cmd.group ?? '', 'global', cmd.summary ?? ''])
}
const clashes = []
for (const p of loadPersonas({}).values()) {
  for (const name of p.commands ?? []) {
    const file = join(REPO, 'personas', p.id, 'commands', `${name}.mjs`)
    rows.push([`/${name}`, '', 'personas', p.id, existsSync(file) ? '' : 'MISSING FILE'])
    if (globals.has(name)) clashes.push(`/${name} (${p.id})`)
  }
}
const shown = rows.filter(r => filter === undefined || r.join(' ').toLowerCase().includes(filter))
  .sort((a, b) => a[2].localeCompare(b[2]) || a[0].localeCompare(b[0]))
console.log(table(['command', 'aliases', 'group', 'owner', 'summary'], shown.map(r => [...r.slice(0, 4), r[4].slice(0, 70)])))
console.log(`\n${shown.length} of ${rows.length} command(s)${clashes.length > 0 ? `; CLASH with a global: ${clashes.join(', ')}` : '; no clashes'}`)
