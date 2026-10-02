#!/usr/bin/env node
/**
 * `release-notes` — a draft of the next `CHANGELOG.md` entry, from the commits since the last tag
 * and the `03-BACKLOG-DONE.md` lines of their task IDs. A human edits the draft; it writes nothing.
 *
 *   node scripts/tools/release-notes.mjs                          last tag..epic
 *   node scripts/tools/release-notes.mjs --since v0.3.0 --to v0.4.0
 * @module scripts/tools/release-notes
 */

import { doneIndex, groupCommits, nextVersion, renderEntry, setupTriggers } from '../lib/release-notes.mjs'
import { git, helpIf, parseArgs, readText } from './_lib.mjs'

const args = parseArgs(process.argv.slice(2))
helpIf(args, `
release-notes [--since <tag>] [--to <ref>] [--version vX.Y.Z]
  draft the next CHANGELOG.md entry (Added / Changed / Fixed / Upgrade) to stdout; writes nothing
  --since X    start after this ref (default: the last tag reachable from --to)
  --to X       end at this ref (default: epic, or HEAD when there is no epic branch)
  --version X  the heading's version (default: next minor if anything is Added, else next patch)
  Tasks are placed from feat/fix/chore commits whose IDs are in 03-BACKLOG-DONE.md (one bullet per
  done line, so a range like T-374..T-378 is one bullet). Everything else is listed in a review
  comment at the end. Upgrade appears when setup inputs changed (config, profile setup, packages, lockfile).`)

const verify = ref => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).code === 0
const to = typeof args.to === 'string' ? args.to : (verify('epic') ? 'epic' : 'HEAD')
if (!verify(to)) { console.log(`unknown ref: ${to}`); process.exit(1) }
const since = typeof args.since === 'string' ? args.since : git(['describe', '--tags', '--abbrev=0', to]).out
if (since === '' || !verify(since)) { console.log(since === '' ? `no tag reachable from ${to}; pass --since <ref>` : `unknown ref: ${since}`); process.exit(1) }

const range = `${since}..${to}`
const rows = sub => git(['log', '--format=%h%x1f%s', ...sub, range]).out.split('\n').filter(Boolean)
  .map(l => { const [hash, subject] = l.split('\x1f'); return { hash, subject } })
const commits = rows(['--no-merges'])
const merges = rows(['--merges'])
if (commits.length === 0) { console.log(`no commits on ${to} since ${since}`); process.exit(0) }

const { sections, unplaced, open } = groupCommits(commits, doneIndex(readText('docs/03-BACKLOG-DONE.md')))
const triggers = setupTriggers(git(['diff', '--name-only', since, to]).out.split('\n').filter(Boolean))
const version = typeof args.version === 'string' ? args.version : nextVersion(since, sections.Added.length > 0)
const now = new Date()
const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

console.log(`draft for ${range}: ${commits.length} commits, ${merges.length} merges\n`)
console.log(renderEntry({ version, date, sections, triggers, merges: merges.map(m => `${m.hash} ${m.subject}`), unplaced, open }))
