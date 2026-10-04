/**
 * @finess/thoughts T-285 (frozen constraint baseline), T-286 (compaction digest) and T-289
 * (explicit subagent seeding): the `thoughtsContext` projection and its `agent/pre-step` /
 * `tools/pre-execute` listeners, mounted on a fake ctx with a fake waterfall. No dsh needed.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderDigest } from '../../packages/thoughts/src/compact.js'
import { CONTEXT_KEY, CONTEXT_STATE_VERSION, SOURCE_KIND, contextSchema, foldContext, initContext } from '../../packages/thoughts/src/context.js'
import { stubOf } from '../../packages/thoughts/src/evict.js'
import { foldEvents, nodeRecord } from '../../packages/thoughts/src/fold.js'
import { BASELINE_MAX_BYTES, BASELINE_MAX_NODES, renderBaseline } from '../../packages/thoughts/src/inject.js'
import { mount } from '../../packages/thoughts/src/plugin.js'
import { addPersistent, projectKey, promote } from '../../packages/thoughts/src/store.js'
import { isChildSession, parseSeedIds, seedStash } from '../../packages/thoughts/src/subagent.js'

const AT = '2026-10-04T09:00:00.000Z'
const CWD = 'C:\\Proj'
const node = (id, extra = {}) => ({ id, scope: id.startsWith('p') ? 'persistent' : 'ephemeral', kind: 'finding', claim: `Claim ${id} holds.`, evidence: [], confidence: 'asserted', derivedFrom: [], turn: 1, at: AT, ...extra })
const userMsg = (text, kind = 'user') => ({ id: `m-${text.length}-${Math.random()}`, role: 'user', content: [{ type: 'text', text }], source: { kind } })
const result = n => ({ type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', isError: false, content: [] }, meta: nodeRecord(n) } })
const textOf = m => m.content.map(b => b.text).join('\n')

/** Fake registrant ctx: projections by key (stateOf folds the session log), listeners per event, an in-memory storage domain. */
function fakeCtx() {
  const tools = new Map()
  const defs = new Map()
  const on = new Map()
  const data = new Map()
  const ctx = {
    storageDomain: { open: async () => ({ table: () => ({ get: k => data.get(k), put: async (k, v) => { data.set(k, structuredClone(v)) } }), close: async () => {} }) },
    sessionProjections: {
      register: d => { defs.set(d.key, d) },
      stateOf: (session, key) => { const d = defs.get(key); return d === undefined ? undefined : session.events.reduce(d.apply, d.init()) },
    },
    tools: { register: t => { tools.set(t.name, t) } },
    on: (name, fn) => { on.set(name, [...(on.get(name) ?? []), fn]) },
  }
  const { store, stash } = mount(ctx, { defineTool: o => o, now: () => new Date(AT) })
  return { ctx, tools, defs, on, store, stash }
}

/** Run a waterfall: listeners in registration order, `base` at the bottom. */
function waterfall(listeners, payload, base) {
  const run = i => (i < listeners.length ? listeners[i](payload, () => run(i + 1)) : base())
  return run(0)
}

const session = (header = {}) => ({ header: { id: 'session-1', cwd: CWD, ...header }, events: [], snapshotEvents() { return this.events } })

/**
 * One step the way the loop runs it: claim, pre-step waterfall, then commit `step/start` and the
 * entered messages. `before` are extra listeners ahead of ours (e.g. compaction), `after` behind.
 */
async function step(f, s, claimedTexts, { stepNo = 1, before = [], after = [], base } = {}) {
  const claimed = claimedTexts.map(t => userMsg(t))
  const decision = await waterfall([...before, ...f.on.get('agent/pre-step'), ...after], { agent: { session: s }, messages: claimed, turn: 1, step: stepNo, signal: new AbortController().signal }, base ?? (async () => ({ kind: 'enter', messages: claimed })))
  if (decision.kind !== 'enter') return { decision, added: [] }
  if (decision.messages.length > 0) s.events.push({ type: 'step/start', data: { turn: 1, step: stepNo } })
  for (const m of decision.messages) s.events.push({ type: 'user/message', data: m })
  return { decision, added: decision.messages.filter(m => m.source.kind === SOURCE_KIND) }
}

const addConstraint = (f, claim) => f.store.mutate(projectKey(CWD), r => addPersistent(r, { kind: 'constraint', claim }, { at: AT, origin: { by: 'operator' } }))

// ---------------------------------------------------------------- projection

test('the context projection is registered, versioned, and its fold ignores foreign events by reference', () => {
  const f = fakeCtx()
  const d = f.defs.get(CONTEXT_KEY)
  assert.equal(d.stateVersion, CONTEXT_STATE_VERSION)
  const s = initContext()
  for (const e of [{ type: 'assistant/message', data: {} }, { type: 'user/message', data: { source: { kind: 'user' } } }, { type: 'user/message', data: { source: { kind: SOURCE_KIND, part: 'nope' } } }]) assert.equal(foldContext(s, e), s)
  const started = foldContext(s, { type: 'step/start', data: {} })
  assert.equal(foldContext(started, { type: 'step/start', data: {} }), started)
  assert.deepEqual(contextSchema.parse(JSON.parse(JSON.stringify(started))), started)
  assert.throws(() => contextSchema.parse({ ...started, v: 99 }))
})

// ---------------------------------------------------------------- T-285

test('T-285: the first step of a top-level session gets the constraints once, after the claimed prompt, and they stay frozen', async () => {
  const f = fakeCtx()
  await addConstraint(f, 'Never edit the upstream cache.')
  await f.store.mutate(projectKey(CWD), r => addPersistent(r, { kind: 'finding', claim: 'The build is green.' }, { at: AT, origin: { by: 'operator' } }))
  await addConstraint(f, 'Use Node scripts, never shell.')
  const s = session()
  const one = await step(f, s, ['do the thing'])
  assert.equal(one.added.length, 1)
  assert.equal(textOf(one.decision.messages[0]), 'do the thing', 'the prompt stays first')
  assert.deepEqual(one.added[0].source, { kind: SOURCE_KIND, form: 'instructions', part: 'constraints', ids: ['p-1', 'p-3'] })
  assert.match(textOf(one.added[0]), /p-1: Never edit the upstream cache\.\n- p-3: Use Node scripts/)
  assert.doesNotMatch(textOf(one.added[0]), /build is green/)
  await addConstraint(f, 'A constraint added mid-session.')
  assert.equal((await step(f, s, [], { stepNo: 2 })).added.length, 0, 'store changes do not reach this session')
  assert.equal((await step(f, s, ['next prompt'])).added.length, 0, 'a new task does not re-inject')
  // Resume: a fresh process with the same log injects nothing again.
  const g = fakeCtx()
  await addConstraint(g, 'Never edit the upstream cache.')
  assert.equal((await step(g, s, ['resumed'])).added.length, 0)
  assert.equal((await step(g, session(), ['fresh'])).added.length, 1, 'while a new session does get them')
})

test('T-285: a session that starts without constraints gets none later; reject and empty first steps are untouched', async () => {
  const f = fakeCtx()
  const s = session()
  const rejected = await step(f, s, ['x'], { base: async () => ({ kind: 'reject' }) })
  assert.deepEqual(rejected.decision, { kind: 'reject' })
  await addConstraint(f, 'Never edit the upstream cache.')
  const empty = await step(f, s, [])
  assert.deepEqual(empty.decision.messages, [], 'an empty first step stays empty')
  const s2 = session()
  assert.equal((await step(fakeCtx(), s2, ['go'])).added.length, 0, 'empty store: nothing')
  const g = fakeCtx()
  await g.store.mutate(projectKey(CWD), r => addPersistent(r, { kind: 'constraint', claim: 'Late rule.' }, { at: AT, origin: { by: 'operator' } }))
  assert.equal((await step(g, s2, ['again'], { stepNo: 2 })).added.length, 0, 'the window closed with the first step')
})

test('T-285: the baseline is capped in count and bytes, counts what it left out, and skips stubs', () => {
  const many = Array.from({ length: 40 }, (_, i) => node(`p-${i + 1}`, { kind: 'constraint', claim: `Constraint number ${i + 1} keeps the build reproducible across both platforms.` }))
  const b = renderBaseline(many)
  assert.ok(b.ids.length <= BASELINE_MAX_NODES)
  assert.ok(Buffer.byteLength(b.text, 'utf8') <= BASELINE_MAX_BYTES)
  assert.match(b.text, new RegExp(`\\(${40 - b.ids.length} more constraints`))
  assert.equal(renderBaseline(many, { maxNodes: 2 }).ids.length, 2)
  let r = promote({ nextId: 1, nodes: [] }, node('n-1', { kind: 'constraint', claim: 'A promoted rule.' }), { at: AT, origin: { by: 'operator', session: 'session-0' } }).record
  r = { ...r, nodes: [stubOf(r.nodes[0])] }
  assert.equal(renderBaseline(r.nodes.map(x => x.node)), undefined)
  assert.equal(renderBaseline([]), undefined)
})

// ---------------------------------------------------------------- T-286

/** A fake compaction listener that compacts (logs a summary) inside the waterfall, like compaction-basic. */
const compactor = s => async (_p, next) => { s.events.push({ type: 'compaction/summary', data: { summary: [] } }); return next() }

test('T-286: after a compaction the task\'s findings and decisions, and the frozen constraints, enter once', async () => {
  const f = fakeCtx()
  await addConstraint(f, 'Never edit the upstream cache.')
  const s = session()
  const first = await step(f, s, ['task'])
  const frozen = textOf(first.added[0])
  s.events.push(result(node('n-1')), result(node('n-2', { kind: 'attempt', claim: 'Tried the cache flag.' })), result(node('n-3', { kind: 'decision', claim: 'Pin the cache.', derivedFrom: ['n-1'] })))
  assert.equal((await step(f, s, [], { stepNo: 2 })).added.length, 0, 'no compaction, no digest')
  s.events.push({ type: 'compaction/prune', data: {} })
  assert.equal((await step(f, s, [], { stepNo: 3 })).added.length, 0, 'a prune is not a compaction')
  const d = await step(f, s, [], { stepNo: 4, before: [compactor(s)] })
  assert.equal(d.added.length, 1)
  const t = textOf(d.added[0])
  assert.ok(t.includes(frozen), 'the frozen block is repeated verbatim')
  assert.match(t, /n-3 \[decision, asserted\] Pin the cache\. \(from n-1\)\n- n-1 \[finding/)
  assert.doesNotMatch(t, /Tried the cache flag/)
  assert.deepEqual([d.added[0].source.part, d.added[0].source.compaction, d.added[0].source.ids], ['digest', 1, ['n-3', 'n-1']])
  assert.equal((await step(f, s, [], { stepNo: 5 })).added.length, 0, 'answered once')
  const again = await step(f, s, [], { stepNo: 6, after: [compactor(s)] })
  assert.equal(again.added[0]?.source.compaction, 2, 'seen after next() whatever the listener order')
})

test('T-286: renderDigest keeps the newest nodes under its caps and is empty when there is nothing to carry', () => {
  const nodes = Array.from({ length: 60 }, (_, i) => node(`n-${i + 1}`, { claim: `Finding ${i + 1} about the reproducible build on both platforms.` }))
  const d = renderDigest(nodes, undefined)
  assert.equal(d.ids[0], 'n-60')
  assert.ok(d.ids.length <= 24)
  assert.match(d.text, /older: think_search/)
  assert.equal(renderDigest([node('n-1', { kind: 'attempt' })], undefined), undefined)
  assert.match(renderDigest([], 'FROZEN').text, /FROZEN/)
})

// ---------------------------------------------------------------- T-289

test('T-289: the parent names nodes in the prompt; unknown or malformed ids are denied; allowed seeds are stashed', async () => {
  const f = fakeCtx()
  await f.store.mutate(projectKey(CWD), r => addPersistent(r, { kind: 'constraint', claim: 'Never edit the upstream cache.' }, { at: AT, origin: { by: 'operator' } }))
  const parent = session()
  parent.events.push({ type: 'user/message', data: userMsg('task') }, result(node('n-1')), result(node('n-2')))
  const pre = (name, prompt, next = async () => ({ kind: 'allow' })) => waterfall(f.on.get('tools/pre-execute'), { name, arguments: { prompt, description: 'd' }, agent: { session: parent } }, next)
  assert.deepEqual(parseSeedIds('see [thoughts: n-1, p-1] and [thought: n-1 x]'), { ids: ['n-1', 'p-1'], bad: ['x'] })
  assert.deepEqual(await pre('subagent', 'no marker here'), { kind: 'allow' })
  assert.deepEqual(await pre('bash', '[thoughts: n-9]'), { kind: 'allow' }, 'other tools are not inspected')
  const unknown = await pre('subagent', 'go [thoughts: n-1 n-9]')
  assert.equal(unknown.kind, 'deny')
  assert.match(unknown.reason, /unknown nodes: n-9 \(known: n-1, n-2, p-1/)
  assert.match((await pre('subagent', '[thoughts: banana]')).reason, /not ids: banana/)
  assert.deepEqual(await pre('subagent', 'denied later [thoughts: n-1]', async () => ({ kind: 'deny', reason: 'policy' })), { kind: 'deny', reason: 'policy' })
  assert.equal(f.stash.size(), 0, 'a call denied downstream stashes nothing')
  assert.deepEqual(await pre('subagent', 'Check the cache [thoughts: n-2 p-1]'), { kind: 'allow' })
  assert.equal(f.stash.size(), 1)
})

test('T-289: a child gets exactly the passed nodes, once, sees no persistent store, and numbers its own nodes above them', async () => {
  const f = fakeCtx()
  await f.store.mutate(projectKey(CWD), r => addPersistent(r, { kind: 'constraint', claim: 'Never edit the upstream cache.' }, { at: AT, origin: { by: 'operator' } }))
  await f.store.mutate(projectKey(CWD), r => addPersistent(r, { kind: 'finding', claim: 'A secret persistent fact.' }, { at: AT, origin: { by: 'operator' } }))
  const parent = session()
  parent.events.push({ type: 'user/message', data: userMsg('task') }, result(node('n-1')), result(node('n-2', { claim: 'The cache is stale.' })))
  const prompt = 'Check the cache [thoughts: n-2 p-1]'
  await waterfall(f.on.get('tools/pre-execute'), { name: 'subagent', arguments: { prompt }, agent: { session: parent } }, async () => ({ kind: 'allow' }))
  const child = session({ id: 'session-c', origin: 'subagent', delegationDepth: 1 })
  child.events.push({ type: 'turn/start', data: { turn: 1 } })
  const first = await step(f, child, [prompt])
  assert.equal(first.added.length, 1, 'seed only: no constraint baseline for a child')
  assert.equal(first.added[0].source.part, 'seed')
  assert.deepEqual(first.added[0].source.ids, ['n-2', 'p-1'])
  assert.match(textOf(first.added[0]), /n-2 \[finding, asserted\] The cache is stale\.\n- p-1 \[constraint/)
  const exec = { agent: { session: child } }
  const seen = await f.tools.get('think_search').execute({ query: '' }, exec)
  assert.deepEqual(seen.hits.map(n => n.id).sort(), ['n-2', 'p-1'], 'own + seeds, not the store')
  await assert.rejects(f.tools.get('think_open').execute({ id: 'p-2' }, exec), /no node p-2/)
  const mine = await f.tools.get('think_add').execute({ kind: 'decision', claim: 'Rebuild the cache.', derivedFrom: ['n-2', 'p-1'] }, exec)
  assert.equal(mine.node.id, 'n-3', 'above the seeded n-2')
  const twin = session({ id: 'session-d', origin: 'subagent' })
  assert.equal((await step(f, twin, [prompt])).added.length, 0, 'a stash entry is consumed once')
})

test('T-289: a fork child folds its inherited thought records away at the tagged cut only', () => {
  const inherited = [{ type: 'user/message', data: { source: { kind: 'user' } } }, result(node('n-1')), result(node('n-2'))]
  assert.deepEqual(foldEvents([...inherited, { type: 'session/end-seed', data: {} }]).nodes.map(n => n.id), ['n-1', 'n-2'])
  const forked = foldEvents([...inherited, { type: 'session/end-seed', data: { inherited: true } }])
  assert.deepEqual([forked.nodes, forked.nextId], [[], 1])
  assert.equal(isChildSession({ origin: 'subagent' }), true)
  assert.equal(isChildSession({ delegationDepth: 2 }), true)
  assert.equal(isChildSession({ isSeeded: true }), false, 'a user fork is not a child')
  assert.equal(isChildSession(undefined), false)
})

test('the seed stash is bounded and consume-once', () => {
  const st = seedStash(2)
  st.put('a', { nodes: [], text: 'A' })
  st.put('b', { nodes: [], text: 'B' })
  st.put('c', { nodes: [], text: 'C' })
  assert.equal(st.size(), 2)
  assert.equal(st.take(['xx a yy']), undefined, 'the oldest was dropped')
  assert.equal(st.take(['prompt c']).text, 'C')
  assert.equal(st.take(['prompt c']), undefined)
})
