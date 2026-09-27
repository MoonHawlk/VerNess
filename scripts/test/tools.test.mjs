/**
 * `scripts/tools/*` — the read-only repo tools agents use instead of ad-hoc grep chains. Each must
 * answer `--help`, and the checks that gate work (backlog IDs, docs links) must pass on the repo.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { REPO } from '../lib/util.mjs'

const DIR = join(REPO, 'scripts', 'tools')
const tools = readdirSync(DIR).filter(f => f.endsWith('.mjs') && !f.startsWith('_'))

/** @param {string[]} args - node arguments. @returns {{code: number, out: string}} the result. */
const run = args => {
  const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', windowsHide: true })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

for (const t of tools) {
  test(`${t} --help prints its usage and exits 0`, () => {
    const r = run([join(DIR, t), '--help'])
    assert.equal(r.code, 0, r.out)
    assert.ok(r.out.trim().length > 20, `${t} printed no usage`)
  })
}

test('backlog --check: no task ID is defined twice', () => {
  const r = run([join(DIR, 'backlog.mjs'), '--check'])
  assert.equal(r.code, 0, r.out)
})

test('docs --problems: no broken links or outdated status versions', () => {
  const r = run([join(DIR, 'docs.mjs'), '--problems'])
  assert.equal(r.code, 0, r.out)
})

// A fresh clone has no .engram/ (gitignored): the graph half is skipped there, not failed.
const hasGraph = existsSync(join(REPO, '.engram', 'graph.json'))

test('where finds a known function in the code graph and in the docs', { skip: !hasGraph && 'no Engram graph in this checkout' }, () => {
  const r = run([join(DIR, 'where.mjs'), 'optionHash', '--limit', '2'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /docs: \d+ line/)
})
