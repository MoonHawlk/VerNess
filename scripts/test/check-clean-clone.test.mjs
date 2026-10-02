/**
 * `scripts/check-clean-clone.mjs` (T-311) — the clean-clone check behind the opt-in pre-push hook.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO } from '../lib/util.mjs'
import { checkCleanClone, pushedCommits } from '../check-clean-clone.mjs'

const SCRIPT = join(REPO, 'scripts', 'check-clean-clone.mjs')
const run = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8', windowsHide: true, ...opts })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
const Z = '0'.repeat(40)

test('--help prints usage, names the hook install and exits 0', () => {
  const r = run(['--help'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /core\.hooksPath scripts\/hooks/)
})

test('pushedCommits: local shas of pushed refs, deletions dropped, de-duplicated, CRLF-tolerant', () => {
  const stdin = `refs/heads/a aaa111 refs/heads/a ${Z}\r\n(delete) ${Z} refs/heads/gone bbb222\nrefs/tags/v1 aaa111 refs/tags/v1 ${Z}\n\n`
  assert.deepEqual(pushedCommits(stdin), ['aaa111'])
  assert.deepEqual(pushedCommits(''), [])
})

test('FINESS_SKIP_CLEAN_CLONE=1 skips the check', () => {
  const r = run(['nosuchrev'], { env: { ...process.env, FINESS_SKIP_CLEAN_CLONE: '1' } })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /skipped/)
})

test('--hook with nothing pushed (only deletions) passes without cloning', () => {
  const r = run(['--hook'], { input: `(delete) ${Z} refs/heads/x abc\n`, env: { ...process.env, FINESS_SKIP_CLEAN_CLONE: '' } })
  assert.equal(r.code, 0, r.out)
  assert.equal(r.out.trim(), '')
})

test('an unknown rev fails, and the committed HEAD starts from a clean clone', () => {
  const bad = checkCleanClone(['no-such-rev-t311'])
  assert.equal(bad.ok, false)
  assert.match(bad.lines.join('\n'), /not a commit/)
  const good = checkCleanClone(['HEAD'])
  assert.equal(good.ok, true, good.lines.join('\n'))
})

test('the versioned pre-push hook is a thin shim over the Node script', () => {
  const hook = readFileSync(join(REPO, 'scripts', 'hooks', 'pre-push'), 'utf8')
  assert.match(hook, /^#!\/bin\/sh\n/)
  assert.doesNotMatch(hook, /\r/, 'CRLF would break the shebang under sh')
  assert.match(hook, /node scripts\/check-clean-clone\.mjs --hook/)
})
