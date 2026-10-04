/**
 * @finess/thoughts T-288: a full persistent store demotes older recoverable nodes to stubs with a
 * recovery pointer, never deleting; a write that cannot make room that way still errors and
 * changes nothing. Temp dirs only.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { fileStore, storeFile } from '../../packages/thoughts/src/adapters.js'
import { STUB_PREFIX, demoteToFit, findOriginal, isStubNode, recoveryOf, restoreStub, stubOf } from '../../packages/thoughts/src/evict.js'
import { nodeRecord } from '../../packages/thoughts/src/fold.js'
import { ThoughtStoreFullError, addPersistent, emptyProject, parseProject, promote, recordBytes } from '../../packages/thoughts/src/store.js'
import { runThink } from '../commands/think.mjs'

const AT = '2026-10-04T09:00:00.000Z'
const at = i => `2026-10-04T09:00:${String(i).padStart(2, '0')}.000Z`
const long = i => `Node ${i} records a conclusion that is long enough to make demotion worth something here.`
const eph = (id, kind, i) => ({ id, scope: 'ephemeral', kind, claim: long(i), evidence: ['src/a.ts:1', 'src/b.ts:2'], confidence: 'asserted', derivedFrom: [], turn: 1, at: at(i) })

/** A record holding promoted nodes of the given kinds (origin session + from, so recoverable). */
function promoted(kinds) {
  let r = emptyProject()
  kinds.forEach((kind, i) => { r = promote(r, eph(`n-${i + 1}`, kind, i), { at: at(i), origin: { by: 'operator', session: 'session-s1' }, cap: 1e9 }).record })
  return r
}

test('a stub keeps id, kind, turn, time and edges, carries a recovery pointer, and still parses', () => {
  const r = promoted(['finding'])
  const s = stubOf(r.nodes[0])
  assert.equal(s.node.id, 'p-1')
  assert.ok(s.node.claim.startsWith(STUB_PREFIX))
  assert.ok(s.node.claim.length < long(0).length)
  assert.deepEqual(s.node.evidence, ['recover: session-s1#n-1'])
  assert.equal(s.node.confidence, 'asserted')
  assert.equal(s.node.at, r.nodes[0].node.at)
  assert.equal(isStubNode(s.node), true)
  assert.deepEqual(recoveryOf(s.node), { session: 'session-s1', from: 'n-1' })
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify({ ...r, nodes: [s] }))).nodes[0], s)
})

test('demoteToFit goes kind by kind, oldest first, constraints last, and never touches protected or operator nodes', () => {
  let r = promoted(['constraint', 'finding', 'attempt', 'finding', 'decision'])
  r = addPersistent(r, { kind: 'attempt', claim: 'Operator note without a session.' }, { at: AT, origin: { by: 'operator' }, cap: 1e9 }).record
  const full = recordBytes(r)
  const one = demoteToFit(r, full - 1)
  assert.deepEqual(one.demoted, ['p-3'], 'the attempt goes first')
  const all = demoteToFit(r, 10, ['p-2'])
  assert.deepEqual(all.demoted, ['p-3', 'p-4', 'p-5', 'p-1'])
  assert.equal(all.record.nodes.length, r.nodes.length, 'nothing is deleted')
  assert.equal(isStubNode(all.record.nodes.find(s => s.node.id === 'p-2').node), false)
  assert.equal(isStubNode(all.record.nodes.find(s => s.node.id === 'p-6').node), false)
  assert.deepEqual(demoteToFit(r, full), { record: r, demoted: [] })
})

test('a full store demotes to fit a new node and reports it; with nothing demotable it still throws and changes nothing', () => {
  const r = promoted(['finding', 'decision'])
  const cap = recordBytes(addPersistent(r, { kind: 'finding', claim: long(9) }, { at: AT, origin: { by: 'operator' }, cap: 1e9 }).record) - 1
  const out = addPersistent(r, { kind: 'finding', claim: long(9) }, { at: AT, origin: { by: 'operator' }, cap })
  assert.deepEqual(out.demoted, ['p-1'])
  assert.equal(out.node.id, 'p-3')
  assert.ok(recordBytes(out.record) <= cap)
  const popts = { at: AT, origin: { by: 'operator', session: 'session-s2' } }
  const p = promote(r, eph('n-9', 'finding', 9), { ...popts, cap: recordBytes(promote(r, eph('n-9', 'finding', 9), { ...popts, cap: 1e9 }).record) - 1 })
  assert.deepEqual(p.demoted, ['p-1'])
  let ops = emptyProject()
  for (let i = 0; i < 3; i++) ops = addPersistent(ops, { kind: 'finding', claim: long(i) }, { at: AT, origin: { by: 'operator' }, cap: 1e9 }).record
  const before = JSON.stringify(ops)
  assert.throws(() => addPersistent(ops, { kind: 'finding', claim: long(7) }, { at: AT, origin: { by: 'operator' }, cap: recordBytes(ops) + 20 }), ThoughtStoreFullError)
  assert.equal(JSON.stringify(ops), before)
})

test('findOriginal picks the right node when ephemeral ids repeat across tasks; restoreStub re-inflates it in place', () => {
  const r = promoted(['finding', 'decision'])
  const demoted = demoteToFit(r, 10).record
  const stub = demoted.nodes[0].node
  const rec = n => ({ type: 'tool/result', data: { message: { isError: false }, meta: nodeRecord(n) } })
  const human = { type: 'user/message', data: { source: { kind: 'user' } } }
  const events = [human, rec({ ...eph('n-1', 'finding', 50), claim: 'A different n-1 from another task.' }), human, rec(eph('n-1', 'finding', 0))]
  const original = findOriginal(stub, events)
  assert.equal(original.claim, long(0))
  assert.equal(findOriginal(stub, events.slice(0, 2)), undefined)
  const back = restoreStub(demoted, 'p-1', original)
  assert.deepEqual(back.nodes[0].node, r.nodes[0].node)
  assert.throws(() => restoreStub(back, 'p-1', original), /not a demoted stub/)
})

test('/think promote reports demotions and /think restore brings a stub back from its session log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finess-thoughts-evict-'))
  const log = console.log
  const lines = []
  console.log = (...a) => { lines.push(a.join(' ')) }
  try {
    const store = fileStore(storeFile(dir))
    const human = { type: 'user/message', data: { source: { kind: 'user' } } }
    const rec = n => ({ type: 'tool/result', data: { message: { isError: false }, meta: nodeRecord(n) } })
    const events = [human, rec(eph('n-1', 'finding', 1)), rec(eph('n-2', 'decision', 2)), rec(eph('n-3', 'finding', 3))]
    const deps = cap => ({ store, project: 'c:/proj', session: 'session-s1', events: () => events, eventsOf: id => (id === 'session-s1' ? events : undefined), now: () => new Date(AT), cap })
    assert.equal(runThink(['promote', 'n-1'], deps(1e9)), 0)
    assert.equal(runThink(['promote', 'n-2'], deps(1e9)), 0)
    const cap = recordBytes(promote(store.read('c:/proj'), events[3].data.meta.node, { at: AT, origin: { by: 'operator', session: 'session-s1' }, cap: 1e9 }).record) - 1
    assert.equal(runThink(['promote', 'n-3'], deps(cap)), 0)
    assert.ok(lines.some(l => /demoted p-1 to stubs/.test(l)))
    assert.equal(isStubNode(store.read('c:/proj').nodes[0].node), true)
    assert.equal(runThink(['restore', 'p-2'], deps(cap)), 1, 'p-2 is not a stub')
    assert.equal(runThink(['restore', 'p-1'], deps(1e9)), 0)
    assert.equal(store.read('c:/proj').nodes[0].node.claim, long(1))
    assert.equal(runThink(['promote', 'n-1'], { ...deps(1e9), eventsOf: () => undefined }), 1, 'already promoted')
  } finally {
    console.log = log
    rmSync(dir, { recursive: true, force: true })
  }
})
