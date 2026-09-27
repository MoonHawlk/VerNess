#!/usr/bin/env node
/**
 * `repo` — where the working copy stands, in one screen: branch, what is uncommitted, and how the
 * local branches compare with `origin` and with each other (epic vs main).
 *
 *   node scripts/tools/repo.mjs
 * @module scripts/tools/repo
 */

import { git, helpIf, parseArgs, table } from './_lib.mjs'

helpIf(parseArgs(process.argv.slice(2)), `
repo
  branch, uncommitted files, stashes, ahead/behind per branch vs origin, epic vs main, latest tag`)

git(['fetch', '-q', 'origin'])
const branch = git(['branch', '--show-current']).out || '(detached)'
const status = git(['status', '--porcelain']).out.split('\n').filter(Boolean)
console.log(`branch: ${branch}`)
console.log(`uncommitted: ${status.length === 0 ? 'none' : `${status.length} file(s)`}`)
for (const l of status.slice(0, 15)) console.log(`  ${l}`)
const stashes = git(['stash', 'list']).out.split('\n').filter(Boolean)
if (stashes.length > 0) console.log(`stashes: ${stashes.length} (${stashes[0]})`)

/** @param {string} a - ref. @param {string} b - ref. @returns {string} "ahead/behind" of a vs b. */
const ab = (a, b) => {
  if (git(['rev-parse', '--verify', '-q', b]).code !== 0) return `no ${b}`
  const r = git(['rev-list', '--left-right', '--count', `${a}...${b}`])
  if (r.code !== 0) return '-'
  const [ahead, behind] = r.out.split(/\s+/)
  return `${ahead} ahead, ${behind} behind`
}
const rows = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']).out.split('\n').filter(Boolean)
  .map(b => [b, git(['rev-parse', '--short', b]).out, ab(b, `origin/${b}`), git(['log', '-1', '--format=%s', b]).out.slice(0, 60)])
console.log(`\n${table(['local branch', 'head', `vs origin`, 'last commit'], rows)}`)
console.log(`\nepic vs main: ${ab('origin/epic', 'origin/main')} (on origin)`)
console.log(`latest tag: ${git(['describe', '--tags', '--abbrev=0']).out || 'none'}`)
