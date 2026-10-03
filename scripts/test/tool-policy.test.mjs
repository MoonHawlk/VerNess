/**
 * Persona tool policy (`packages/tool-policy`, T-042/T-116/T-154/T-155): the decision matrix, the
 * `tools/pre-execute` listener against a fake ctx, and the patch/overlay lines that carry the policy.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, configOf, decide, policyOf, restricts, sameTool, verdict } from '../../packages/tool-policy/index.js'
import { permissionLines } from '../commands/permissions.mjs'
import { renderPatch } from '../finess.mjs'
import { activePolicy, describePersona, loadPersonas, toolPolicyLines, writePersonaOverlay } from '../lib/personas.mjs'

const REVIEWER = { persona: 'reviewer', allow: ['read', 'grep', 'glob', 'bash'], deny: ['write', 'edit'] }
const ROW = { id: 'finess-tool-policy', package: '@finess/tool-policy', path: 'packages/tool-policy', enabled: true }

/** A fake registrant: records listeners, runs one with a `next` that reports whether it was called. */
function fakeCtx() {
  const on = new Map()
  return {
    on: (event, fn) => on.set(event, fn),
    on_: on,
    async call(name) {
      let nexted = false
      const d = await on.get('tools/pre-execute')({ callId: 'c', name, arguments: {}, agent: {} }, async () => { nexted = true; return { kind: 'allow' } })
      return { d, nexted }
    },
  }
}

test('policyOf: junk and absent config is an unrestricted policy', () => {
  for (const c of [undefined, null, 'x', {}, { allow: 'read', deny: [1, ''], approval: { a: 'maybe' } }]) {
    const p = policyOf(c)
    assert.deepEqual([p.allow, p.deny, p.approval, p.broken], [[], [], {}, undefined])
    assert.equal(restricts(p), false)
  }
  assert.equal(policyOf({}).persona, 'unknown')
})

test('decide: deny gives the model-readable reason, never reaching allow', () => {
  const d = decide(policyOf(REVIEWER), 'write')
  assert.equal(d.kind, 'deny')
  assert.match(d.reason, /^tool write is not allowed for persona reviewer/)
  assert.equal(decide(policyOf({ ...REVIEWER, allow: ['write'] }), 'write').kind, 'deny', 'deny wins over allow')
})

test('decide: a non-empty allow blocks everything else; empty allow allows all but deny', () => {
  const p = policyOf(REVIEWER)
  assert.deepEqual(decide(p, 'read'), { kind: 'allow' })
  const d = decide(p, 'web_fetch')
  assert.equal(d.kind, 'deny')
  assert.match(d.reason, /tool web_fetch is not allowed for persona reviewer \(it allows only read, grep, glob, bash\)/)
  const open = policyOf({ persona: 'x', deny: ['write'] })
  assert.equal(decide(open, 'web_fetch').kind, 'allow')
  assert.equal(decide(open, 'write').kind, 'deny')
})

test('decide: bash and pwsh are one shell, so a policy reads the same on macOS and Windows', () => {
  assert.ok(sameTool('bash', 'pwsh') && !sameTool('bash', 'read'))
  assert.equal(decide(policyOf(REVIEWER), 'pwsh').kind, 'allow')
  assert.equal(decide(policyOf({ persona: 'x', deny: ['pwsh'] }), 'bash').kind, 'deny')
})

test('decide: approval ask asks, approval deny refuses, approval allow never beats deny', () => {
  const p = policyOf({ persona: 'x', deny: ['rm'], approval: { write: 'ask', net: 'deny', rm: 'allow' } })
  assert.deepEqual(decide(p, 'write'), { kind: 'ask', reason: 'tool write needs approval for persona x' })
  assert.equal(decide(p, 'net').kind, 'deny')
  assert.equal(decide(p, 'rm').kind, 'deny')
  assert.equal(decide(policyOf({ persona: 'x', allow: ['read'], approval: { write: 'ask' } }), 'write').kind, 'deny', 'not in allow beats ask')
  assert.deepEqual(['write', 'net', 'read'].map(t => verdict(p, t)), ['ask', 'denied', 'allowed'])
})

test('decide: a broken persona fails closed to read-only tools, naming the file', () => {
  const p = policyOf({ persona: 'r', broken: 'personas/r.json' })
  assert.equal(restricts(p), true)
  assert.equal(decide(p, 'read').kind, 'allow')
  assert.match(decide(p, 'bash').reason, /personas\/r\.json failed to load/)
})

test('apply: a denied call returns the deny without calling next; an allowed one calls next', async () => {
  const ctx = fakeCtx()
  apply(ctx, REVIEWER)
  const denied = await ctx.call('edit')
  assert.equal(denied.nexted, false)
  assert.equal(denied.d.kind, 'deny')
  assert.match(denied.d.reason, /tool edit is not allowed for persona reviewer/)
  const allowed = await ctx.call('grep')
  assert.equal(allowed.nexted, true)
  assert.deepEqual(allowed.d, { kind: 'allow' })
})

test('apply: an empty policy mounts no listener', () => {
  const ctx = fakeCtx()
  apply(ctx, undefined)
  apply(ctx, { persona: 'g', allow: [], deny: [], approval: {} })
  assert.equal(ctx.on_.size, 0)
})

test('configOf round-trips through policyOf; a broken persona carries its source', () => {
  const p = { id: 'reviewer', tools: { allow: ['read'], deny: ['write'], approval: { bash: 'ask' } } }
  assert.deepEqual(policyOf(configOf(p)), { persona: 'reviewer', allow: ['read'], deny: ['write'], approval: { bash: 'ask' } })
  assert.equal(configOf({ id: 'b', broken: 'bad json', source: 'personas/b.json' }).broken, 'personas/b.json')
})

const cfgWith = (plugins, tools = { allow: ['read'], deny: ['write'] }) => ({
  profile: { name: 'policy-test', template: 'headless' },
  model: { route: 'local', id: 'small', source: 'hf.co/org/small:Q8_0', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'LOCAL_KEY' },
  extraRoutes: {},
  activeRoute: '',
  personas: { active: 'policy-test-p', definitions: { 'policy-test-p': { prefix: 'P', suffix: 'S', tools } } },
  settings: { plugins, toolsMode: 'native' },
  tips: [],
})

test('renderPatch: the active persona policy reaches the plugin row, only when the row is configured', () => {
  const patch = renderPatch(cfgWith([ROW]), { surface: 'headless', state: {} })
  assert.match(patch, /- id: finess-tool-policy\n {2}config:\n {4}persona: "policy-test-p"\n {4}allow: \["read"\]\n {4}deny: \["write"\]\n {4}approval: \{\}\n/)
  assert.match(patch, /- id: finess-tool-policy\n {6}name: '@finess\/tool-policy'/)
  assert.doesNotMatch(renderPatch(cfgWith([]), { surface: 'headless', state: {} }), /finess-tool-policy/)
  assert.doesNotMatch(renderPatch(cfgWith([{ ...ROW, surfaces: ['web'] }]), { surface: 'headless', state: {} }), /- id: finess-tool-policy\n {2}config/)
})

test('writePersonaOverlay: restates the policy, even an empty one, so the profile persona never leaks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finess-policy-'))
  try {
    const cfg = cfgWith([ROW])
    const reviewer = { ...loadPersonas(cfg).get('policy-test-p'), id: 'reviewer', tools: { allow: ['read'], deny: ['write', 'edit'], approval: {} } }
    const text = readFileSync(writePersonaOverlay(reviewer, cfg, join(dir, 'r.patch.yml')), 'utf8')
    assert.match(text, /- id: finess-tool-policy\n {2}config:\n {4}persona: "reviewer"\n {4}allow: \["read"\]\n {4}deny: \["write","edit"\]\n/)
    const open = { ...reviewer, id: 'g', tools: { allow: [], deny: [], approval: {} } }
    assert.match(readFileSync(writePersonaOverlay(open, cfg, join(dir, 'g.patch.yml')), 'utf8'), /allow: \[\]\n {4}deny: \[\]/)
    assert.equal(toolPolicyLines(open, cfgWith([])).length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('activePolicy, /permissions and describePersona say [enforced] for tools', () => {
  const cfg = cfgWith([ROW], { allow: ['read'], deny: ['write'], approval: { bash: 'ask' } })
  const dir = mkdtempSync(join(tmpdir(), 'finess-policy-'))
  try {
    const active = activePolicy(cfg, { state: {}, dir })
    assert.equal(active.id, 'policy-test-p')
    assert.equal(verdict(active.policy, 'write'), 'denied')
    const lines = permissionLines(active, '0.0.1')
    assert.ok(lines.some(l => l.includes('[enforced]')))
    assert.ok(lines.some(l => l === 'approval: bash=ask'))
    assert.ok(permissionLines({ ...active, row: undefined }, '0.0.1').some(l => l.includes('nothing is enforced')))
    assert.ok(describePersona(active.persona).some(l => /tools: .*\[enforced\]$/.test(l)))
    assert.ok(activePolicy(cfgWith([ROW]), { state: { persona: 'nope' }, dir }).policy.broken !== undefined, 'a missing persona fails closed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('capability aliases match their substrate tools, and harness tools pass an allow list', () => {
  const p = policyOf({ persona: 'ds', allow: ['read', 'artifact.create', 'web.fetch', 'shell.execute'], deny: ['web.search'] })
  assert.equal(decide(p, 'write').kind, 'allow', 'artifact.create means write')
  assert.equal(decide(p, 'web_fetch').kind, 'allow', 'web.fetch means web_fetch')
  assert.equal(decide(p, 'pwsh').kind, 'allow', 'shell.execute means the shell')
  assert.equal(decide(p, 'web_search').kind, 'deny', 'a denied alias still denies')
  assert.equal(decide(p, 'edit').kind, 'deny', 'not allowed, not harness')
  assert.equal(decide(p, 'todo_write').kind, 'allow', 'planning is a harness tool')
  assert.equal(decide(p, 'subagent').kind, 'deny', 'delegation stays under the allow list')
  assert.equal(decide(policyOf({ persona: 'x', allow: ['read'], deny: ['todo_write'] }), 'todo_write').kind, 'deny', 'deny by name still wins over harness')
})
