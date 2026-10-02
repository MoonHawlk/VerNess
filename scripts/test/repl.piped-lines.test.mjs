/**
 * A piped stdin (T-439): every line is processed in order even while an earlier command is still
 * running, and EOF ends the process cleanly (no "unsettled top-level await" warning). Read-only commands only: the
 * test must not touch the checkout's /btw notes or launcher state.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REPO } from '../lib/util.mjs'

test('piped lines are all processed in order and EOF exits cleanly', () => {
  const home = mkdtempSync(join(tmpdir(), 'finess-pipe-'))
  try {
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'finess.mjs'), '--no-model'], {
      cwd: REPO, input: '/help\n/config\n/access\n', encoding: 'utf8', windowsHide: true, timeout: 60000,
      env: { ...process.env, DSH_HOME: home, NO_COLOR: '1', FINESS_NO_PET: '1' },
    })
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stderr, /unsettled top-level await/)
    const out = r.stdout
    const help = out.indexOf('anything that is not a command')
    const config = out.indexOf('resolved - what the next task runs with')
    const access = out.indexOf('change it: /access')
    assert.ok(help >= 0 && config > help && access > config, out)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
