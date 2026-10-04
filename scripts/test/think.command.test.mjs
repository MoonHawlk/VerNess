/**
 * `/think` (T-282): the operator command over the same store file the plugin uses. Temp dirs only;
 * output goes to the console, so assertions read the store back.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { fileStore, storeFile } from '../../packages/thoughts/src/adapters.js'
import { nodeRecord } from '../../packages/thoughts/src/fold.js'
import { recordBytes } from '../../packages/thoughts/src/store.js'
import think, { parseAdd, runThink } from '../commands/think.mjs'

const AT = '2026-10-03T12:00:00.000Z'
const eph = (id, claim) => ({ type: 'tool/result', data: { message: { isError: false }, meta: nodeRecord({ id, scope: 'ephemeral', kind: 'finding', claim, evidence: ['log:1'], confidence: 'verified', derivedFrom: [], turn: 1, at: AT }) } })
const EVENTS = [{ type: 'user/message', data: { source: { kind: 'user' } } }, eph('n-1', 'The build is green.'), eph('n-2', 'The cache is stale.')]

/** Run /think quietly against a temp store. */
function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'finess-think-'))
  const log = console.log
  console.log = () => {}
  try {
    const store = fileStore(storeFile(dir))
    const deps = extra => ({ store, project: 'c:/proj', session: 'session-1', events: () => EVENTS, now: () => new Date(AT), ...extra })
    return fn({ store, deps, run: (args, extra = {}) => runThink(args, deps(extra)) })
  } finally {
    console.log = log
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the command is registered as /think with a usage line', () => {
  assert.equal(think.name, 'think')
  assert.match(think.usage, /promote <n-id>/)
})

test('parseAdd reads kind, claim, evidence and --verified', () => {
  assert.deepEqual(parseAdd(['constraint', 'Never', 'edit', 'upstream.', '::', 'ADR-0002;', 'README']).input, { kind: 'constraint', claim: 'Never edit upstream.', evidence: ['ADR-0002', 'README'], confidence: 'asserted' })
  assert.equal(parseAdd(['finding', 'It', 'works.', '::', 'ran', 'it', '--verified']).input.confidence, 'verified')
  assert.match(parseAdd(['idea', 'x']).error, /kind/)
  assert.match(parseAdd(['finding']).error, /claim/)
})

test('add, link, show, forget round-trip through the store file', () => withStore(({ store, run }) => {
  assert.equal(run(['add', 'constraint', 'Never', 'edit', 'upstream.']), 0)
  assert.equal(run(['add', 'finding', 'Upstream', 'is', 'pinned.', '::', 'git', 'submodule', '--verified']), 0)
  assert.equal(run(['link', 'p-2', 'p-1']), 0)
  assert.deepEqual(store.read('c:/proj').nodes[1].node.derivedFrom, ['p-1'])
  assert.equal(store.read('c:/proj').nodes[0].origin.by, 'operator')
  assert.equal(run(['show', 'p-2']), 0)
  assert.equal(run(['forget', 'p-1']), 0)
  assert.deepEqual(store.read('c:/proj').nodes.map(s => [s.node.id, s.node.derivedFrom]), [['p-2', []]])
  assert.equal(run(['forget', 'p-1']), 1)
  assert.equal(run(['add', 'finding', 'Two.', 'Sentences.']), 1)
}))

test('promote copies an ephemeral node from the session log, once', () => withStore(({ store, run }) => {
  assert.equal(run(['list']), 0)
  assert.equal(run(['show', 'n-2']), 0)
  assert.equal(run(['promote', 'n-2']), 0)
  const s = store.read('c:/proj').nodes[0]
  assert.deepEqual([s.node.id, s.node.scope, s.node.claim, s.origin.from, s.origin.session], ['p-1', 'persistent', 'The cache is stale.', 'n-2', 'session-1'])
  assert.equal(run(['promote', 'n-2']), 1, 'a second promotion is refused')
  assert.equal(run(['promote', 'n-9']), 1)
  assert.equal(run(['promote', 'n-1'], { events: () => undefined }), 1, 'no session, no ephemeral nodes')
}))

test('a full store refuses the write and keeps what it had', () => withStore(({ store, run }) => {
  assert.equal(run(['add', 'finding', 'First', 'fact.']), 0)
  const cap = recordBytes(store.read('c:/proj')) + 20
  assert.equal(run(['add', 'finding', 'A', 'second', 'fact', 'that', 'will', 'not', 'fit.'], { cap }), 1)
  assert.equal(store.read('c:/proj').nodes.length, 1)
}))

test('unknown subcommands print usage and fail', () => withStore(({ run }) => {
  assert.equal(run(['frobnicate']), 1)
  assert.equal(run(['link', 'p-1']), 1)
}))
