#!/usr/bin/env node
/**
 * `tests` — run the suite and print only what matters: counts, and each failure with its message.
 * Exits with the suite's exit code, so it can gate a push.
 *
 *   node scripts/tools/tests.mjs                 everything `npm test` runs
 *   node scripts/tools/tests.mjs calibration     only test files whose path contains "calibration"
 *   node scripts/tools/tests.mjs --typecheck     also run the contracts typecheck
 * @module scripts/tools/tests
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { REPO, helpIf, parseArgs } from './_lib.mjs'

const args = parseArgs(process.argv.slice(2))
helpIf(args, `
tests [filter] [--typecheck]
  runs node --test over scripts/test/*.test.mjs and packages/*/test/*.test.ts (the same set as npm test),
  prints pass/fail counts and each failing test with its first error lines; exit code = suite result`)

const filter = args._[0]
// Read the folders, not git: a new, still-untracked test must run too (as it does under npm test).
const inDir = (dir, re) => (existsSync(join(REPO, dir)) ? readdirSync(join(REPO, dir)).filter(f => re.test(f)).map(f => `${dir}/${f}`) : [])
const files = [
  ...inDir('scripts/test', /\.test\.mjs$/),
  ...readdirSync(join(REPO, 'packages')).flatMap(p => inDir(`packages/${p}/test`, /\.test\.ts$/)),
].filter(f => filter === undefined || f.includes(filter))
if (files.length === 0) { console.error(`no test file matches "${filter}"`); process.exit(1) }

const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/g, '')
const count = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(out)?.[1] ?? 0)
console.log(`tests: ${count('pass')} pass, ${count('fail')} fail (${files.length} file(s))`)

const failing = out.split('✖ failing tests:')[1]
if (failing !== undefined) {
  for (const block of failing.split(/\n(?=test at )/).filter(b => b.trim() !== '')) {
    console.log(`\n${block.split('\n').filter(l => l.trim() !== '').slice(0, 8).join('\n')}`)
  }
}

let code = r.status ?? 1
if (args.typecheck === true) {
  const t = spawnSync(process.execPath, [tscEntry(), '-p', 'packages/contracts'], { cwd: REPO, encoding: 'utf8', windowsHide: true })
  const tOut = `${t.stdout ?? ''}${t.stderr ?? ''}`.trim()
  console.log(`typecheck: ${t.status === 0 ? 'clean' : `FAILED\n${tOut.split('\n').slice(0, 15).join('\n')}`}`)
  if (t.status !== 0) code = t.status ?? 1
}
process.exit(code)

/** @returns {string} the local TypeScript compiler's entry, so no shell or `npx` is needed. */
function tscEntry() {
  return `${REPO}/node_modules/typescript/bin/tsc`
}
