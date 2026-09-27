#!/usr/bin/env node
/**
 * `docs` — a docs audit in one call: each doc's status line, and the signs that a doc has drifted
 * from the code: stale-status phrases, a status version older than package.json, and relative
 * links to files that do not exist.
 *
 *   node scripts/tools/docs.mjs              every doc: title and status line, then the problems
 *   node scripts/tools/docs.mjs --problems   only the problems (exit 1 if any)
 * @module scripts/tools/docs
 */

import { existsSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

import { REPO, helpIf, parseArgs, readText, trackedFiles } from './_lib.mjs'

const args = parseArgs(process.argv.slice(2))
helpIf(args, `
docs [--problems]
  lists README.md and docs/**/*.md (not the append-only progress log or research digests) with their
  status line, then flags: "not implemented"/"nothing is wired" phrases in status lines, a
  "Status (vX.Y.Z)" older than package.json, and relative links to missing files`)

const version = JSON.parse(readText('package.json')).version
const newer = (a, b) => a.split('.').map(Number).reduce((r, x, i) => r || Math.sign(x - (b.split('.').map(Number)[i] ?? 0)), 0) < 0
const docs = trackedFiles(/^(README\.md|docs\/.*\.md)$/)
  .filter(f => !/^docs\/(04-PROGRESS|research\/|superpowers\/plans\/)/.test(f) || /master-plan|persona-catalog/.test(f))

const problems = []
const confirm = []
const rows = []
for (const f of docs) {
  const text = readText(f)
  const title = /^# (.+)$/m.exec(text)?.[1] ?? ''
  const status = /^>?[ \t]*[^\n]*\bStatus\b[^\n]*$/m.exec(text.split('\n').slice(0, 12).join('\n'))?.[0].replace(/^>\s*/, '') ?? ''
  rows.push(`${f}\n    ${title.slice(0, 80)}${status === '' ? '' : `\n    ${status.slice(0, 140)}`}`)
  // "Not built" is right for a designed-only feature, so it is listed for a human to confirm, not failed.
  if (/not implemented|nothing (in this document )?is\s+wired|planned, not/i.test(status)) confirm.push(`${f}: "${status.slice(0, 90)}"`)
  const v = /Status \(v(\d+\.\d+\.\d+)\)/.exec(status)?.[1]
  if (v !== undefined && newer(v, version)) problems.push(`${f}: status is for v${v}, package.json is v${version}`)
  for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    const target = m[1]
    if (/^[a-z]+:/i.test(target)) continue
    const abs = normalize(join(REPO, dirname(f), target))
    if (!existsSync(abs)) problems.push(`${f}: broken link -> ${target}`)
  }
}

if (args.problems !== true) console.log(`${rows.join('\n')}\n`)
if (confirm.length > 0) console.log(`still true? (status says not built):\n  ${confirm.join('\n  ')}`)
console.log(problems.length === 0 ? `ok: ${docs.length} doc(s), no problems found` : `${problems.length} problem(s):\n  ${problems.join('\n  ')}`)
process.exit(problems.length === 0 ? 0 : 1)
