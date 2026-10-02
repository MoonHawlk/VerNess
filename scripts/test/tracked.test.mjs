/**
 * T-312: the startup warning for launcher modules git does not track.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { libImports, trackedLibFiles, untrackedImports, warnUntrackedImports } from '../lib/tracked.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('untrackedImports keeps only what git does not list (slashes normalized)', () => {
  const imported = ['scripts/lib/a.mjs', 'scripts/lib/b.mjs', 'scripts/lib/c.mjs']
  assert.deepEqual(untrackedImports(imported, ['scripts/lib/a.mjs', 'scripts\\lib\\c.mjs']), ['scripts/lib/b.mjs'])
  assert.deepEqual(untrackedImports(imported, imported), [])
})

test('libImports follows relative imports transitively, through non-lib scripts too', () => {
  const root = mkdtempSync(join(tmpdir(), 'verness-tracked-'))
  try {
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
    writeFileSync(join(root, 'scripts', 'verness.mjs'), "import { a } from './lib/a.mjs'\nimport './side.mjs'\nconst m = await import('./model.mjs')\n")
    writeFileSync(join(root, 'scripts', 'model.mjs'), "export { c } from './lib/c.mjs'\n")
    writeFileSync(join(root, 'scripts', 'side.mjs'), '')
    writeFileSync(join(root, 'scripts', 'lib', 'a.mjs'), "import { b } from './b.mjs'\nimport { x } from '../../packages/x/src/x.ts'\n")
    writeFileSync(join(root, 'scripts', 'lib', 'b.mjs'), '')
    writeFileSync(join(root, 'scripts', 'lib', 'c.mjs'), '')
    writeFileSync(join(root, 'scripts', 'lib', 'unused.mjs'), '')
    assert.deepEqual(libImports(join(root, 'scripts', 'verness.mjs'), root), ['scripts/lib/a.mjs', 'scripts/lib/b.mjs', 'scripts/lib/c.mjs'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the real launcher imports only tracked lib modules', async () => {
  const tracked = await trackedLibFiles(REPO)
  if (tracked === undefined) return // no git here: nothing to check
  const imported = libImports(join(REPO, 'scripts', 'verness.mjs'), REPO)
  assert.ok(imported.includes('scripts/lib/personas.mjs'))
  assert.deepEqual(untrackedImports(imported, tracked), [])
})

test('outside a git repository the check is silent and returns nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'verness-nogit-'))
  try {
    // A temp dir could sit inside some repository on an odd machine; only assert when it does not.
    const inRepo = spawnSync('git', ['rev-parse'], { cwd: root }).status === 0
    if (!inRepo) {
      assert.equal(await trackedLibFiles(root), undefined)
      assert.deepEqual(await warnUntrackedImports(root), [])
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
