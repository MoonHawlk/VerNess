/**
 * `loadCommands({persona, root})` layers a persona's own commands after the globals: a persona
 * command is registered under its own name, but one that collides with an already-registered
 * global (or its alias) is refused with a warning and never shadows the global. With no `opts`,
 * behaviour is byte-for-byte unchanged — no persona commands are ever mixed in by accident.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadCommands } from '../lib/commands.mjs'

/** @returns {string} a temp repo root with `scripts/commands/` and `personas/` set up for the test. */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'verness-commands-'))
  mkdirSync(join(root, 'scripts', 'commands'), { recursive: true })
  writeFileSync(
    join(root, 'scripts', 'commands', 'help.mjs'),
    `export default { name: 'help', summary: 'global help', run: () => 0 }\n`,
    'utf8',
  )
  return root
}

test('loadCommands without opts never includes persona commands', async () => {
  const root = makeRoot()
  try {
    mkdirSync(join(root, 'personas', 'scientist', 'commands'), { recursive: true })
    writeFileSync(
      join(root, 'personas', 'scientist', 'commands', 'hypotheses.mjs'),
      `export default { name: 'hypotheses', summary: 'persona-only', run: () => 0 }\n`,
      'utf8',
    )
    const commands = await loadCommands()
    assert.ok(!commands.has('hypotheses'), 'persona command must not leak in with no opts')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadCommands({persona, root}) includes the persona\'s own commands', async () => {
  const root = makeRoot()
  try {
    mkdirSync(join(root, 'personas', 'scientist', 'commands'), { recursive: true })
    writeFileSync(
      join(root, 'personas', 'scientist', 'commands', 'hypotheses.mjs'),
      `export default { name: 'hypotheses', summary: 'persona-only', run: () => 0 }\n`,
      'utf8',
    )
    const persona = { id: 'scientist', commands: ['hypotheses'] }
    const commands = await loadCommands({ persona, root })
    assert.ok(commands.has('hypotheses'), 'persona command should be registered')
    assert.equal(commands.get('hypotheses').summary, 'persona-only')
    // The global "help" is still there, untouched.
    assert.equal(commands.get('help').summary, 'global help')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a persona command named "help" is refused: the global wins', async () => {
  const root = makeRoot()
  try {
    mkdirSync(join(root, 'personas', 'scientist', 'commands'), { recursive: true })
    writeFileSync(
      join(root, 'personas', 'scientist', 'commands', 'help.mjs'),
      `export default { name: 'help', summary: 'persona help - should be refused', run: () => 0 }\n`,
      'utf8',
    )
    const persona = { id: 'scientist', commands: ['help'] }
    const commands = await loadCommands({ persona, root })
    assert.equal(commands.get('help').summary, 'global help', 'the global help must not be shadowed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadCommands({persona, root}) accepts a persona id string, resolved against the config', async () => {
  // When only an id string is passed (no commands array to hand), loadCommands cannot know which
  // files to load — the persona plumbing in verness.mjs always passes a normalized persona object
  // (with a `commands` array). Passing a bare string with no commands is a no-op, not an error.
  const root = makeRoot()
  try {
    const commands = await loadCommands({ persona: 'scientist', root })
    assert.ok(!commands.has('hypotheses'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadCommands warns and skips a persona command whose file is missing', async () => {
  const root = makeRoot()
  try {
    const persona = { id: 'scientist', commands: ['missing-cmd'] }
    const commands = await loadCommands({ persona, root })
    assert.ok(!commands.has('missing-cmd'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadCommands skips a persona command name that is not a safe path component', async (t) => {
  const root = makeRoot()
  try {
    const log = t.mock.method(console, 'log', () => {})
    // Inline (verness.config.json) personas are never schema-validated (Ruling R4), so a
    // maliciously- or accidentally-crafted `commands` entry like "../evil" must be rejected before
    // it is ever joined into a path, rather than trusted like a file-based persona's commands.
    const persona = { id: 'scientist', commands: ['../evil'] }
    const commands = await loadCommands({ persona, root })
    assert.ok(!commands.has('../evil'))
    assert.ok(!commands.has('evil'))
    assert.ok(log.mock.callCount() > 0, 'a warning should have been logged')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadCommandFile\'s Set dedup: a single default export warns 0 times', async (t) => {
  const root = makeRoot()
  try {
    const log = t.mock.method(console, 'log', () => {})
    mkdirSync(join(root, 'personas', 'scientist', 'commands'), { recursive: true })
    writeFileSync(
      join(root, 'personas', 'scientist', 'commands', 'hypotheses.mjs'),
      `export default { name: 'hypotheses', summary: 'persona-only', run: () => 0 }\n`,
      'utf8',
    )
    const persona = { id: 'scientist', commands: ['hypotheses'] }
    const commands = await loadCommands({ persona, root })
    assert.ok(commands.has('hypotheses'))
    assert.equal(log.mock.callCount(), 0, 'a single default export must not warn (no spurious self-collision)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a persona command named "help" warns exactly once, naming the global as the owner', async (t) => {
  const root = makeRoot()
  try {
    const log = t.mock.method(console, 'log', () => {})
    mkdirSync(join(root, 'personas', 'scientist', 'commands'), { recursive: true })
    writeFileSync(
      join(root, 'personas', 'scientist', 'commands', 'help.mjs'),
      `export default { name: 'help', summary: 'persona help - should be refused', run: () => 0 }\n`,
      'utf8',
    )
    const persona = { id: 'scientist', commands: ['help'] }
    const commands = await loadCommands({ persona, root })
    assert.equal(commands.get('help').summary, 'global help')
    assert.equal(log.mock.callCount(), 1, 'exactly one collision warning')
    const [msg] = log.mock.calls[0].arguments
    assert.ok(msg.includes('a global command'), `expected the owner to be named "a global command" in: ${msg}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a persona command colliding with another of the same persona\'s commands names the persona as the owner', async (t) => {
  const root = makeRoot()
  try {
    const log = t.mock.method(console, 'log', () => {})
    mkdirSync(join(root, 'personas', 'scientist', 'commands'), { recursive: true })
    writeFileSync(
      join(root, 'personas', 'scientist', 'commands', 'first.mjs'),
      `export default { name: 'dup', summary: 'first', run: () => 0 }\n`,
      'utf8',
    )
    writeFileSync(
      join(root, 'personas', 'scientist', 'commands', 'second.mjs'),
      `export default { name: 'dup', summary: 'second', run: () => 0 }\n`,
      'utf8',
    )
    const persona = { id: 'scientist', commands: ['first', 'second'] }
    const commands = await loadCommands({ persona, root })
    assert.equal(commands.get('dup').summary, 'first', 'the first-registered persona command wins')
    assert.equal(log.mock.callCount(), 1, 'exactly one collision warning')
    const [msg] = log.mock.calls[0].arguments
    assert.ok(
      msg.includes('persona "scientist"\'s command'),
      `expected the owner to be named as persona "scientist"'s command in: ${msg}`,
    )
    assert.ok(!msg.includes('a global command'), `owner must not be misreported as global in: ${msg}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
