/**
 * @finess/thoughts (T-280..T-284): schema, fold, search, the pure store, both IO adapters, and the
 * plugin mounted on a fake ctx. Temp dirs only; no dsh needed (src/ never imports the substrate).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { domainStore, fileStore, readUnit, storeFile, writeUnit } from '../../packages/thoughts/src/adapters.js'
import { MAX_EPHEMERAL_NODES, PROJECTION_KEY, STATE_VERSION, foldEvents, foldThought, initState, isTaskStart, nodeRecord, recordOf, stateSchema } from '../../packages/thoughts/src/fold.js'
import { mount } from '../../packages/thoughts/src/plugin.js'
import { MAX_CLAIM_CHARS, buildNode, claimProblem, validateThoughtNode } from '../../packages/thoughts/src/schema.js'
import { searchNodes, subgraph } from '../../packages/thoughts/src/search.js'
import { DOMAIN_NAME, DOMAIN_SPEC, ThoughtStoreFullError, addPersistent, emptyProject, forget, link, parseProject, projectKey, promote, recordBytes, verifyStored } from '../../packages/thoughts/src/store.js'

const AT = '2026-10-03T12:00:00.000Z'
const node = (id, extra = {}) => ({ id, scope: id.startsWith('p') ? 'persistent' : 'ephemeral', kind: 'finding', claim: `Claim ${id} holds.`, evidence: [], confidence: 'asserted', derivedFrom: [], turn: 1, at: AT, ...extra })
const human = text => ({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const result = (n, extra = {}) => ({ type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', isError: false, content: [] }, meta: nodeRecord(n), ...extra } })
const tmp = () => mkdtempSync(join(tmpdir(), 'finess-thoughts-'))

// ---------------------------------------------------------------- schema (T-281)

test('a complete node validates and its claim is trimmed', () => {
  const r = validateThoughtNode(node('n-1', { claim: '  The id has the session- prefix.  ', evidence: ['README:54'], confidence: 'verified', derivedFrom: ['n-2'] }))
  assert.equal(r.ok, true)
  assert.equal(r.value.claim, 'The id has the session- prefix.')
})

test('the claim is one sentence of at most 200 characters', () => {
  assert.equal(claimProblem('x'.repeat(MAX_CLAIM_CHARS)), undefined)
  assert.match(claimProblem('x'.repeat(MAX_CLAIM_CHARS + 1)), /exceeds the limit of 200/)
  assert.match(claimProblem('One thing. Another thing.'), /one sentence/)
  assert.match(claimProblem('line one\nline two'), /line breaks/)
  assert.match(claimProblem('   '), /non-empty/)
  assert.equal(claimProblem('Use e.g. the cache, version 1.2 works.'), undefined)
})

test('the validator refuses each malformed field, with its path', () => {
  const paths = v => (validateThoughtNode(v).ok ? [] : validateThoughtNode(v).errors.map(e => e.path.join('.')))
  assert.deepEqual(paths(node('x-1')), ['id'])
  assert.deepEqual(paths(node('p-1', { scope: 'ephemeral' })), ['id'])
  assert.deepEqual(paths(node('n-1', { kind: 'guess' })), ['kind'])
  assert.deepEqual(paths(node('n-1', { confidence: 'verified' })), ['confidence'])
  assert.deepEqual(paths(node('n-1', { derivedFrom: ['n-1'] })), ['derivedFrom.0'])
  assert.deepEqual(paths(node('n-1', { evidence: ['a', 'a'] })), ['evidence.1'])
  assert.deepEqual(paths(node('n-1', { turn: -1, at: 'yesterday' })), ['turn', 'at'])
  assert.deepEqual(paths({ ...node('n-1'), extra: 1 }), ['extra'])
  assert.equal(validateThoughtNode([]).ok, false)
})

test('buildNode stamps writer fields and refuses them from the writer', () => {
  const r = buildNode({ kind: 'decision', claim: 'Use one generic event.' }, { id: 'n-4', scope: 'ephemeral', turn: 2, at: AT })
  assert.deepEqual(r.value, { id: 'n-4', scope: 'ephemeral', kind: 'decision', claim: 'Use one generic event.', evidence: [], confidence: 'asserted', derivedFrom: [], turn: 2, at: AT })
  assert.equal(buildNode({ kind: 'decision', claim: 'x', id: 'n-9' }, { id: 'n-4', scope: 'ephemeral', turn: 2, at: AT }).ok, false)
})

// ---------------------------------------------------------------- fold (T-280)

test('the fold collects thought/node records and folds to empty on a human prompt', () => {
  const s = foldEvents([human('task one'), { type: 'turn/start', data: { turn: 3 } }, result(node('n-1')), result(node('n-2', { derivedFrom: ['n-1'] }))])
  assert.equal(s.task, 1)
  assert.equal(s.turn, 3)
  assert.deepEqual(s.nodes.map(n => n.id), ['n-1', 'n-2'])
  assert.equal(s.nextId, 3)
  const next = foldThought(s, human('task two'))
  assert.deepEqual([next.task, next.nodes.length, next.nextId], [2, 0, 1])
})

test('the fold returns the same reference for every event it ignores', () => {
  const s = foldEvents([human('t'), result(node('n-1'))])
  for (const e of [
    { type: 'assistant/message', data: {} },
    { type: 'user/message', data: { source: { kind: 'runtime-context' } } },
    { type: 'tool/result', data: { meta: { operation: 'create' } } },
    result(node('n-1')),
    result(node('n-5'), { message: { isError: true } }),
    result(node('p-1')),
    result({ ...node('n-6'), claim: 'Too. Many.' }),
    { type: 'turn/start', data: { turn: s.turn } },
  ]) assert.equal(foldThought(s, e), s, JSON.stringify(e).slice(0, 80))
})

test('recordOf and isTaskStart read decoded JSONL shapes', () => {
  assert.equal(recordOf(result(node('n-1'))).id, 'n-1')
  assert.equal(recordOf({ type: 'tool/result', data: { meta: { kind: 'thought/node', v: 2, node: node('n-1') } } }), undefined)
  assert.equal(isTaskStart(human('x')), true)
  assert.equal(isTaskStart({ type: 'user/message', data: { source: { kind: 'goal' } } }), false)
})

test('stateSchema round-trips a folded state and refuses others', () => {
  const s = foldEvents([human('t'), result(node('n-1'))])
  assert.deepEqual(stateSchema.parse(JSON.parse(JSON.stringify(s))), s)
  assert.deepEqual(stateSchema.parse(initState()), initState())
  assert.throws(() => stateSchema.parse({ ...s, v: 2 }))
  assert.throws(() => stateSchema.parse({ ...s, nodes: [{}] }))
})

// ---------------------------------------------------------------- search

test('searchNodes ranks claim matches over evidence matches and filters', () => {
  const ns = [node('n-1', { claim: 'The cache is cold.' }), node('n-2', { claim: 'Tests pass.', evidence: ['cache warmed'] }), node('p-1', { kind: 'constraint', claim: 'Never touch the cache dir.' })]
  assert.deepEqual(searchNodes(ns, 'cache').map(h => h.node.id), ['p-1', 'n-1', 'n-2'])
  assert.deepEqual(searchNodes(ns, 'cache', { scope: 'ephemeral' }).map(h => h.node.id), ['n-1', 'n-2'])
  assert.deepEqual(searchNodes(ns, 'cache', { kind: 'constraint' }).map(h => h.node.id), ['p-1'])
  assert.equal(searchNodes(ns, 'nothing').length, 0)
  assert.equal(searchNodes(ns, '', { limit: 2 }).length, 2)
})

test('subgraph follows derivedFrom to a depth and reports missing ids', () => {
  const ns = [node('n-1'), node('n-2', { derivedFrom: ['n-1'] }), node('n-3', { derivedFrom: ['n-2', 'n-9'] })]
  assert.deepEqual(subgraph(ns, 'n-3', 1).related.map(n => n.id), ['n-2'])
  assert.deepEqual(subgraph(ns, 'n-3', 2).related.map(n => n.id), ['n-2', 'n-1'])
  assert.deepEqual(subgraph(ns, 'n-3', 1).missing, ['n-9'])
  assert.equal(subgraph(ns, 'n-7').root, undefined)
})

// ---------------------------------------------------------------- store (T-284)

test('projectKey normalises separators and drive-letter case only', () => {
  assert.equal(projectKey('C:\\Work\\App\\'), 'c:/work/app')
  assert.equal(projectKey('c:/work/app'), 'c:/work/app')
  assert.equal(projectKey('/Users/Me/App/'), '/Users/Me/App')
})

test('add, link, forget and promote keep ids monotonic and edges consistent', () => {
  const origin = { by: 'operator' }
  let r = emptyProject()
  const a = addPersistent(r, { kind: 'constraint', claim: 'Never edit upstream.' }, { at: AT, origin })
  r = a.record
  const b = addPersistent(r, { kind: 'finding', claim: 'Upstream is pinned.', derivedFrom: ['p-1'] }, { at: AT, origin })
  r = b.record
  assert.deepEqual([a.node.id, b.node.id, r.nextId], ['p-1', 'p-2', 3])
  assert.throws(() => addPersistent(r, { kind: 'finding', claim: 'X is y.', derivedFrom: ['p-9'] }, { at: AT, origin }), /not in the persistent store/)
  assert.throws(() => link(r, 'p-2', 'p-1'), /already derives/)
  r = link(r, 'p-1', 'p-2')
  r = forget(r, 'p-2')
  assert.deepEqual(r.nodes.map(s => [s.node.id, s.node.derivedFrom]), [['p-1', []]])
  const p = promote(r, node('n-4', { derivedFrom: ['n-1', 'p-1'] }), { at: AT, origin: { by: 'operator', session: 's1' } })
  assert.equal(p.node.id, 'p-3')
  assert.deepEqual(p.node.derivedFrom, ['p-1'])
  assert.equal(p.record.nodes[1].origin.from, 'n-4')
  assert.throws(() => promote(p.record, node('n-4', { derivedFrom: ['n-1', 'p-1'] }), { at: AT, origin: { by: 'operator', session: 's1' } }), /already promoted/)
  assert.throws(() => promote(r, node('p-1'), { at: AT, origin }), /already persistent/)
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify(p.record))), p.record)
})

test('a full store throws ThoughtStoreFullError and changes nothing', () => {
  const r = addPersistent(emptyProject(), { kind: 'finding', claim: 'One small fact.' }, { at: AT, origin: { by: 'operator' } }).record
  const cap = recordBytes(r) + 10
  assert.throws(() => addPersistent(r, { kind: 'finding', claim: 'Another fact that does not fit.' }, { at: AT, origin: { by: 'operator' }, cap }), e => e instanceof ThoughtStoreFullError && e.code === 'THOUGHTS_FULL' && e.cap === cap)
  assert.equal(r.nodes.length, 1)
})

test('verifyStored refuses a missing or altered node', () => {
  const { record, node: n } = addPersistent(emptyProject(), { kind: 'finding', claim: 'A fact.' }, { at: AT, origin: { by: 'operator' } })
  verifyStored(record, n)
  assert.throws(() => verifyStored(emptyProject(), n), /did not verify/)
  assert.throws(() => verifyStored(record, { ...n, claim: 'Other.' }), /did not verify/)
})

test('DOMAIN_SPEC is a valid storage-domain declaration', () => {
  assert.match(DOMAIN_SPEC.name, /^[a-z][a-z0-9_]*$/)
  assert.equal(typeof DOMAIN_SPEC.tables.projects.valueSchema.parse, 'function')
})

// ---------------------------------------------------------------- file adapter

test('fileStore writes storage-json single-layout documents and re-reads them', () => {
  const dir = tmp()
  try {
    const file = storeFile(dir)
    assert.equal(file, join(dir, 'storages', `${DOMAIN_NAME}.json`))
    const s = fileStore(file)
    assert.deepEqual(s.read('c:/p'), emptyProject())
    const out = s.mutate('c:/p', r => addPersistent(r, { kind: 'finding', claim: 'Stored on disk.' }, { at: AT, origin: { by: 'operator' } }))
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(doc.unit, { name: DOMAIN_NAME, version: 1 })
    assert.equal(doc.global, null)
    assert.equal(doc.tables.projects['c:/p'].nodes[0].node.id, out.node.id)
    assert.equal(readUnit(file).size, 1)
    writeUnit(file, new Map([['c:/q', emptyProject()]]))
    assert.deepEqual([...readUnit(file).keys()], ['c:/q'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('readUnit refuses a foreign or newer unit', () => {
  const dir = tmp()
  try {
    const file = join(dir, 'u.json')
    const doc = unit => JSON.stringify({ unit, global: null, tables: {} })
    writeFileSync(file, doc({ name: 'other', version: 1 }))
    assert.throws(() => readUnit(file), /not a finess_thoughts unit/)
    writeFileSync(file, doc({ name: DOMAIN_NAME, version: 2 }))
    assert.throws(() => readUnit(file), /stored version 2/)
    writeFileSync(file, JSON.stringify({ unit: { name: DOMAIN_NAME, version: 1 }, global: null, tables: { projects: { 'c:/p': { nextId: 0, nodes: [] } } } }))
    assert.throws(() => readUnit(file), /malformed project record/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- domain adapter + plugin (fake ctx)

/** A fake ctx.storageDomain: one in-memory unit, refusing a second concurrent open like the real one. */
function fakeFacility() {
  const data = new Map()
  let open = false
  let opens = 0
  return {
    data,
    get opens() { return opens },
    async open(spec) {
      if (open) throw new Error(`domain '${spec.name}' is already open`)
      open = true
      opens++
      for (const v of data.values()) spec.tables.projects.valueSchema.parse(v)
      return {
        table: () => ({ get: k => data.get(k), put: async (k, v) => { data.set(k, JSON.parse(JSON.stringify(v))) } }),
        close: async () => { open = false },
      }
    },
  }
}

test('domainStore serialises open-per-operation and verifies writes', async () => {
  const f = fakeFacility()
  const s = domainStore(f)
  const writes = [1, 2, 3].map(i => s.mutate('c:/p', r => addPersistent(r, { kind: 'finding', claim: `Fact ${i}.` }, { at: AT, origin: { by: 'model' } })))
  const out = await Promise.all(writes)
  assert.deepEqual(out.map(o => o.node.id), ['p-1', 'p-2', 'p-3'])
  assert.equal((await s.read('c:/p')).nodes.length, 3)
  await assert.rejects(s.mutate('c:/p', r => ({ record: forget(r, 'p-9') })), /no persistent node/)
  assert.equal((await s.read('c:/p')).nodes.length, 3, 'a failed op leaves the chain usable')
})

/** A fake registrant ctx: captures the projection and tools; `stateOf` folds the given session. */
function fakeCtx() {
  const tools = new Map()
  let def
  const ctx = {
    storageDomain: fakeFacility(),
    sessionProjections: {
      register: d => { def = d },
      stateOf: (session, key) => (key === def.key ? session.events.reduce(def.apply, def.init()) : undefined),
    },
    tools: { register: t => { tools.set(t.name, t) } },
  }
  return { ctx, tools, def: () => def }
}

/** A fake session: an event list plus what the registry would append for a tool result. */
function fakeSession(cwd = 'C:\\Proj') {
  return { header: { id: 'session-1', cwd }, events: [human('go'), { type: 'turn/start', data: { turn: 1 } }], snapshotEvents() { return this.events } }
}

/** Run one tool call the way the registry does: execute, then append the result with its meta. */
async function call(tool, args, session, extra = {}) {
  const value = await tool.execute(args, { agent: { session }, ...extra })
  const meta = tool.output.presentationMeta?.(args, value)
  session.events.push({ type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', isError: false, content: tool.output.render(args, value) }, ...(meta === undefined ? {} : { meta }) } })
  return value
}

test('mount registers the versioned projection and the three snake_case tools', () => {
  const { ctx, tools, def } = fakeCtx()
  mount(ctx, { defineTool: o => o })
  assert.equal(def().key, PROJECTION_KEY)
  assert.equal(def().stateVersion, STATE_VERSION)
  assert.equal(def().stateSchema, stateSchema)
  assert.deepEqual([...tools.keys()], ['think_add', 'think_search', 'think_open'])
})

test('think_add records an ephemeral node the fold reads back; ids follow the log', async () => {
  const { ctx, tools } = fakeCtx()
  mount(ctx, { defineTool: o => o, now: () => new Date(AT) })
  const s = fakeSession()
  const a = await call(tools.get('think_add'), { kind: 'finding', claim: 'The prefix is kept.', evidence: ['README:54'], confidence: 'verified' }, s)
  const b = await call(tools.get('think_add'), { kind: 'decision', claim: 'Keep the prefix.', derivedFrom: ['n-1'] }, s)
  assert.deepEqual([a.node.id, b.node.id], ['n-1', 'n-2'])
  assert.equal(a.node.turn, 1)
  assert.deepEqual(foldEvents(s.events).nodes.map(n => n.id), ['n-1', 'n-2'])
  await assert.rejects(call(tools.get('think_add'), { kind: 'finding', claim: 'X is y.', derivedFrom: ['n-7'] }, s), /unknown nodes: n-7/)
  await assert.rejects(call(tools.get('think_add'), { kind: 'finding', claim: 'Two. Sentences.' }, s), /one sentence/)
  await assert.rejects(call(tools.get('think_add'), { kind: 'finding', claim: 'Nested.' }, s, { parent: 'tok' }), /called directly/)
  await assert.rejects(tools.get('think_add').execute({ kind: 'finding', claim: 'No agent.' }, {}), /owning agent session/)
})

test('think_add refuses past the per-task node cap instead of evicting', async () => {
  const { ctx, tools } = fakeCtx()
  mount(ctx, { defineTool: o => o, now: () => new Date(AT) })
  const s = fakeSession()
  for (let i = 1; i <= MAX_EPHEMERAL_NODES; i++) s.events.push(result(node(`n-${i}`)))
  await assert.rejects(call(tools.get('think_add'), { kind: 'finding', claim: 'One more.' }, s), /already holds 200 nodes/)
})

test('think_search and think_open see both tiers; a new task resets the ephemeral one', async () => {
  const { ctx, tools } = fakeCtx()
  const { store } = mount(ctx, { defineTool: o => o, now: () => new Date(AT) })
  await store.mutate(projectKey('C:\\Proj'), r => addPersistent(r, { kind: 'constraint', claim: 'Never edit the upstream cache.' }, { at: AT, origin: { by: 'operator' } }))
  const s = fakeSession()
  await call(tools.get('think_add'), { kind: 'finding', claim: 'The cache is stale.', derivedFrom: ['p-1'] }, s)
  const found = await tools.get('think_search').execute({ query: 'cache' }, { agent: { session: s } })
  assert.deepEqual(found.hits.map(n => n.id).sort(), ['n-1', 'p-1'])
  assert.equal(found.total, 2)
  const opened = await tools.get('think_open').execute({ id: 'n-1' }, { agent: { session: s } })
  assert.deepEqual(opened.related.map(n => n.id), ['p-1'])
  assert.match(tools.get('think_open').output.render({}, opened)[0].text, /n-1 \[finding, asserted\]/)
  s.events.push(human('next task'))
  await assert.rejects(tools.get('think_open').execute({ id: 'n-1' }, { agent: { session: s } }), /no node n-1/)
  assert.deepEqual((await tools.get('think_search').execute({ query: 'cache' }, { agent: { session: s } })).hits.map(n => n.id), ['p-1'])
})

test('another project does not see this project\'s persistent nodes', async () => {
  const { ctx, tools } = fakeCtx()
  const { store } = mount(ctx, { defineTool: o => o })
  await store.mutate(projectKey('C:\\Proj'), r => addPersistent(r, { kind: 'finding', claim: 'Project fact.' }, { at: AT, origin: { by: 'operator' } }))
  const other = await tools.get('think_search').execute({ query: 'fact' }, { agent: { session: fakeSession('/elsewhere') } })
  assert.equal(other.hits.length, 0)
})
