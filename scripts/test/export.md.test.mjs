/** `/export`: the Markdown render against a fixture event list (pure, no files). */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderSessionMarkdown, summarizeArgs } from '../lib/export-md.mjs'
import exportCmd from '../commands/export.mjs'

const text = t => [{ type: 'text', text: t }]
const events = [
  { type: 'session', id: 'session-abcd1234-0000', createdAt: Date.UTC(2026, 9, 2, 12, 0, 0) },
  { type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'chat' } } } },
  { type: 'user/message', data: { content: text('fix the bug\nin a.js') } },
  { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'hidden' }, ...text('looking')] }, usage: { inputTokens: 1000, outputTokens: 20 } } },
  { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{"path":"src/a.js"}' } },
  { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false } } },
  { type: 'tool/call', data: { callId: 'c2', name: 'glob', arguments: '{"x":1}' } },
  { type: 'tool/result', error: { code: 'INVALID_ARGS' }, data: { message: { toolCallId: 'c2', isError: true } } },
  { type: 'assistant/message', data: { message: { role: 'assistant', content: text('done') }, usage: { inputTokens: 1200, outputTokens: 5 } } },
  { type: 'user/message', data: { source: { kind: 'runtime-context' }, content: text('Current runtime context') } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: text('thanks') } },
  { type: 'assistant/message', data: { message: { role: 'assistant', content: text('np') } } },
]

test('renders title, route, start, turns, tool lines and token totals', () => {
  const md = renderSessionMarkdown(events, { id: 'abcd1234' })
  assert.match(md, /^# fix the bug in a\.js\n/)
  assert.match(md, /- Route: deepseek\/chat/)
  assert.match(md, /- Started: 2026-10-02T12:00:00\.000Z/)
  assert.match(md, /- Turns: 2/)
  assert.match(md, /> fix the bug\n> in a\.js/)
  assert.match(md, /\*\*Assistant\*\*\n\nlooking\n\ndone/)
  assert.ok(!md.includes('hidden'), 'reasoning is not exported')
  assert.ok(!md.includes('runtime context'), 'runtime snapshots are not turns')
  assert.match(md, /- read src\/a\.js -> ok/)
  assert.match(md, /- glob x=1 -> ERROR INVALID_ARGS/)
  assert.match(md, /Tokens: 2,200 in \/ 25 out/)
  assert.match(md, /Tokens: not reported/)
  assert.match(md, /## Total\n\nTokens: 2,200 in \/ 25 out/)
})

test('an empty log still renders a document', () => {
  const md = renderSessionMarkdown([])
  assert.match(md, /^# Session\n/)
  assert.match(md, /Turns: 0/)
})

test('summarizeArgs prefers path-like keys and clips', () => {
  assert.equal(summarizeArgs('{"command":"ls -la"}'), 'ls -la')
  assert.equal(summarizeArgs('not json'), 'not json')
  assert.ok(summarizeArgs({ q: 'x'.repeat(200) }).length <= 70)
})

test('/export is terminal-only', () => {
  assert.equal(exportCmd.web, false)
})
