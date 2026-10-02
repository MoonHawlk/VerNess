/**
 * `!<cmd>`, `!!<cmd>`, `@path` and `@url` (T-181, T-447): classification, reference parsing,
 * expansion with injected fs/fetch, caps, and how attachments compose onto the task.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CAPS, expandRefs, findRefs, htmlToText, runShell, shellAttachment, shellSpec } from '../lib/attach.mjs'
import { classifyLine } from '../lib/commands.mjs'
import { composeTask } from '../lib/notes.mjs'
import { REPO } from '../lib/util.mjs'

test('classifyLine: ! runs a shell command, !! attaches it, # and / are untouched', () => {
  assert.deepEqual(classifyLine('!git status'), { kind: 'shell', text: 'git status', attach: false })
  assert.deepEqual(classifyLine('  !! ls -la '), { kind: 'shell', text: 'ls -la', attach: true })
  assert.deepEqual(classifyLine('!'), { kind: 'shell', text: '', attach: false })
  assert.deepEqual(classifyLine('fix it!'), { kind: 'task', text: 'fix it!' })
  assert.deepEqual(classifyLine('#!x'), { kind: 'brief', text: '!x' })
  assert.deepEqual(classifyLine('mail me@example.com'), { kind: 'task', text: 'mail me@example.com' })
})

test('shellSpec: cmd.exe on Windows (verbatim, one quoted line), /bin/sh elsewhere', () => {
  const w = shellSpec('echo "a b" & dir', 'win32')
  assert.match(w.file, /cmd(\.exe)?$/i)
  assert.deepEqual(w.args, ['/d', '/s', '/c', '"echo "a b" & dir"'])
  assert.equal(w.verbatim, true)
  assert.deepEqual(shellSpec('ls | wc -l', 'darwin'), { file: '/bin/sh', args: ['-c', 'ls | wc -l'], verbatim: false })
})

test('runShell runs the platform shell for real and captures stdout+stderr', () => {
  const r = runShell('echo hello-finess', { cwd: REPO, spawnSync })
  assert.equal(r.code, 0)
  assert.match(r.out, /hello-finess/)
  const bad = runShell('exit 3', { cwd: REPO, spawnSync })
  assert.equal(bad.code, 3)
})

test('shellAttachment labels the command and caps the output', () => {
  const a = shellAttachment('cat x', { code: 0, out: 'y'.repeat(50) }, 10)
  assert.deepEqual(a, { label: '$ cat x (exit 0)', body: 'y'.repeat(10), truncated: true })
})

test('findRefs: start or after whitespace only, so email addresses never expand', () => {
  assert.deepEqual(findRefs('mail bob@example.com about it').map(r => r.ref), [])
  assert.deepEqual(findRefs('@a.txt and (@src/b.js), see @c.md.').map(r => r.ref), ['a.txt', 'src/b.js', 'c.md'])
  assert.deepEqual(findRefs('read @"my notes.txt" twice @a @a').map(r => r.ref), ['my notes.txt', 'a'])
  const [u] = findRefs('summarise @https://example.com/x?y=1.')
  assert.equal(u.url, true)
  assert.equal(u.ref, 'https://example.com/x?y=1')
  assert.equal(findRefs('see @c.md.')[0].alt, 'c.md.')
})

test('htmlToText drops scripts and tags and decodes entities', () => {
  const t = htmlToText('<html><head><style>p{}</style><script>x()</script><title>T</title></head><body><p>a &amp; b&nbsp;&#65;&#x42;</p><!-- c --><ul><li>one</li><li>two</li></ul></body></html>')
  assert.equal(t, 'T\na & b AB\none\ntwo')
})

/** A temp dir with a text file, a binary file, a big file and a sub-directory. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'finess-attach-'))
  writeFileSync(join(dir, 'a.txt'), 'alpha\n')
  writeFileSync(join(dir, 'bin.dat'), Buffer.from([1, 0, 2, 3]))
  writeFileSync(join(dir, 'big.txt'), 'z'.repeat(CAPS.perItem + 500))
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'x.js'), '1')
  mkdirSync(join(dir, 'sub', 'deep'))
  return dir
}

test('expandRefs: files, directory listings, binary refused, missing left as text, caps warn', async () => {
  const dir = sandbox()
  try {
    const r = await expandRefs('look at @a.txt, @sub @bin.dat @big.txt @nobody and me@x.io', { cwd: dir, fs })
    assert.deepEqual(r.attachments.map(a => a.label), ['a.txt', 'sub/ (directory listing)', 'big.txt'])
    assert.equal(r.attachments[0].body, 'alpha\n')
    assert.equal(r.attachments[1].body, 'deep/\nx.js')
    assert.equal(r.attachments[2].body.length, CAPS.perItem)
    assert.equal(r.attachments[2].truncated, true)
    assert.deepEqual(r.missing, ['@nobody'])
    assert.ok(r.warnings.some(w => /@bin\.dat: not attached - binary/.test(w)))
    assert.ok(r.warnings.some(w => /big\.txt truncated/.test(w)))
    const tight = await expandRefs('@big.txt @a.txt', { cwd: dir, fs, caps: { perItem: 100, total: 100 } })
    assert.equal(tight.attachments.length, 1)
    assert.ok(tight.warnings.some(w => /@a\.txt skipped/.test(w)))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('expandRefs: @url fetches without credentials, strips html, refuses binary and userinfo', async () => {
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url, init })
    if (url.includes('img')) return new Response(new Uint8Array([0, 1]), { headers: { 'content-type': 'image/png' } })
    if (url.includes('down')) return new Response('no', { status: 503 })
    if (url.includes('slow')) throw Object.assign(new Error('t'), { name: 'TimeoutError' })
    return new Response('<p>Hello <b>web</b></p>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
  const r = await expandRefs('@https://example.com/page#frag @https://u:p@example.com/ @https://example.com/img @https://example.com/down @https://example.com/slow', { cwd: REPO, fs, fetch: fakeFetch })
  assert.deepEqual(r.attachments, [{ label: 'https://example.com/page', body: 'Hello web', truncated: false }])
  assert.deepEqual(r.notes, ['fetched https://example.com/page (9 characters attached)'])
  assert.equal(calls.length, 4)
  assert.ok(calls.every(c => !c.url.includes('u:p@') && c.init.credentials === 'omit' && c.init.signal instanceof AbortSignal))
  assert.ok(r.warnings.some(w => /credentials/.test(w)))
  assert.ok(r.warnings.some(w => /not text \(image\/png\)/.test(w)))
  assert.ok(r.warnings.some(w => /HTTP 503/.test(w)))
  assert.ok(r.warnings.some(w => /timed out after 10 s/.test(w)))
})

test('composeTask appends attachments after the task, fenced; no attachments changes nothing', () => {
  assert.equal(composeTask('hi', { attachments: [] }), 'hi')
  const out = composeTask('go', { brief: '- b', attachments: [{ label: 'a.txt', body: 'A', truncated: true }] })
  assert.equal(out, [
    'Project brief from the operator (standing context, not tasks):\n- b', '---', 'go',
    'Attached by the operator (context for the task above):',
    '----- attached: a.txt (truncated) -----\nA\n----- end of a.txt -----',
  ].join('\n\n'))
  assert.match(composeTask('go', { attachments: [{ label: 'x', body: 'X' }] }), /^go\n\nAttached by the operator/)
})
