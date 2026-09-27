/**
 * Persona catalog conformance (T-393): every real `personas/*.json` is valid, named after its id,
 * and every persona-scoped command it lists exists, cannot clash with a global command, and runs
 * with no model call. A new persona file or command is covered the moment it lands.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { loadCommands } from '../lib/commands.mjs'
import { groupByFamily, loadPersonas } from '../lib/personas.mjs'
import { REPO } from '../lib/util.mjs'

const DIR = join(REPO, 'personas')
const files = readdirSync(DIR).filter(f => f.endsWith('.json')).sort()
const personas = loadPersonas({})

test('there is at least one persona file', () => {
  assert.ok(files.length > 0)
})

for (const f of files) {
  const id = f.replace(/\.json$/, '')

  test(`${f}: loads, validates with zero issues, and is named after its id`, () => {
    const p = personas.get(id)
    assert.ok(p !== undefined, `no persona with id "${id}" - the file's id must equal its file name`)
    assert.equal(p.broken, undefined, `${f} is broken: ${p.broken}`)
    assert.deepEqual(p.issues ?? [], [], `${f} has validation issues`)
    assert.equal(p.source, `personas/${f}`)
  })

  test(`${f}: every listed command exists, is unique to the persona and runs without a model`, async () => {
    const p = personas.get(id)
    const globals = await loadCommands()
    for (const name of p?.commands ?? []) {
      const file = join(DIR, id, 'commands', `${name}.mjs`)
      assert.ok(existsSync(file), `${f} lists "${name}" but ${file} is missing`)
      const cmd = (await import(pathToFileURL(file).href)).default
      assert.equal(cmd?.name, name, `${file} must export default { name: '${name}', ... }`)
      assert.equal(typeof cmd.run, 'function')
      assert.equal(typeof cmd.summary, 'string')
      for (const n of [cmd.name, ...(cmd.aliases ?? [])]) {
        assert.ok(!globals.has(n), `persona command "${n}" collides with a global command`)
      }
      // Zero tokens: run it with an empty context and capture what it prints.
      const out = []
      const log = console.log
      console.log = (...a) => { out.push(a.join(' ')) }
      let code
      try { code = await cmd.run({}, []) } finally { console.log = log }
      assert.equal(code ?? 0, 0, `/${name} returned ${code}`)
      assert.ok(out.join('\n').trim().length > 0, `/${name} printed nothing`)
    }
  })
}

test('every persona command directory belongs to a persona that lists its commands', () => {
  for (const d of readdirSync(DIR, { withFileTypes: true }).filter(e => e.isDirectory())) {
    const p = personas.get(d.name)
    assert.ok(p !== undefined, `personas/${d.name}/ has no personas/${d.name}.json`)
    const dir = join(DIR, d.name, 'commands')
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir).filter(n => n.endsWith('.mjs'))) {
      assert.ok((p.commands ?? []).includes(f.replace(/\.mjs$/, '')), `personas/${d.name}/commands/${f} is not listed in "commands"`)
    }
  }
})

test('groupByFamily: fixed family order, unknown or missing family goes to other, empty groups dropped (T-395)', () => {
  const m = new Map([
    ['r', { id: 'r', family: 'research' }],
    ['d', { id: 'd', family: 'data' }],
    ['g', { id: 'g', family: 'other' }],
    ['x', { id: 'x', family: 'mystery' }],
  ])
  assert.deepEqual(groupByFamily(m).map(([f, ps]) => [f, ps.map(p => p.id)]), [['data', ['d']], ['research', ['r']], ['other', ['g', 'x']]])
})

test('every persona file declares a family (T-395)', () => {
  for (const f of files) assert.notEqual(personas.get(f.replace(/\.json$/, '')).family, 'other', `${f} has no family`)
})
