/**
 * `finess --no-model` (T-381): the prompt opens with no dsh profile and no model, and a task given on
 * the command line is refused instead of booting anything. `DSH_HOME` is an empty temp dir, so a
 * pass proves nothing under it was needed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REPO } from '../lib/util.mjs'

/**
 * Run the launcher with an isolated `DSH_HOME`.
 * @param {string[]} args - launcher arguments.
 * @param {string} input - piped stdin.
 */
function launcher(args, input) {
  const home = mkdtempSync(join(tmpdir(), 'finess-nomodel-'))
  try {
    return spawnSync(process.execPath, [join(REPO, 'scripts', 'finess.mjs'), ...args], {
      cwd: REPO, input, encoding: 'utf8', windowsHide: true, timeout: 60000,
      env: { ...process.env, DSH_HOME: home, NO_COLOR: '1', FINESS_NO_PET: '1' },
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
}

test('--no-model and --no-start open the prompt without a profile, then exit on an empty line', () => {
  for (const flag of ['--no-model', '--no-start']) {
    const r = launcher([flag], '\n')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /model-less start \(--no-model\)/)
    assert.doesNotMatch(r.stdout, /does not exist yet|is missing/)
  }
})

test('--no-model with a task refuses it instead of booting', () => {
  const r = launcher(['--no-model', 'do', 'a', 'thing'], '')
  assert.notEqual(r.status, 0)
  assert.match(r.stdout + r.stderr, /a task needs the model/)
})
