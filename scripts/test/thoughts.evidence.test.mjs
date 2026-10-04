/**
 * @finess/thoughts T-287: "verified" needs evidence read in the same turn, judged from the log -
 * in think_add (downgrade with a note) and in /think promote (re-check against the node's turn).
 * Fake sessions and temp dirs only.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { fileStore, storeFile } from '../../packages/thoughts/src/adapters.js'
import { gatePromotion, gateVerified, namesRead, pointerOf, turnReads } from '../../packages/thoughts/src/evidence.js'
import { foldEvents, nodeRecord } from '../../packages/thoughts/src/fold.js'
import { mount } from '../../packages/thoughts/src/plugin.js'
import { runThink } from '../commands/think.mjs'

const AT = '2026-10-04T09:00:00.000Z'
const human = text => ({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const turn = t => ({ type: 'turn/start', data: { turn: t } })
let seq = 0
/** A tool call and (unless `pending`) its result, in turn `t`. */
function toolUse(t, name, args, { isError = false, text = '', pending = false } = {}) {
  const callId = `call-${++seq}`
  const call = { type: 'tool/call', data: { turn: t, step: 1, callId, name, arguments: JSON.stringify(args) } }
  if (pending) return [call]
  return [call, { type: 'tool/result', data: { turn: t, step: 1, message: { role: 'tool', toolCallId: callId, isError, content: [{ type: 'text', text }] } } }]
}
const node = (extra = {}) => ({ id: 'n-1', scope: 'ephemeral', kind: 'finding', claim: 'The prefix is kept.', evidence: ['src/a.ts:42'], confidence: 'verified', derivedFrom: [], turn: 2, at: AT, ...extra })

test('turnReads pairs read-like calls with non-error results of that turn, after the task start', () => {
  const events = [
    human('old task'), turn(2), ...toolUse(2, 'read', { file_path: 'C:\\Proj\\old.ts' }),
    human('new task'), turn(1), ...toolUse(1, 'read', { file_path: 'C:\\Proj\\prev.ts' }),
    turn(2),
    ...toolUse(2, 'read', { file_path: 'C:\\Proj\\src\\a.ts' }),
    ...toolUse(2, 'read', { file_path: 'C:\\Proj\\broken.ts' }, { isError: true }),
    ...toolUse(2, 'read', { file_path: 'C:\\Proj\\later.ts' }, { pending: true }),
    ...toolUse(2, 'bash', { command: 'cat x.ts' }),
    ...toolUse(2, 'grep', { pattern: 'prefix', path: 'src' }, { text: 'src\\b.ts:7: prefix' }),
    ...toolUse(2, 'web_fetch', { url: 'https://example.com/doc#x' }),
  ]
  assert.deepEqual(turnReads(events, 2).map(r => [r.tool, r.target]), [['read', 'C:\\Proj\\src\\a.ts'], ['grep', 'src'], ['web_fetch', 'https://example.com/doc#x']])
  assert.deepEqual(turnReads(events, 1).map(r => r.target), ['C:\\Proj\\prev.ts'])
  assert.deepEqual(turnReads(events, null), [])
})

test('namesRead matches paths, grep hits and URLs, never plain words', () => {
  const read = { tool: 'read', target: 'C:\\Proj\\src\\a.ts', text: '' }
  const cwd = 'C:\\Proj'
  assert.equal(pointerOf('`src/a.ts:42`,'), 'src/a.ts')
  assert.equal(pointerOf('src/a.ts#L3-L9'), 'src/a.ts')
  assert.equal(namesRead('src/a.ts:42', read, cwd), true)
  assert.equal(namesRead('read SRC/A.TS lines 4-9', read, cwd), true, 'drive-letter paths compare case-insensitively')
  assert.equal(namesRead('c:/proj/src/a.ts', read, cwd), true)
  assert.equal(namesRead('a.ts', read, cwd), true, 'a trailing path segment names the file')
  assert.equal(namesRead('b/a.ts', read, cwd), false)
  assert.equal(namesRead('the prefix', read, cwd), false)
  assert.equal(namesRead('ran npm test: 12 pass', read, cwd), false)
  const posix = { tool: 'read', target: 'docs/X.md', text: '' }
  assert.equal(namesRead('/home/u/p/docs/X.md', posix, '/home/u/p'), true)
  assert.equal(namesRead('/home/u/p/docs/x.md', posix, '/home/u/p'), false, 'posix paths keep their case')
  assert.equal(namesRead('src/b.ts:7', { tool: 'grep', target: 'lib', text: 'src\\b.ts:7: prefix' }, cwd), true)
  const web = { tool: 'web_fetch', target: 'https://Example.com/doc/', text: '' }
  assert.equal(namesRead('https://example.com/doc#intro', web, cwd), true)
  assert.equal(namesRead('https://example.com/other', web, cwd), false)
})

test('gateVerified keeps a proven node, downgrades an unproven one with the reason, ignores asserted', () => {
  const reads = [{ tool: 'read', target: 'C:\\Proj\\src\\a.ts', text: '' }]
  assert.equal(gateVerified(node(), reads, 'C:\\Proj').node.confidence, 'verified')
  const bad = gateVerified(node({ evidence: ['README:54'] }), reads, 'C:\\Proj')
  assert.equal(bad.node.confidence, 'asserted')
  assert.match(bad.note, /not verified.*turn 2.*read only C:\\Proj\\src\\a.ts/)
  assert.match(gateVerified(node(), [], 'C:\\Proj').note, /nothing was read/)
  const asserted = node({ confidence: 'asserted', evidence: [] })
  assert.equal(gateVerified(asserted, [], 'C:\\Proj').node, asserted)
})

/** Fake ctx (as in thoughts.test.mjs) whose stateOf folds the session's events. */
function fakeCtx() {
  const tools = new Map()
  const defs = new Map()
  const data = new Map()
  const ctx = {
    storageDomain: { open: async () => ({ table: () => ({ get: k => data.get(k), put: async (k, v) => { data.set(k, structuredClone(v)) } }), close: async () => {} }) },
    sessionProjections: {
      register: d => { defs.set(d.key, d) },
      stateOf: (session, key) => { const d = defs.get(key); return d === undefined ? undefined : session.events.reduce(d.apply, d.init()) },
    },
    tools: { register: t => { tools.set(t.name, t) } },
  }
  return { ctx, tools }
}

/** Execute a tool and log its result the way the registry does. */
async function call(tool, args, session) {
  const value = await tool.execute(args, { agent: { session } })
  const meta = tool.output.presentationMeta?.(args, value)
  session.events.push({ type: 'tool/result', data: { turn: 2, step: 1, message: { role: 'tool', toolCallId: `t-${++seq}`, isError: false, content: tool.output.render(args, value) }, ...(meta === undefined ? {} : { meta }) } })
  return value
}

test('think_add keeps "verified" only for evidence read this turn; the logged record carries the verdict', async () => {
  const { ctx, tools } = fakeCtx()
  mount(ctx, { defineTool: o => o, now: () => new Date(AT) })
  const session = { header: { id: 'session-1', cwd: 'C:\\Proj' }, events: [human('go'), turn(1), ...toolUse(1, 'read', { file_path: 'C:\\Proj\\old.ts' }), turn(2), ...toolUse(2, 'read', { file_path: 'C:\\Proj\\src\\a.ts' })], snapshotEvents() { return this.events } }
  const add = tools.get('think_add')
  const ok = await call(add, { kind: 'finding', claim: 'The prefix is kept.', evidence: ['src/a.ts:42'], confidence: 'verified' }, session)
  assert.equal(ok.node.confidence, 'verified')
  assert.equal(ok.note, undefined)
  const stale = await call(add, { kind: 'finding', claim: 'The old file is unused.', evidence: ['old.ts:1'], confidence: 'verified' }, session)
  assert.equal(stale.node.confidence, 'asserted', 'a read from the previous turn does not count')
  assert.match(add.output.render({}, stale)[0].text, /Note: recorded as asserted, not verified/)
  assert.deepEqual(foldEvents(session.events).nodes.map(n => n.confidence), ['verified', 'asserted'])
})

test('/think promote re-checks a verified node against its own turn and downgrades it when unproven', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finess-thoughts-ev-'))
  const log = console.log
  console.log = () => {}
  try {
    const rec = (n, t) => ({ type: 'tool/result', data: { turn: t, step: 1, message: { role: 'tool', toolCallId: `r-${n.id}`, isError: false, content: [] }, meta: nodeRecord(n) } })
    const proven = node({ id: 'n-1' })
    const unproven = node({ id: 'n-2', claim: 'The cache is stale.', evidence: ['cache.ts:3'] })
    const events = [human('task'), turn(2), ...toolUse(2, 'read', { file_path: 'c:/proj/src/a.ts' }), rec(proven, 2), rec(unproven, 2)]
    assert.equal(gatePromotion(proven, events, 'c:/proj').note, undefined)
    const store = fileStore(storeFile(dir))
    const run = args => runThink(args, { store, project: 'c:/proj', session: 'session-1', events: () => events, now: () => new Date(AT) })
    assert.equal(run(['promote', 'n-1']), 0)
    assert.equal(run(['promote', 'n-2']), 0)
    assert.deepEqual(store.read('c:/proj').nodes.map(s => [s.node.id, s.node.confidence]), [['p-1', 'verified'], ['p-2', 'asserted']])
  } finally {
    console.log = log
    rmSync(dir, { recursive: true, force: true })
  }
})
