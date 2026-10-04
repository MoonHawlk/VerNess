/**
 * Dashboard thought-graph panel (T-290): reads the current session's graph and the persistent store
 * from temp dirs, renders escaped HTML with links and provenance. No real $DSH_HOME.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { graphRows, readThoughtsPanel, renderThoughtsPanel } from '../lib/thoughts-panel.mjs'
import { fileStore, storeFile } from '../../packages/thoughts/src/adapters.js'
import { guardedWrite } from '../../packages/thoughts/src/conflicts.js'
import { nodeRecord } from '../../packages/thoughts/src/fold.js'
import { addPersistent } from '../../packages/thoughts/src/store.js'

const AT = '2026-10-04T10:00:00.000Z'
const node = (id, claim, derivedFrom = []) => ({ id, scope: 'ephemeral', kind: 'finding', claim, evidence: ['a.js:1'], confidence: 'verified', derivedFrom, turn: 1, at: AT })
const result = n => ({ type: 'tool/result', data: { message: { isError: false }, meta: nodeRecord(n) } })
const esc = v => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

test('graphRows nests each node under its first parent and keeps every node', () => {
  const rows = graphRows([node('n-1', 'Root.'), node('n-2', 'Child.', ['n-1']), node('n-3', 'Grandchild.', ['n-2', 'n-1']), node('n-4', 'From store.', ['p-2'])])
  assert.deepEqual(rows.map(r => [r.node.id, r.depth, r.also, r.usedBy]), [
    ['n-1', 0, [], ['n-2', 'n-3']],
    ['n-2', 1, [], ['n-3']],
    ['n-3', 2, ['n-1'], []],
    ['n-4', 0, ['p-2'], []],
  ])
})

test('the panel reads the current session and the store, and escapes model-written text', () => {
  const home = mkdtempSync(join(tmpdir(), 'finess-tpanel-'))
  try {
    const root = join(home, 'sessions')
    const dir = join(root, 'c-proj', 'session-abc123')
    mkdirSync(dir, { recursive: true })
    const events = [{ type: 'user/message', data: { source: { kind: 'user' } } }, result(node('n-1', 'The <script> tag is inert.')), result(node('n-2', 'So rendering is safe.', ['n-1']))]
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(events.map(e => zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`)))))
    const store = fileStore(storeFile(home))
    store.mutate('c:/proj', r => addPersistent(r, { kind: 'constraint', claim: 'The default port is 4180.' }, { at: AT, origin: { by: 'model', session: 'session-abc123', model: 'deepseek/v3', from: 'n-9' } }))
    store.mutate('c:/proj', r => guardedWrite(r, x => addPersistent(x, { kind: 'finding', claim: 'The default port is 4181.' }, { at: AT, origin: { by: 'operator' } }), { at: AT }))
    const decisions = [{ source: 'repl', at: AT }, { source: 'thoughts', at: AT, node: 'n-1', task: 'x', model: { persist: { answer: 'yes' } }, rules: { persist: 'no' } }]
    const data = readThoughtsPanel({ session: 'session-abc123', dshHome: home, sessionsRoot: root, decisions })
    assert.equal(data.found, true)
    assert.deepEqual(data.nodes.map(n => n.id), ['n-1', 'n-2'])
    assert.equal(data.projects.length, 1)
    assert.equal(data.projects[0].conflicts.length, 1)
    assert.equal(data.shadow.length, 1)
    assert.deepEqual(data.errors, [])
    const html = renderThoughtsPanel(data, esc)
    assert.ok(!html.includes('<script>'), 'claims are escaped')
    assert.match(html, /The &lt;script&gt; tag is inert\./)
    assert.match(html, /→ n-2/)
    assert.match(html, /model deepseek\/v3, session abc123, from n-9/)
    assert.match(html, /1 contradiction\(s\) pending/)
    assert.match(html, /c-1/)
    assert.match(html, /decision model on new nodes/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('the dashboard page carries the panel and watches the store directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'finess-tpanel-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { renderDashboard, watchTargets } = await import('../dashboard.mjs')
    const { html } = renderDashboard({ limit: 1, session: 'session-none' })
    assert.match(html, /<h2 id="thoughts">Thought graph/)
    assert.ok(watchTargets().includes(join(home, 'storages')))
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})

test('the panel says so when there is no session, no log, no store, or a broken store', () => {
  const home = mkdtempSync(join(tmpdir(), 'finess-tpanel-'))
  try {
    const none = readThoughtsPanel({ dshHome: home, sessionsRoot: join(home, 'sessions') })
    assert.match(renderThoughtsPanel(none, esc), /no current session.*no nodes recorded/s)
    assert.match(renderThoughtsPanel(none, esc), /no persistent nodes yet/)
    const missing = readThoughtsPanel({ session: 'session-gone', dshHome: home, sessionsRoot: join(home, 'sessions') })
    assert.match(renderThoughtsPanel(missing, esc), /log not found/)
    mkdirSync(join(home, 'storages'))
    writeFileSync(storeFile(home), '{"unit":{"name":"other"}}')
    const broken = readThoughtsPanel({ dshHome: home, sessionsRoot: join(home, 'sessions') })
    assert.equal(broken.errors.length, 1)
    assert.match(renderThoughtsPanel(broken, esc), /persistent store: /)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
