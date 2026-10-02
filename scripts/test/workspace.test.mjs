/**
 * `/workspace` (T-363): the session-key encoding matches the substrate's `projectKey`, directory
 * validation, the fallback when a saved directory is gone, and the leading `--workspace` flag.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { activeWorkspace, resolveWorkspace, samePath, takeWorkspaceFlag, workspaceKey, workspaceLabel } from '../lib/workspace.mjs'

test('workspaceKey follows the substrate projectKey (without its -- fences)', () => {
  // The cases from session-persistence-jsonl/tests/jsonl.spec.ts.
  assert.equal(workspaceKey('/Users/qyj/work/deepseek-harness'), 'Users-qyj-work-deepseek-harness')
  assert.equal(workspaceKey('C:\\work\\agent'), 'C-work-agent')
  assert.equal(workspaceKey('/开发/~agent'), '~5F00~53D1-~007Eagent')
  assert.equal(workspaceKey('C:\\Users\\me\\My Project'), 'C-Users-me-My~0020Project')
  assert.equal(workspaceKey('/'), 'root')
})

test('resolveWorkspace accepts a directory, expands ~ and refuses the rest', () => {
  const base = mkdtempSync(join(tmpdir(), 'finess-ws-'))
  try {
    mkdirSync(join(base, 'my app'))
    writeFileSync(join(base, 'file.txt'), 'x')
    const r = resolveWorkspace('my app', { base })
    assert.ok('dir' in r && samePath(r.dir, join(base, 'my app')))
    assert.ok('dir' in resolveWorkspace(`"${join(base, 'my app')}"`))
    assert.ok('dir' in resolveWorkspace('~/my app', { home: base }))
    assert.match(resolveWorkspace('file.txt', { base }).error, /not a directory/)
    assert.match(resolveWorkspace('nope', { base }).error, /not a directory/)
    assert.equal(resolveWorkspace('  ').error, 'no directory given')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('activeWorkspace: repo by default, the saved dir, and a fallback when it is gone', () => {
  const repo = mkdtempSync(join(tmpdir(), 'finess-repo-'))
  const other = mkdtempSync(join(tmpdir(), 'finess-other-'))
  try {
    assert.deepEqual(activeWorkspace({}, repo), { dir: repo, isRepo: true })
    assert.deepEqual(activeWorkspace({ workspace: other }, repo), { dir: other, isRepo: false })
    assert.equal(activeWorkspace({ workspace: repo }, repo).isRepo, true)
    const gone = join(other, 'deleted')
    assert.deepEqual(activeWorkspace({ workspace: gone }, repo), { dir: repo, isRepo: true, missing: gone })
    assert.equal(workspaceLabel({ dir: other, isRepo: false }), other.split(/[\\/]/).pop())
    assert.equal(workspaceLabel({ dir: repo, isRepo: true }), 'this repo')
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})

test('takeWorkspaceFlag strips only leading flags', () => {
  assert.deepEqual(takeWorkspaceFlag(['--workspace', '/p', 'run', 'x']), { argv: ['run', 'x'], workspace: '/p' })
  assert.deepEqual(takeWorkspaceFlag(['--no-model', '--workspace=/p']), { argv: ['--no-model'], workspace: '/p' })
  assert.deepEqual(takeWorkspaceFlag(['fix', '--workspace', '/p']), { argv: ['fix', '--workspace', '/p'] })
  assert.deepEqual(takeWorkspaceFlag([]), { argv: [] })
  assert.deepEqual(takeWorkspaceFlag(['--workspace']), { argv: [], workspace: '' })
})
