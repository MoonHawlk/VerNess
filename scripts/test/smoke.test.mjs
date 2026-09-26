/**
 * Every launcher module must import cleanly: a syntax error or a missing export in any of them
 * breaks the REPL at boot, and nothing else would catch it before a user does.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { REPO } from '../lib/util.mjs'

for (const dir of ['scripts/lib', 'scripts/commands']) {
  for (const f of readdirSync(join(REPO, dir)).filter(n => n.endsWith('.mjs'))) {
    test(`${dir}/${f} imports`, async () => {
      const mod = await import(pathToFileURL(join(REPO, dir, f)).href)
      assert.ok(mod !== undefined)
    })
  }
}
