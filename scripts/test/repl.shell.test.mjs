/**
 * `!<cmd>` in the piped REPL (T-181): runs locally with no model, `!!` reports the attachment, and
 * `DSH_PERMISSION_MODE=read-only` refuses it. Uses the environment, never `/access`, so no state is written.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REPO } from '../lib/util.mjs'

/** @param {string} input - piped lines. @param {Record<string,string>} [env] - extra environment. */
function repl(input, env = {}) {
  const home = mkdtempSync(join(tmpdir(), 'finess-shell-'))
  try {
    return spawnSync(process.execPath, [join(REPO, 'scripts', 'finess.mjs'), '--no-model'], {
      cwd: REPO, input, encoding: 'utf8', windowsHide: true, timeout: 60000,
      env: { ...process.env, DSH_HOME: home, NO_COLOR: '1', FINESS_NO_PET: '1', DSH_PERMISSION_MODE: 'workspace-write', ...env },
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
}

test('!cmd runs locally and !!cmd attaches its output, with no model', () => {
  const r = repl('!echo shell-ok-1\n!!echo shell-ok-2\n')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /shell-ok-1/)
  assert.match(r.stdout, /shell-ok-2[\s\S]*output attached to your next task/)
})

test('!cmd is refused under read-only access', () => {
  const r = repl('!echo should-not-run\n', { DSH_PERMISSION_MODE: 'read-only' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /access is read-only - ! commands are refused/)
  assert.doesNotMatch(r.stdout, /should-not-run\r?\n/)
})
