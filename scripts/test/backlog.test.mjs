/**
 * The dashboard's backlog reader: open tasks come out of `docs/03-BACKLOG.md` with their workstream,
 * subgroup and parent, done tasks and plain bullets stay out, and the Markdown renderer escapes
 * everything it does not recognise — the page is opened from disk, so the file must never inject.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { inline, markdownToHtml, parseBacklog } from '../lib/backlog.mjs'
import { REPO } from '../lib/util.mjs'

const SAMPLE = `# Backlog

## WS-A — Launcher (plan \`01.md\`)

Foundation

- [ ] T-100 First **open** task
- [x] T-101 Done task
- [ ] T-102 Parent
  - [ ] T-102a Child

## Parking lot

- an idea, no id
`

test('parseBacklog: open tasks only, with group, subgroup and parent', () => {
  const tasks = parseBacklog(SAMPLE)
  assert.deepEqual(tasks.map(t => t.id), ['T-100', 'T-102', 'T-102a'])
  assert.equal(tasks[0].group, 'WS-A')
  assert.equal(tasks[0].sub, 'Foundation')
  assert.equal(tasks[0].text, 'First **open** task')
  assert.equal(tasks[2].parent, 'T-102')
  assert.equal(tasks[1].parent, undefined)
})

test('parseBacklog: the real backlog parses to unique, non-empty tasks', () => {
  const tasks = parseBacklog(readFileSync(join(REPO, 'docs', '03-BACKLOG.md'), 'utf8'))
  assert.ok(tasks.length > 0)
  assert.equal(new Set(tasks.map(t => t.id)).size, tasks.length)
  for (const t of tasks) assert.ok(t.text !== '' && t.group !== '', t.id)
})

test('inline: code stays literal, bold wraps code, html is escaped, javascript: links are not links', () => {
  assert.equal(inline('**`a<b>`** x'), '<strong><code>a&lt;b&gt;</code></strong> x')
  assert.equal(inline('<script>'), '&lt;script&gt;')
  assert.equal(inline('[ok](https://x.y)'), '<a href="https://x.y">ok</a>')
  assert.ok(!inline('[no](javascript:alert(1))').includes('<a'))
})

test('markdownToHtml: headings, nested checkbox lists, quotes, rules, fences', () => {
  const html = markdownToHtml('# T\n\n- [x] a\n  - [ ] b\n\n> note\n\n---\n\n```\n<raw>\n```\n')
  assert.match(html, /<h2>T<\/h2>/)
  assert.match(html, /<ul>\n<li><input type="checkbox" disabled checked> a<\/li>\n<ul>\n<li><input type="checkbox" disabled> b<\/li>\n<\/ul>\n<\/ul>/)
  assert.match(html, /<blockquote>note<\/blockquote>/)
  assert.match(html, /<hr>/)
  assert.match(html, /<pre>&lt;raw&gt;<\/pre>/)
})
