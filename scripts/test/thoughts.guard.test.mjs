/**
 * Thought-graph guards: contradictions (T-296), provenance and revocation (T-297), and the shadow
 * decision-model assist (T-295). Pure records, fake ask, temp dirs only.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { questionErrors } from '../lib/decisions.mjs'
import { MAX_ASSESSED, runNodes, shadowThoughts } from '../lib/thought-assist.mjs'
import { MAX_CANDIDATES, assistQuestions, assistRules, assistState } from '../../packages/thoughts/src/assist.js'
import { claimTriple, contradiction, findContradiction, guardedWrite, pendingConflicts, resolveConflict } from '../../packages/thoughts/src/conflicts.js'
import { parseConflictFields, parseOrigin } from '../../packages/thoughts/src/envelope.js'
import { nodeRecord } from '../../packages/thoughts/src/fold.js'
import { nodeModels, originLine, revoke, revokeMatcher } from '../../packages/thoughts/src/provenance.js'
import { ThoughtStoreFullError, addPersistent, emptyProject, link, parseProject, promote, recordBytes } from '../../packages/thoughts/src/store.js'

const AT = '2026-10-04T10:00:00.000Z'
const op = { by: 'operator' }
const add = (r, claim, origin = op) => addPersistent(r, { kind: 'finding', claim }, { at: AT, origin }).record
const eph = (id, claim, at = AT) => ({ id, scope: 'ephemeral', kind: 'finding', claim, evidence: [], confidence: 'asserted', derivedFrom: [], turn: 1, at })
const result = node => ({ type: 'tool/result', data: { message: { isError: false }, meta: nodeRecord(node) } })
const header = (provider, model) => ({ type: 'request/header', data: { header: { config: { provider, model } } } })
const human = { type: 'user/message', data: { source: { kind: 'user' } } }

test('claimTriple reads subject, predicate, negation and value', () => {
  assert.deepEqual(claimTriple('The default port is 4180.'), { subject: 'default port', predicate: 'is', negated: false, value: '4180' })
  assert.deepEqual(claimTriple("The cache isn't stale."), { subject: 'cache', predicate: 'is', negated: true, value: 'stale' })
  assert.deepEqual(claimTriple('dsh does not use pnpm.'), { subject: 'dsh', predicate: 'uses', negated: true, value: 'pnpm' })
  assert.deepEqual(claimTriple("The session identity includes the 'session-' prefix."), { subject: 'session identity', predicate: 'includes', negated: false, value: 'session- prefix' })
  assert.equal(claimTriple('It works.'), undefined)
  assert.equal(claimTriple('Ran the tests.'), undefined)
})

test('contradiction: a different single value or a negation flip, nothing else', () => {
  assert.match(contradiction('The default port is 4181.', 'The default port is 4180.'), /4181.*4180/)
  assert.match(contradiction("The cache isn't stale.", 'The cache is stale.'), /asserted and denied/)
  assert.match(contradiction('dsh does not use pnpm.', 'dsh uses pnpm.'), /asserted and denied/)
  assert.equal(contradiction('The default port is 4180.', 'The default port is 4180!'), undefined, 'same value')
  assert.equal(contradiction('dsh uses pnpm.', 'dsh uses node.'), undefined, 'multi-valued predicate')
  assert.equal(contradiction('The port is 1.', 'The host is 1.'), undefined, 'different subject')
  assert.equal(contradiction('The port is not 1.', 'The port is not 2.'), undefined, 'two denials')
})

test('a contradicting add is held as a conflict, never written over the stored node', () => {
  let r = add(emptyProject(), 'The default port is 4180.')
  const res = guardedWrite(r, x => addPersistent(x, { kind: 'finding', claim: 'The default port is 4181.' }, { at: AT, origin: op }), { at: AT })
  assert.equal(res.node, undefined)
  assert.equal(res.conflict.id, 'c-1')
  assert.equal(res.conflict.against, 'p-1')
  assert.equal(res.conflict.entry.node.id, 'p-2', 'the id is reserved')
  r = res.record
  assert.deepEqual(r.nodes.map(s => s.node.claim), ['The default port is 4180.'])
  assert.equal(r.nextId, 3)
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify(r))), r, 'conflicts survive the boundary parse')
  // an unrelated write passes straight through
  const ok = guardedWrite(r, x => addPersistent(x, { kind: 'finding', claim: 'The host is local.' }, { at: AT, origin: op }), { at: AT })
  assert.equal(ok.node.id, 'p-3')
  assert.equal(pendingConflicts(ok.record).length, 1, 'later writes keep the pending conflicts')
})

test('an explicit --contradicts target always counts, and must exist', () => {
  const r = add(emptyProject(), 'Builds are fast.')
  const res = guardedWrite(r, x => addPersistent(x, { kind: 'finding', claim: 'The CI cache saves ten minutes.' }, { at: AT, origin: op }), { at: AT, contradicts: 'p-1' })
  assert.match(res.conflict.reason, /marked/)
  assert.throws(() => guardedWrite(r, x => addPersistent(x, { kind: 'finding', claim: 'X.' }, { at: AT, origin: op }), { at: AT, contradicts: 'p-9' }), /no persistent node p-9/)
})

test('promoting the same contradicting node twice is refused while it is pending', () => {
  const r0 = add(emptyProject(), 'The cache is stale.')
  const origin = { by: 'model', session: 'session-abcd1234', model: 'deepseek/v3' }
  const write = r => guardedWrite(r, x => promote(x, eph('n-1', "The cache isn't stale."), { at: AT, origin }), { at: AT })
  const r1 = write(r0).record
  assert.throws(() => write(r1), /already pending as c-1/)
})

test('resolve keep | replace | both', () => {
  const held = guardedWrite(link(add(add(emptyProject(), 'The default port is 4180.'), 'The proxy is nginx.'), 'p-2', 'p-1'),
    x => addPersistent(x, { kind: 'finding', claim: 'The default port is 4181.' }, { at: AT, origin: op }), { at: AT }).record
  const keep = resolveConflict(held, 'c-1', 'keep')
  assert.deepEqual(keep.record.nodes.map(s => s.node.id), ['p-1', 'p-2'])
  assert.equal(pendingConflicts(keep.record).length, 0)
  const rep = resolveConflict(held, 'c-1', 'replace')
  assert.deepEqual(rep.record.nodes.map(s => s.node.id), ['p-2', 'p-3'])
  assert.deepEqual(rep.record.nodes[0].node.derivedFrom, [], 'edges to the replaced node go too')
  assert.equal(rep.removed.node.id, 'p-1')
  const both = resolveConflict(held, 'c-1', 'both')
  assert.deepEqual(both.record.nodes.map(s => s.node.id), ['p-1', 'p-2', 'p-3'])
  assert.throws(() => resolveConflict(held, 'c-9', 'keep'), /no pending conflict/)
  assert.throws(() => resolveConflict(held, 'c-1', 'merge'), /keep \| replace \| both/)
  assert.throws(() => resolveConflict(held, 'p-1', 'keep'), /conflict id/)
})

test('a held conflict counts against the byte cap', () => {
  const r = add(emptyProject(), 'The default port is 4180.')
  assert.throws(() => guardedWrite(r, x => addPersistent(x, { kind: 'finding', claim: 'The default port is 4181.' }, { at: AT, origin: op, cap: 4096 }), { at: AT, cap: recordBytes(r) + 10 }), ThoughtStoreFullError)
})

test('the origin envelope keeps session and model; malformed ones are refused', () => {
  assert.deepEqual(parseOrigin({ by: 'model', session: 's', model: 'p/m', from: 'n-1', x: 1 }, 'e'), { by: 'model', session: 's', model: 'p/m', from: 'n-1' })
  assert.throws(() => parseOrigin({ by: 'robot' }, 'e'), /bad origin/)
  assert.deepEqual(parseConflictFields({}), {})
  assert.throws(() => parseConflictFields({ conflicts: [], nextConflict: 0 }), /malformed/)
  assert.throws(() => parseConflictFields({ conflicts: [{ id: 'p-1' }], nextConflict: 2 }), /malformed/)
  const r = add(emptyProject(), 'A fact.', { by: 'model', session: 'session-x', model: 'local/qwen' })
  assert.equal(parseProject(JSON.parse(JSON.stringify(r))).nodes[0].origin.model, 'local/qwen')
})

test('nodeModels attributes each node to the request that produced it', () => {
  const m = nodeModels([header('deepseek', 'v3'), result(eph('n-1', 'One.')), header('local', 'qwen'), result(eph('n-2', 'Two.')), { type: 'request/header', data: {} }, result(eph('n-3', 'Three.'))])
  assert.deepEqual([...m], [['n-1', 'deepseek/v3'], ['n-2', 'local/qwen'], ['n-3', 'local/qwen']])
  assert.equal(nodeModels([result(eph('n-1', 'One.'))]).get('n-1'), 'unknown')
})

test('originLine shows who, which model and session', () => {
  assert.match(originLine({ node: {}, origin: { by: 'model', session: 'session-abcdef', model: 'p/m', from: 'n-2' }, storedAt: AT }), /model p\/m, session abcdef, from n-2, stored/)
  assert.match(originLine({ node: {}, origin: { by: 'operator' }, storedAt: AT }), /origin: operator, stored/)
})

/** Two model runs and an operator note in one project. */
function poisoned() {
  let r = add(emptyProject(), 'Operator note one.', { by: 'operator', session: 'session-bad00001' })
  r = add(r, 'The cache is stale.', { by: 'model', session: 'session-bad00001', model: 'local/qwen' })
  r = add(r, 'Builds are slow.', { by: 'model', session: 'session-good0002', model: 'deepseek/v3' })
  r = link(r, 'p-3', 'p-2')
  return guardedWrite(r, x => addPersistent(x, { kind: 'finding', claim: "The cache isn't stale." }, { at: AT, origin: { by: 'model', session: 'session-good0002', model: 'deepseek/v3' } }), { at: AT }).record
}

test('revoke by session prefix removes that run\'s model nodes, their edges and conflicts', () => {
  const res = revoke(poisoned(), 'bad0')
  assert.equal(res.match, 'session')
  assert.deepEqual(res.removed.map(s => s.node.id), ['p-2'])
  assert.deepEqual(res.record.nodes.map(s => s.node.id), ['p-1', 'p-3'], 'the operator\'s own note stays')
  assert.deepEqual(res.record.nodes[1].node.derivedFrom, [])
  assert.deepEqual(res.dropped.map(c => c.id), ['c-1'], 'a conflict against a revoked node goes too')
  assert.equal(revoke(poisoned(), 'session-bad00001').removed.length, 1, 'the session- prefix is optional')
})

test('revoke by model (full or bare name) and by id', () => {
  const byModel = revoke(poisoned(), 'deepseek/v3')
  assert.equal(byModel.match, 'model')
  assert.deepEqual(byModel.removed.map(s => s.node.id), ['p-3'])
  assert.deepEqual(byModel.dropped.map(c => c.id), ['c-1'], 'a conflict the model wrote goes too')
  assert.deepEqual(revoke(poisoned(), 'qwen').removed.map(s => s.node.id), ['p-2'])
  const byId = revoke(poisoned(), 'p-1')
  assert.equal(byId.match, 'id')
  assert.deepEqual(byId.removed.map(s => s.node.id), ['p-1'])
})

test('revoke refuses short, empty, ambiguous and unmatched tokens', () => {
  assert.throws(() => revoke(poisoned(), 'b'), /at least 4/)
  assert.throws(() => revoke(poisoned(), ''), /revoke what/)
  assert.throws(() => revoke(poisoned(), 'nobody/none'), /matches no/)
  assert.throws(() => revoke(poisoned(), 'p-9'), /matches nothing/)
  const r = add(emptyProject(), 'X is y.', { by: 'model', session: 'session-qwen0001', model: 'local/qwen0' })
  assert.throws(() => revokeMatcher(add(r, 'Z is w.', { by: 'model', session: 'session-zzzz', model: 'qwen' }), 'qwen'), /both a session and a model/)
})

test('assist asks persist always and contradicts only with candidates, <= 8 options, valid', () => {
  const stored = Array.from({ length: 10 }, (_, i) => ({ ...eph(`p-${i + 1}`, `The cache layer ${i} is warm.`), scope: 'persistent' }))
  const node = eph('n-1', 'The cache layer 3 is cold.')
  const { questions, candidates } = assistQuestions(node, stored)
  assert.equal(candidates.length, MAX_CANDIDATES)
  assert.equal(Object.keys(questions.contradicts.criteria).length, 8)
  assert.equal(questionErrors(questions), undefined)
  assert.deepEqual(assistRules(node, stored, candidates), { persist: 'no', contradicts: 'p-4' })
  const none = assistQuestions(node, [])
  assert.deepEqual(Object.keys(none.questions), ['persist'])
  assert.deepEqual(assistRules(node, [], none.candidates), { persist: 'no' })
  assert.match(assistState({ ...node, evidence: ['a.js:1'] }), /NEW CONCLUSION \(finding, asserted\).*\nEVIDENCE: a\.js:1/)
})

test('runNodes takes this task\'s nodes stamped since the run started', () => {
  const old = '2026-10-04T09:00:00.000Z'
  const events = [human, result(eph('n-1', 'Old.', old)), human, result(eph('n-1', 'New one.')), result(eph('n-2', 'Stale.', old))]
  assert.deepEqual(runNodes(events, Date.parse(AT)).map(n => n.claim), ['New one.'])
})

/** A fake Laya: records each call, answers yes / the first candidate. */
function fakeAsk(calls, ok = true) {
  return async (dc, state, questions, opts) => {
    calls.push({ state, questions, opts })
    const answers = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, Object.keys(q.criteria)[k === 'persist' ? 0 : 1]]))
    return ok ? { ok: true, ms: 5, body: { answers: Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, { answer: a, answer_confidence: 0.9 }])) } } : { ok: false, ms: 1, error: 'down' }
  }
}

test('shadowThoughts logs one shadow record per new node, source thoughts, and acts on nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'finess-tassist-'))
  try {
    const cfg = { decisions: { enabled: true, shadow: true } }
    const stored = add(emptyProject(), 'The cache is stale.')
    const before = JSON.stringify(stored)
    const events = [header('deepseek', 'v3'), human, result(eph('n-1', "The cache isn't stale.")), result(eph('n-2', 'Unrelated words only.'))]
    const calls = []
    const ids = await shadowThoughts(cfg, { events: () => events, since: Date.parse(AT), stored: () => stored, session: 'session-1' }, { ask: fakeAsk(calls), dir })
    assert.equal(ids.length, 2)
    assert.equal(calls.length, 2, 'one call per node, both questions in it')
    assert.deepEqual(Object.keys(calls[0].questions), ['persist', 'contradicts'])
    assert.deepEqual(Object.keys(calls[1].questions), ['persist'])
    assert.equal(JSON.stringify(stored), before, 'the store is untouched')
    const recs = readdirSync(dir).filter(f => f.endsWith('.jsonl')).flatMap(f => readFileSync(join(dir, f), 'utf8').trim().split('\n').map(l => JSON.parse(l)))
    assert.equal(recs.length, 2)
    assert.equal(recs[0].source, 'thoughts')
    assert.equal(recs[0].node, 'n-1')
    assert.equal(recs[0].session, 'session-1')
    assert.deepEqual(recs[0].rules, { persist: 'no', contradicts: 'p-1' })
    assert.equal(recs[0].model.persist.answer, 'yes')
    assert.equal(recs[0].model.contradicts.answer, 'p-1')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('shadowThoughts is silent when decisions are off, the service fails, or there is nothing new', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'finess-tassist-'))
  try {
    const run = { events: () => [human, result(eph('n-1', 'A fact.'))], since: Date.parse(AT), stored: emptyProject }
    const calls = []
    assert.deepEqual(await shadowThoughts({}, run, { ask: fakeAsk(calls), dir }), [])
    assert.deepEqual(await shadowThoughts({ decisions: { enabled: true, shadow: false } }, run, { ask: fakeAsk(calls), dir }), [])
    assert.equal(calls.length, 0, 'off means no call at all')
    const on = { decisions: { enabled: true, shadow: true } }
    assert.deepEqual(await shadowThoughts(on, run, { ask: fakeAsk(calls, false), dir }), [])
    assert.deepEqual(await shadowThoughts(on, { ...run, events: () => undefined }, { ask: fakeAsk(calls), dir }), [])
    assert.deepEqual(await shadowThoughts(on, { ...run, since: Date.parse(AT) + 1 }, { ask: fakeAsk(calls), dir }), [])
    assert.deepEqual(await shadowThoughts(on, { ...run, stored: () => { throw new Error('boom') } }, { ask: fakeAsk(calls), dir }), [], 'never throws')
    const many = { ...run, events: () => [human, ...Array.from({ length: 9 }, (_, i) => result(eph(`n-${i + 1}`, `Fact ${i}.`)))] }
    assert.equal((await shadowThoughts(on, many, { ask: fakeAsk([]), dir })).length, MAX_ASSESSED)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('findContradiction scans the stored nodes', () => {
  const r = add(add(emptyProject(), 'The host is local.'), 'The default port is 4180.')
  assert.equal(findContradiction(r, 'The default port is 80.').against, 'p-2')
  assert.equal(findContradiction(r, 'Something else entirely.'), undefined)
})
