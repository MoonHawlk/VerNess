/**
 * The `finess` entry (`scripts/cli.mjs`): the Node-version rule it checks before loading the
 * launcher (T-383), and that it really runs the launcher.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nodeOk } from '../lib/node-version.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('nodeOk follows the engines range ^22.19.0 || >=24.0.0', () => {
  for (const v of ['22.19.0', '22.20.1', '24.0.0', '25.1.0', 'v22.19.0']) assert.equal(nodeOk(v), true, v)
  for (const v of ['22.18.9', '23.5.0', '20.11.0', '18.0.0']) assert.equal(nodeOk(v), false, v)
})

test('cli.mjs has no static import that could pull in .ts before the version check', () => {
  const src = readFileSync(join(REPO, 'scripts', 'cli.mjs'), 'utf8')
  const statics = [...src.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map(m => m[1])
  for (const s of statics) assert.ok(s.startsWith('node:') || s === './lib/node-version.mjs', s)
  const lib = readFileSync(join(REPO, 'scripts', 'lib', 'node-version.mjs'), 'utf8')
  assert.doesNotMatch(lib, /^import\s/m)
})

test('cli.mjs runs the launcher: --list-commands prints valid JSON on stdout', () => {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'cli.mjs'), '--list-commands'], {
    cwd: REPO, encoding: 'utf8', timeout: 30000,
  })
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotThrow(() => JSON.parse(r.stdout), r.stdout.slice(0, 200))
})

test('package.json exposes the entry as the `finess` bin, and every wrapper runs it (T-380)', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
  assert.equal(pkg.bin?.finess, 'scripts/cli.mjs')
  assert.match(readFileSync(join(REPO, pkg.bin.finess), 'utf8'), /^#!\/usr\/bin\/env node\r?\n/)
  for (const w of ['turn_on.sh', 'turn_on.ps1', 'turn_on.cmd']) {
    assert.match(readFileSync(join(REPO, w), 'utf8'), /scripts[\\/]cli\.mjs/, w)
  }
})