/**
 * `loadPersonas` validates every `personas/<id>.json` file against the v2 contract
 * (`validatePersonaFile`) and reports each issue with a precise `file:line:column` location
 * (`locate`), rather than only surfacing a raw parse error.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadPersonas } from '../lib/personas.mjs'

test('loadPersonas reports a schema issue as file:line:column path: message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verness-personas-'))
  try {
    writeFileSync(
      join(dir, 'broken.json'),
      `{\n  "id": "broken",\n  "tools": {"allow": ["a"], "deny": ["a"]}\n}\n`,
      'utf8',
    )

    const personas = loadPersonas({}, { dir })
    const broken = personas.get('broken')

    assert.ok(broken !== undefined, 'broken persona should still be listed')
    assert.ok(broken.broken !== undefined, 'broken persona should carry a `broken` message')
    assert.match(broken.broken, /:\d+:\d+/, 'broken message should contain a file:line:column location')
    assert.ok(broken.broken.includes('tools.deny[0]'), `expected tools.deny[0] in: ${broken.broken}`)
    assert.ok(Array.isArray(broken.issues), 'broken persona should carry an issues array')
    assert.ok(broken.issues.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadPersonas does not throw when a persona file parses to a non-object', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verness-personas-'))
  try {
    writeFileSync(join(dir, 'a.json'), 'null\n', 'utf8')
    writeFileSync(join(dir, 'b.json'), '[]\n', 'utf8')
    writeFileSync(join(dir, 'c.json'), '42\n', 'utf8')

    let personas
    assert.doesNotThrow(() => { personas = loadPersonas({}, { dir }) })

    for (const id of ['a', 'b', 'c']) {
      const p = personas.get(id)
      assert.ok(p !== undefined, `${id} should still be listed`)
      assert.ok(p.broken !== undefined, `${id} should carry a \`broken\` message`)
      assert.ok(Array.isArray(p.issues) && p.issues.length > 0, `${id} should carry non-empty issues`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadPersonas reports the exact line:column when a comment and a trailing comma precede the error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verness-personas-'))
  try {
    writeFileSync(
      join(dir, 'broken.json'),
      '{\n' +
      '  // a persona with a mistake below\n' +
      '  "id": "broken",\n' +
      '  "tools": {"allow": ["a"], "deny": ["a"],}\n' +
      '}\n',
      'utf8',
    )

    const personas = loadPersonas({}, { dir })
    const broken = personas.get('broken')

    assert.ok(broken !== undefined)
    // line 4, column 38 is where "a" (tools.deny[0]) starts in the source above.
    assert.ok(broken.broken.includes(':4:38'), `expected :4:38 in: ${broken.broken}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadPersonas accepts a valid v2 persona file and normalizes v2 fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verness-personas-'))
  try {
    writeFileSync(
      join(dir, 'ok.json'),
      JSON.stringify({
        id: 'ok',
        name: 'OK',
        prompt: { prefix: 'p', suffix: 's' },
        models: { requirements: { reasoning: 'medium' } },
        tools: { allow: ['read'], deny: [], approval: { bash: 'ask' } },
        commands: ['profile-data'],
      }),
      'utf8',
    )

    const personas = loadPersonas({}, { dir })
    const ok = personas.get('ok')

    assert.ok(ok !== undefined)
    assert.equal(ok.broken, undefined)
    assert.equal(ok.prefix, 'p')
    assert.equal(ok.suffix, 's')
    assert.deepEqual(ok.requirements, { reasoning: 'medium' })
    assert.deepEqual(ok.tools.approval, { bash: 'ask' })
    assert.deepEqual(ok.commands, ['profile-data'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
