import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Issue, Result } from '../src/issue.ts'
import type { SkillMetadata } from '../src/skill.ts'
import { validateSkillMetadata } from '../src/validate-skill.ts'

function ok(r: Result<SkillMetadata>): SkillMetadata {
  if (!r.ok) assert.fail(`expected ok, got ${JSON.stringify(r.errors)}`)
  return r.value
}

function errors(r: Result<SkillMetadata>): Issue[] {
  if (r.ok) assert.fail('expected errors, got ok')
  return r.errors
}

/** The single issue at `path`; fails when there is none or more than one. */
function issueAt(r: Result<SkillMetadata>, path: (string | number)[]): Issue {
  const found = errors(r).filter(e => JSON.stringify(e.path) === JSON.stringify(path))
  assert.equal(found.length, 1, `expected one issue at ${JSON.stringify(path)}, got ${JSON.stringify(errors(r))}`)
  return found[0]!
}

/**
 * Validate `input` and return the `SkillMetadata`, checking on the way that the same value comes
 * back after a JSON round-trip of the input, and that re-validating the value itself (idempotent)
 * gives the same value back.
 */
function valid(input: unknown): SkillMetadata {
  const value = ok(validateSkillMetadata(input))
  const json = (x: unknown): unknown => JSON.parse(JSON.stringify(x))
  assert.deepEqual(ok(validateSkillMetadata(json(input))), value, 'input after a JSON round-trip')
  assert.deepEqual(ok(validateSkillMetadata(value)), value, 'validating the value itself is idempotent')
  return value
}

test('non-object input is one issue at the root', () => {
  for (const v of [null, 'x', 1, [], undefined]) {
    assert.deepEqual(errors(validateSkillMetadata(v)), [{ path: [], message: 'expected an object' }])
  }
})

test('name and description are required non-empty strings', () => {
  assert.match(issueAt(validateSkillMetadata({}), ['name']).message, /required/)
  assert.match(issueAt(validateSkillMetadata({}), ['description']).message, /required/)
  assert.match(issueAt(validateSkillMetadata({ name: '', description: 'x' }), ['name']).message, /non-empty/)
  assert.match(issueAt(validateSkillMetadata({ name: 1, description: 'x' }), ['name']).message, /expected a string/)
  const p = valid({ name: 'sql', description: 'Writes SQL.' })
  assert.deepEqual(p, { name: 'sql', description: 'Writes SQL.' })
})

test('version is a string when present', () => {
  assert.match(issueAt(validateSkillMetadata({ name: 'n', description: 'd', version: 1 }), ['version']).message, /expected a string/)
  assert.equal(valid({ name: 'n', description: 'd', version: '2' }).version, '2')
  assert.equal('version' in valid({ name: 'n', description: 'd' }), false)
})

test('unknown top-level field suggests the closest known one', () => {
  assert.equal(issueAt(validateSkillMetadata({ name: 'n', description: 'd', descrption: 'x' }), ['descrption']).message, 'unknown field "descrption" — did you mean "description"?')
  assert.equal(issueAt(validateSkillMetadata({ name: 'n', description: 'd', zzzzzzzz: 1 }), ['zzzzzzzz']).message, 'unknown field "zzzzzzzz"')
})

test('activation.triggers is an array of non-empty strings', () => {
  const r = validateSkillMetadata({ name: 'n', description: 'd', activation: { triggers: ['ok', '', 3] } })
  assert.equal(issueAt(r, ['activation', 'triggers', 1]).message, 'must be a non-empty string')
  assert.equal(issueAt(r, ['activation', 'triggers', 2]).message, 'must be a non-empty string')
  assert.equal(issueAt(validateSkillMetadata({ name: 'n', description: 'd', activation: { triggers: 'sql' } }), ['activation', 'triggers']).message, 'expected an array of strings')
  assert.equal(issueAt(validateSkillMetadata({ name: 'n', description: 'd', activation: 1 }), ['activation']).message, 'expected an object')
  assert.deepEqual(valid({ name: 'n', description: 'd', activation: { triggers: ['sql'] } }).activation, { triggers: ['sql'] })
  assert.equal('activation' in valid({ name: 'n', description: 'd', activation: {} }), false)
})

test('unknown field inside activation suggests triggers', () => {
  const r = validateSkillMetadata({ name: 'n', description: 'd', activation: { trigers: ['x'] } })
  assert.equal(issueAt(r, ['activation', 'trigers']).message, 'unknown field "trigers" — did you mean "triggers"?')
})

test('requirements.tools is an array of non-empty strings', () => {
  const r = validateSkillMetadata({ name: 'n', description: 'd', requirements: { tools: ['ok', ''] } })
  assert.equal(issueAt(r, ['requirements', 'tools', 1]).message, 'must be a non-empty string')
  assert.equal(issueAt(validateSkillMetadata({ name: 'n', description: 'd', requirements: 1 }), ['requirements']).message, 'expected an object')
  assert.deepEqual(valid({ name: 'n', description: 'd', requirements: { tools: ['bash'] } }).requirements, { tools: ['bash'] })
  assert.equal('requirements' in valid({ name: 'n', description: 'd', requirements: {} }), false)
})

test('unknown field inside requirements suggests tools', () => {
  const r = validateSkillMetadata({ name: 'n', description: 'd', requirements: { tool: ['x'] } })
  assert.equal(issueAt(r, ['requirements', 'tool']).message, 'unknown field "tool" — did you mean "tools"?')
})

test('evaluators is an array of non-empty strings', () => {
  const r = validateSkillMetadata({ name: 'n', description: 'd', evaluators: ['ok', ''] })
  assert.equal(issueAt(r, ['evaluators', 1]).message, 'must be a non-empty string')
  assert.equal(issueAt(validateSkillMetadata({ name: 'n', description: 'd', evaluators: 'idempotence' }), ['evaluators']).message, 'expected an array of strings')
  assert.deepEqual(valid({ name: 'n', description: 'd', evaluators: ['idempotence'] }).evaluators, ['idempotence'])
  assert.equal('evaluators' in valid({ name: 'n', description: 'd' }), false)
})

test('all issues are collected, not just the first', () => {
  const r = validateSkillMetadata({ description: '', evaluators: [1], activation: { trigers: [] } })
  assert.equal(errors(r).length, 4)
})

test('a full skill metadata normalises field by field', () => {
  const full = {
    name: 'sql',
    description: 'Writes SQL.',
    version: '1.0.0',
    activation: { triggers: ['sql', 'query'] },
    requirements: { tools: ['bash'] },
    evaluators: ['idempotence'],
  }
  const p = valid(full)
  assert.deepEqual(p, full)
})

test('the normalised value does not alias the input', () => {
  const input = { name: 'n', description: 'd', activation: { triggers: ['a'] }, requirements: { tools: ['b'] }, evaluators: ['c'] }
  const p = valid(input)
  assert.notEqual(p.activation, input.activation)
  assert.notEqual(p.activation!.triggers, input.activation.triggers)
  assert.notEqual(p.requirements, input.requirements)
  assert.notEqual(p.requirements!.tools, input.requirements.tools)
  assert.notEqual(p.evaluators, input.evaluators)
  p.evaluators!.push('mutated')
  assert.deepEqual(input.evaluators, ['c'])
})
