/**
 * Registry conformance (T-135): every command exported from `scripts/commands/*.mjs` has the shape
 * the registry and `/help` rely on, and no two global commands share a name or alias. The registry
 * Map would silently let a later file overwrite an earlier one, so duplicates are counted here from
 * the exports themselves.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { commandsDir } from '../lib/commands.mjs'

/**
 * Every command-like export, picked the way the loader picks them (default plus named exports,
 * each object once) but without pre-filtering on `run`, so a missing `run` fails the shape test.
 * @returns {Promise<{file: string, cmd: object}[]>} the commands with their file.
 */
async function exportedCommands() {
  const out = []
  for (const file of readdirSync(commandsDir()).filter(f => f.endsWith('.mjs')).sort()) {
    const mod = await import(pathToFileURL(join(commandsDir(), file)).href)
    for (const cmd of new Set([mod.default, ...Object.values(mod)])) {
      if (cmd !== null && typeof cmd === 'object' && cmd.name !== undefined) out.push({ file, cmd })
    }
  }
  return out
}

const all = await exportedCommands()

test('every command file exports at least one command', () => {
  const files = readdirSync(commandsDir()).filter(f => f.endsWith('.mjs'))
  for (const f of files) assert.ok(all.some(c => c.file === f), `${f} exports no command`)
})

test('every command has name, summary, run, and well-typed optional fields', () => {
  assert.ok(all.length > 0)
  for (const { file, cmd } of all) {
    const at = `${file}: ${cmd.name}`
    assert.equal(typeof cmd.name, 'string', `${at}: name must be a string`)
    assert.match(cmd.name, /^[a-z][a-z0-9-]*$/, `${at}: name must be lower-case letters, digits and dashes`)
    assert.equal(typeof cmd.summary, 'string', `${at}: summary must be a string`)
    assert.notEqual(cmd.summary.trim(), '', `${at}: summary must not be empty`)
    assert.equal(typeof cmd.run, 'function', `${at}: run must be a function`)
    if (cmd.aliases !== undefined) {
      assert.ok(Array.isArray(cmd.aliases), `${at}: aliases must be an array`)
      for (const a of cmd.aliases) assert.ok(typeof a === 'string' && a !== '' && !/\s/.test(a), `${at}: alias ${JSON.stringify(a)} must be a non-empty word`)
    }
    if (cmd.web !== undefined) assert.equal(typeof cmd.web, 'boolean', `${at}: web must be a boolean`)
  }
})

test('no two global commands share a name or alias', () => {
  const owner = new Map()
  const clashes = []
  for (const { file, cmd } of all) {
    for (const n of [cmd.name, ...(cmd.aliases ?? [])]) {
      const key = n.toLowerCase()
      if (owner.has(key)) clashes.push(`/${key}: ${owner.get(key)} and ${file} (${cmd.name})`)
      else owner.set(key, `${file} (${cmd.name})`)
    }
  }
  assert.deepEqual(clashes, [])
})
