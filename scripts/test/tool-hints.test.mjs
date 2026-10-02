/**
 * The tool-hints plugin (`packages/tool-hints`, T-438) and the small-model note. Fixtures are the real
 * failing calls Qwen3 0.6B made in ~/.dsh/sessions (2026-10), so each hint is checked against the
 * mistake it exists for.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, argsOf, cleanPath, hintFor, requiredOf, splitWild } from '../../packages/tool-hints/index.js'
import { modelSizeB, smallModelNote } from '../lib/routes.mjs'

const MISSING = p => `invalid arguments: missing required property "${p}"`

test('argsOf: object, JSON string, junk', () => {
  assert.deepEqual(argsOf({ a: 1 }), { a: 1 })
  assert.deepEqual(argsOf('{"a":1}'), { a: 1 })
  assert.deepEqual(argsOf('{bad'), {})
  assert.deepEqual(argsOf(undefined), {})
  assert.deepEqual(argsOf([1]), {})
})

test('cleanPath and splitWild', () => {
  assert.equal(cleanPath('C:\\x\\personas/"'), 'C:\\x\\personas')
  assert.equal(cleanPath('docs/.'), 'docs')
  assert.deepEqual(splitWild('docs/*.md'), { dir: 'docs', rest: '*.md' })
  assert.deepEqual(splitWild('**/docs/**'), { dir: undefined, rest: '**/docs/**' })
  assert.deepEqual(splitWild('docs'), { dir: 'docs', rest: '' })
})

test('glob with path and no pattern: the hint moves the glob into pattern', () => {
  const h = (path) => hintFor({ tool: 'glob', args: JSON.stringify({ path }), code: 'INVALID_ARGS', message: MISSING('pattern') })
  assert.match(h('docs/*.md'), /Try: glob \{"pattern":"\*\.md","path":"docs"\}$/)
  assert.match(h('**/docs/**'), /Try: glob \{"pattern":"\*\*\/docs\/\*\*"\}$/)
  assert.match(h('docs/**'), /Try: glob \{"pattern":"\*\*","path":"docs"\}$/)
  assert.match(h('docs/.'), /Try: glob \{"pattern":"\*","path":"docs"\}$/)
  assert.match(h('review.patch.yml'), /Try: glob \{"pattern":"review\.patch\.yml"\}$/)
})

test('glob SEARCH_FAILED on a wildcard path: plain directory plus joined pattern', () => {
  const h = hintFor({ tool: 'glob', args: { path: 'docs/*', pattern: '**/*.md' }, code: 'SEARCH_FAILED' })
  assert.match(h, /Try: glob \{"pattern":"\*\/\*\*\/\*\.md","path":"docs"\}$/)
})

test('pwsh without description gets the same command back with one', () => {
  const h = hintFor({ tool: 'pwsh', args: { command: 'Set-Content -Path a.txt -Value ok' }, code: 'INVALID_ARGS', message: MISSING('description') })
  assert.match(h, /Try: pwsh \{"command":"Set-Content -Path a\.txt -Value ok","description":"Run the command"\}$/)
})

test('edit without old_string points at read then write', () => {
  const h = hintFor({ tool: 'edit', args: { new_string: '', file_path: 'ok.txt' }, code: 'INVALID_ARGS', message: MISSING('old_string') })
  assert.match(h, /read \{"file_path":"ok\.txt"\}, then write/)
})

test('other INVALID_ARGS: names what is missing and what is required; nothing to say -> undefined', () => {
  const h = hintFor({ tool: 'grep', args: {}, code: 'INVALID_ARGS', message: MISSING('pattern'), required: ['pattern'] })
  assert.equal(h, 'Hint: grep is missing "pattern" (required: pattern); resend the call with every required field.')
  assert.equal(hintFor({ tool: 'grep', args: {}, code: 'INVALID_ARGS', message: 'invalid arguments: /x: expected number' }), undefined)
})

test('fs failures: read first, glob for a guessed path, list a directory', () => {
  assert.equal(hintFor({ tool: 'write', args: { content: 'x', file_path: 'ok.txt' }, code: 'FS_NOT_OBSERVED' }),
    'Hint: do this first: read {"file_path":"ok.txt"} - then repeat the write.')
  assert.match(hintFor({ tool: 'read', args: { file_path: 'docs/a.txt' }, code: 'FS_NOT_FOUND' }), /glob \{"pattern":"\*\*\/a\.txt"\}$/)
  assert.match(hintFor({ tool: 'read', args: { file_path: 'C:\\r\\personas/"' }, code: 'FS_NOT_FOUND' }), /stray quotes; did you mean "C:\\r\\personas"\?$/)
  assert.match(hintFor({ tool: 'read', args: { file_path: 'docs/' }, code: 'FS_NOT_REGULAR_FILE' }), /glob \{"pattern":"\*","path":"docs"\}$/)
  assert.equal(hintFor({ tool: 'read', args: { file_path: 'x' }, code: 'FS_STALE_VERSION' }), undefined)
})

test('requiredOf reads required: true parameters', () => {
  assert.deepEqual(requiredOf({ parameters: { pattern: { required: true }, path: {} } }), ['pattern'])
  assert.deepEqual(requiredOf(undefined), [])
})

/** A fake ctx that captures the post-execute listener. */
function mount(def) {
  let listener
  apply({ on: (ev, fn) => { assert.equal(ev, 'tools/post-execute'); listener = fn }, tools: { get: () => def } })
  return listener
}

const failure = (code, message) => ({ isError: true, content: [{ type: 'text', text: `Error: ${message}` }], error: { message, info: { name: 'X', code } } })

test('apply: appends the hint to a failed result, keeps other decision fields', async () => {
  const on = mount({ parameters: { pattern: { required: true } } })
  const ctxMsg = [{ role: 'user', content: [] }]
  const d = await on({ name: 'glob', arguments: { path: 'docs/*.md' } }, failure('INVALID_ARGS', MISSING('pattern')),
    async () => ({ kind: 'accept', additionalContexts: ctxMsg }))
  assert.equal(d.kind, 'accept')
  assert.equal(d.additionalContexts, ctxMsg)
  assert.equal(d.content.length, 2)
  assert.equal(d.content[0].text, `Error: ${MISSING('pattern')}`)
  assert.match(d.content[1].text, /^Hint: /)
})

test('apply: success, block and unhinted failures pass through unchanged', async () => {
  const on = mount(undefined)
  const accept = { kind: 'accept' }
  assert.equal(await on({ name: 'glob', arguments: {} }, { isError: false, content: [] }, async () => accept), accept)
  const block = { kind: 'block', feedback: [{ type: 'text', text: 'no' }] }
  assert.equal(await on({ name: 'glob', arguments: { path: 'docs/*' } }, failure('INVALID_ARGS', MISSING('pattern')), async () => block), block)
  assert.equal(await on({ name: 'read', arguments: {} }, failure('FS_STALE_VERSION', 'stale'), async () => accept), accept)
})

test('apply: a later listener\'s replaced content is kept and extended', async () => {
  const on = mount(undefined)
  const d = await on({ name: 'write', arguments: { file_path: 'a' } }, failure('FS_NOT_OBSERVED', 'x'),
    async () => ({ kind: 'accept', content: [{ type: 'text', text: 'replaced' }] }))
  assert.deepEqual(d.content.map(c => c.text.slice(0, 8)), ['replaced', 'Hint: do'])
})

test('modelSizeB and smallModelNote', () => {
  assert.equal(modelSizeB('qwen3:0.6b'), 0.6)
  assert.equal(modelSizeB('hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0'), 0.6)
  assert.equal(modelSizeB('llama3.1:8b'), 8)
  assert.equal(modelSizeB('Qwen3-30B-A3B'), 30)
  assert.equal(modelSizeB('gpt-4o'), undefined)
  assert.equal(modelSizeB(undefined), undefined)
  assert.match(smallModelNote('qwen3:0.6b'), /0\.6B is too small/)
  assert.equal(smallModelNote('llama3.1:8b'), undefined)
  assert.equal(smallModelNote('deepseek-chat'), undefined)
})
