import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Issue, Result } from '../src/issue.ts'
import type { Persona } from '../src/persona.ts'
import { PERSONA_FIELDS } from '../src/persona.ts'
import { personaToFile, validatePersonaFile } from '../src/validate-persona.ts'

const PERSONAS_DIR = join(import.meta.dirname, '..', '..', '..', 'personas')

/**
 * Copy of the launcher's `parseJsonc` (scripts/lib/util.mjs): strip `//` and `/* *​/` comments
 * outside strings, drop trailing commas, then parse.
 */
function parseJsonc(text: string): unknown {
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

function ok(r: Result<Persona>): Persona {
  if (!r.ok) assert.fail(`expected ok, got ${JSON.stringify(r.errors)}`)
  return r.value
}

/**
 * Validate `input` and return the `Persona`, checking on the way that the same `Persona` comes back
 * from the input after a JSON round-trip, and from `personaToFile` of it (also after a JSON round-trip).
 */
function valid(input: unknown, opts?: { expectedId?: string }): Persona {
  const value = ok(validatePersonaFile(input, opts))
  const json = (x: unknown): unknown => JSON.parse(JSON.stringify(x))
  assert.deepEqual(ok(validatePersonaFile(json(input), opts)), value, 'input after a JSON round-trip')
  assert.deepEqual(ok(validatePersonaFile(personaToFile(value), opts)), value, 'personaToFile')
  assert.deepEqual(ok(validatePersonaFile(json(personaToFile(value)), opts)), value, 'personaToFile after a JSON round-trip')
  return value
}

function errors(r: Result<Persona>): Issue[] {
  if (r.ok) assert.fail('expected errors, got ok')
  return r.errors
}

/** The single issue at `path`; fails when there is none or more than one. */
function issueAt(r: Result<Persona>, path: (string | number)[]): Issue {
  const found = errors(r).filter(e => JSON.stringify(e.path) === JSON.stringify(path))
  assert.equal(found.length, 1, `expected one issue at ${JSON.stringify(path)}, got ${JSON.stringify(errors(r))}`)
  return found[0]!
}

test('PERSONA_FIELDS lists every v2 field', () => {
  assert.deepEqual([...PERSONA_FIELDS], ['$schema', 'id', 'version', 'name', 'description', 'prompt', 'model', 'models', 'tools', 'skills', 'evaluators', 'tips', 'commands', 'memory', 'decisions'])
})

test('every real persona file validates unchanged', () => {
  const files = readdirSync(PERSONAS_DIR).filter(f => f.endsWith('.json'))
  assert.ok(files.length >= 4, `expected persona files in ${PERSONAS_DIR}`)
  for (const f of files) {
    const raw = parseJsonc(readFileSync(join(PERSONAS_DIR, f), 'utf8'))
    valid(raw, { expectedId: f.slice(0, -'.json'.length) })
  }
})

test('non-object input is one issue at the root', () => {
  for (const v of [null, 'x', 1, [], undefined]) {
    assert.deepEqual(errors(validatePersonaFile(v)), [{ path: [], message: 'expected an object' }])
  }
})

test('id is required and must match the id pattern', () => {
  assert.match(issueAt(validatePersonaFile({}), ['id']).message, /required/)
  assert.match(issueAt(validatePersonaFile({ id: 'Data_Eng' }), ['id']).message, /\^\[a-z\]\[a-z0-9-\]\*\$/)
  assert.match(issueAt(validatePersonaFile({ id: 7 }), ['id']).message, /string/)
  valid({ id: 'a1-b' })
})

test('expectedId mismatch is an issue at id', () => {
  const m = issueAt(validatePersonaFile({ id: 'foo' }, { expectedId: 'bar' }), ['id']).message
  assert.match(m, /"foo"/)
  assert.match(m, /"bar"/)
  valid({ id: 'foo' }, { expectedId: 'foo' })
})

test('unknown top-level field suggests the closest known one', () => {
  assert.equal(issueAt(validatePersonaFile({ id: 'x', tool: [] }), ['tool']).message, 'unknown field "tool" — did you mean "tools"?')
  assert.equal(issueAt(validatePersonaFile({ id: 'x', zzzzzzzz: 1 }), ['zzzzzzzz']).message, 'unknown field "zzzzzzzz"')
})

test('unknown nested fields are reported with their nested path', () => {
  const r = validatePersonaFile({
    id: 'x',
    prompt: { prefx: '' },
    model: { rout: 'a' },
    models: { requirement: {} },
    tools: { alow: [] },
    memory: { scop: 'none' },
    decisions: { aply: {} },
  })
  assert.equal(issueAt(r, ['prompt', 'prefx']).message, 'unknown field "prefx" — did you mean "prefix"?')
  assert.equal(issueAt(r, ['model', 'rout']).message, 'unknown field "rout" — did you mean "route"?')
  assert.equal(issueAt(r, ['models', 'requirement']).message, 'unknown field "requirement" — did you mean "requirements"?')
  assert.equal(issueAt(r, ['tools', 'alow']).message, 'unknown field "alow" — did you mean "allow"?')
  assert.equal(issueAt(r, ['memory', 'scop']).message, 'unknown field "scop" — did you mean "scope"?')
  assert.equal(issueAt(r, ['decisions', 'aply']).message, 'unknown field "aply" — did you mean "apply"?')
  assert.equal(errors(r).length, 6)
})

test('nested sections must be objects', () => {
  const r = validatePersonaFile({ id: 'x', prompt: 'hi', model: [], models: 1, tools: null, memory: 'session', decisions: true })
  for (const f of ['prompt', 'model', 'models', 'tools', 'memory', 'decisions']) {
    assert.equal(issueAt(r, [f]).message, 'expected an object')
  }
})

test('strings are required where strings are expected', () => {
  const r = validatePersonaFile({
    id: 'x',
    $schema: 1,
    version: 2,
    name: false,
    description: [],
    prompt: { prefix: 1, suffix: {} },
    model: { id: 1, route: 2 },
    decisions: { provider: 3 },
  })
  for (const p of [['$schema'], ['version'], ['name'], ['description'], ['prompt', 'prefix'], ['prompt', 'suffix'], ['model', 'id'], ['model', 'route'], ['decisions', 'provider']]) {
    assert.equal(issueAt(r, p).message, 'expected a string')
  }
})

test('string arrays: non-array is one issue, each bad item is its own issue', () => {
  for (const f of ['skills', 'evaluators', 'tips', 'commands']) {
    assert.equal(issueAt(validatePersonaFile({ id: 'x', [f]: 'a' }), [f]).message, 'expected an array of strings')
  }
  const r = validatePersonaFile({ id: 'x', skills: ['ok', '', 3], tips: [null] })
  assert.equal(issueAt(r, ['skills', 1]).message, 'must be a non-empty string')
  assert.equal(issueAt(r, ['skills', 2]).message, 'must be a non-empty string')
  assert.equal(issueAt(r, ['tips', 0]).message, 'must be a non-empty string')
  assert.equal(errors(r).length, 3)
})

test('tools.allow and tools.deny are arrays of non-empty strings', () => {
  const r = validatePersonaFile({ id: 'x', tools: { allow: 'read', deny: ['', 'bash'] } })
  assert.equal(issueAt(r, ['tools', 'allow']).message, 'expected an array of strings')
  assert.equal(issueAt(r, ['tools', 'deny', 0]).message, 'must be a non-empty string')
})

test('tools.allow and tools.deny must not overlap', () => {
  const r = validatePersonaFile({ id: 'x', tools: { allow: ['read', 'bash'], deny: ['net', 'bash'] } })
  assert.deepEqual(errors(r), [{ path: ['tools', 'deny', 1], message: '"bash" is both allowed and denied' }])
})

test('tools.approval values are allow, ask or deny', () => {
  const r = validatePersonaFile({ id: 'x', tools: { approval: { bash: 'ask', 'sql.write': 'maybe', read: 'allow', x: 'deny' } } })
  assert.deepEqual(errors(r), [{ path: ['tools', 'approval', 'sql.write'], message: 'expected one of "allow", "ask", "deny"' }])
  assert.equal(issueAt(validatePersonaFile({ id: 'x', tools: { approval: [] } }), ['tools', 'approval']).message, 'expected an object')
})

test('models.requirements is checked by validateCapabilities with the full path', () => {
  const r = validatePersonaFile({ id: 'x', models: { requirements: { reasonng: 'high', code: 'extreme' } } })
  assert.equal(issueAt(r, ['models', 'requirements', 'reasonng']).message, 'unknown capability "reasonng" — did you mean "reasoning"?')
  assert.match(issueAt(r, ['models', 'requirements', 'code']).message, /expected one of/)
  assert.equal(issueAt(validatePersonaFile({ id: 'x', models: { requirements: 1 } }), ['models', 'requirements']).message, 'expected an object')
  const p = valid({ id: 'x', models: { requirements: { code: 'medium', context: 32000 } } })
  assert.deepEqual(p.modelPolicy.requirements, { code: 'medium', context: 32000 })
})

test('commands match the id pattern; a leading slash names the fix', () => {
  const r = validatePersonaFile({ id: 'x', commands: ['profile-data', '/profile-data', 'Bad_Name'] })
  assert.equal(issueAt(r, ['commands', 1]).message, '"/profile-data" — drop the leading slash: "profile-data"')
  assert.equal(issueAt(r, ['commands', 2]).message, '"Bad_Name" must match ^[a-z][a-z0-9-]*$')
  assert.equal(errors(r).length, 2)
})

test('memory.scope is none, session or project', () => {
  assert.equal(issueAt(validatePersonaFile({ id: 'x', memory: { scope: 'forever' } }), ['memory', 'scope']).message, 'expected one of "none", "session", "project"')
  assert.equal(valid({ id: 'x', memory: { scope: 'project' } }).memory.scope, 'project')
})

test('decisions.apply is an object of booleans', () => {
  const r = validatePersonaFile({ id: 'x', decisions: { apply: { lint: true, format: 'yes' } } })
  assert.deepEqual(errors(r), [{ path: ['decisions', 'apply', 'format'], message: 'expected a boolean' }])
  assert.equal(issueAt(validatePersonaFile({ id: 'x', decisions: { apply: [] } }), ['decisions', 'apply']).message, 'expected an object')
  const p = valid({ id: 'x', decisions: { provider: 'auto', apply: { lint: true } } })
  assert.deepEqual(p.decisionPolicy, { provider: 'auto', apply: { lint: true } })
})

test('all issues are collected, not just the first', () => {
  const r = validatePersonaFile({ id: 'X', tool: [], skills: [1], memory: { scope: 'x' }, commands: ['/a'] })
  assert.equal(errors(r).length, 5)
})

test('defaults for a minimal persona', () => {
  const p = valid({ id: 'min' })
  assert.deepEqual(p, {
    id: 'min',
    version: '1',
    identity: { name: 'min', description: '' },
    prompt: { prefix: '', suffix: '' },
    modelPolicy: { requirements: {} },
    decisionPolicy: { apply: {} },
    skills: [],
    tools: { allow: [], deny: [], approval: {} },
    memory: { scope: 'session' },
    evaluation: { evaluators: [] },
    security: { deny: [] },
    tips: [],
    commands: [],
  })
  assert.equal('preferred' in p.modelPolicy, false)
  assert.equal('provider' in p.decisionPolicy, false)
})

const FULL = {
  $schema: '../schemas/persona.schema.json',
  id: 'full',
  version: '2',
  name: 'Full',
  description: 'Everything set.',
  prompt: { prefix: 'pre', suffix: 'suf' },
  model: { id: 'deepseek-chat', route: 'remote' },
  models: { requirements: { code: 'high', context: 64000 } },
  tools: { allow: ['read', 'bash'], deny: ['net'], approval: { bash: 'ask' } },
  skills: ['sql'],
  evaluators: ['idempotence'],
  tips: ['Be careful.'],
  commands: ['profile-data'],
  memory: { scope: 'project' },
  decisions: { provider: 'auto', apply: { lint: true, format: false } },
}

test('a full v2 persona normalises field by field', () => {
  const p = valid(FULL, { expectedId: 'full' })
  assert.deepEqual(p, {
    id: 'full',
    version: '2',
    identity: { name: 'Full', description: 'Everything set.' },
    prompt: { prefix: 'pre', suffix: 'suf' },
    modelPolicy: { preferred: { id: 'deepseek-chat', route: 'remote' }, requirements: { code: 'high', context: 64000 } },
    decisionPolicy: { provider: 'auto', apply: { lint: true, format: false } },
    skills: ['sql'],
    tools: { allow: ['read', 'bash'], deny: ['net'], approval: { bash: 'ask' } },
    memory: { scope: 'project' },
    evaluation: { evaluators: ['idempotence'] },
    security: { deny: ['net'] },
    tips: ['Be careful.'],
    commands: ['profile-data'],
  })
})

test('modelPolicy.preferred carries only the parts given', () => {
  assert.deepEqual(valid({ id: 'x', model: { route: 'local' } }).modelPolicy, { preferred: { route: 'local' }, requirements: {} })
  assert.equal('preferred' in valid({ id: 'x', model: {} }).modelPolicy, false)
})

test('the normalised persona does not alias the input', () => {
  const input = structuredClone(FULL)
  const p = valid(input)
  assert.notEqual(p.tools.allow, input.tools.allow)
  assert.notEqual(p.tools.deny, input.tools.deny)
  assert.notEqual(p.security.deny, p.tools.deny)
  assert.notEqual(p.tools.approval, input.tools.approval)
  assert.notEqual(p.decisionPolicy.apply, input.decisions.apply)
  assert.notEqual(p.skills, input.skills)
  assert.notEqual(p.modelPolicy.requirements, input.models.requirements)
  p.tools.deny.push('mutated')
  assert.deepEqual(input.tools.deny, ['net'])
  assert.deepEqual(p.security.deny, ['net'])
})

test('normalising is idempotent through personaToFile', () => {
  const inputs: unknown[] = [{ id: 'min' }, FULL, { id: 'x', model: { id: 'm' }, tools: { deny: ['a'] } }]
  for (const f of readdirSync(PERSONAS_DIR).filter(f => f.endsWith('.json'))) {
    inputs.push(parseJsonc(readFileSync(join(PERSONAS_DIR, f), 'utf8')))
  }
  for (const input of inputs) {
    valid(input)
  }
})
