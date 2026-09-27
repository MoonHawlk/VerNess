#!/usr/bin/env node
/**
 * `backlog` — the task list without grepping two Markdown files.
 *
 *   node scripts/tools/backlog.mjs                  open tasks per workstream (counts)
 *   node scripts/tools/backlog.mjs --ws WS-E        open tasks of one workstream
 *   node scripts/tools/backlog.mjs T-223 T-398      where each ID is: open, done, or unused
 *   node scripts/tools/backlog.mjs --next-id        the next unused T-### number
 *   node scripts/tools/backlog.mjs --check          duplicate definitions across open + done (exit 1 if any)
 * @module scripts/tools/backlog
 */

import { parseBacklog } from '../lib/backlog.mjs'
import { helpIf, parseArgs, readText, table } from './_lib.mjs'

const args = parseArgs(process.argv.slice(2))
helpIf(args, `
backlog [T-### ...] [--ws <name>] [--next-id] [--check]
  no args     open tasks per workstream, with counts
  T-###       where each ID lives: open (with its line), done, or unused
  --ws X      the open tasks of workstreams whose heading contains X
  --next-id   the next unused task number (checks every doc, not just the backlog)
  --check     duplicate task definitions across 03-BACKLOG.md and 03-BACKLOG-DONE.md`)

const OPEN = 'docs/03-BACKLOG.md'
const DONE = 'docs/03-BACKLOG-DONE.md'
const open = readText(OPEN)
const done = readText(DONE)
const tasks = parseBacklog(open)

/** Every `- [ ] T-123` / `- [x] T-123` definition (IDs with a letter suffix, like T-140L, are distinct). */
const defs = text => [...text.matchAll(/^\s*- \[[ x]\] (T-\d{3}[A-Za-z]?)\b/gm)].map(m => m[1])

if (args['next-id'] === true) {
  const everywhere = [open, done, readText('docs/04-PROGRESS.md'), readText('README.md')].join('\n')
  const used = [...everywhere.matchAll(/T-(\d{3})/g)].map(m => Number(m[1]))
  console.log(`T-${Math.max(...used) + 1}  (highest used anywhere: T-${Math.max(...used)})`)
  process.exit(0)
}

if (args.check === true) {
  const all = [...defs(open), ...defs(done)]
  const repeated = [...new Set(all.filter((id, i) => all.indexOf(id) !== i))]
  // A task split on purpose: its base is done and "*(remaining part)*" is still open (the audit
  // convention in 03-BACKLOG.md). Anything else defined twice is a real clash.
  const isSplit = id => defs(open).filter(x => x === id).length === 1 && defs(done).filter(x => x === id).length === 1
    && new RegExp(`^\\s*- \\[ \\] ${id} \\*\\(remaining part\\)\\*`, 'm').test(open)
  const splits = repeated.filter(isSplit)
  const dups = repeated.filter(id => !isSplit(id))
  if (splits.length > 0) console.log(`split on purpose (base done, remaining part open): ${splits.join(', ')}`)
  if (dups.length === 0) { console.log(`ok: ${all.length} task definitions, no duplicates`); process.exit(0) }
  console.log(`DUPLICATES: ${dups.join(', ')}`)
  process.exit(1)
}

const ids = args._.filter(a => /^T-\d{3}/i.test(a)).map(a => a.toUpperCase())
if (ids.length > 0) {
  for (const id of ids) {
    const o = open.split('\n').findIndex(l => new RegExp(`^\\s*- \\[ \\] ${id}\\b`).test(l))
    const d = done.split('\n').findIndex(l => new RegExp(`^\\s*- \\[x\\] ${id}\\b`).test(l))
    const range = done.split('\n').findIndex(l => new RegExp(`^\\s*- \\[x\\] T-\\d{3}\\.\\.T-\\d{3}`).test(l)
      && (([a, b]) => Number(id.slice(2)) >= a && Number(id.slice(2)) <= b)(l.match(/T-(\d{3})\.\.T-(\d{3})/).slice(1).map(Number)))
    if (o >= 0) console.log(`${id}  OPEN  ${OPEN}:${o + 1}\n  ${open.split('\n')[o].trim().slice(0, 220)}`)
    else if (d >= 0) console.log(`${id}  DONE  ${DONE}:${d + 1}\n  ${done.split('\n')[d].trim().slice(0, 220)}`)
    else if (range >= 0) console.log(`${id}  DONE (in a range)  ${DONE}:${range + 1}`)
    else console.log(`${id}  unused (no definition in the backlog files)`)
  }
  process.exit(0)
}

const groups = new Map()
for (const t of tasks) {
  if (!groups.has(t.group)) groups.set(t.group, [])
  groups.get(t.group).push(t)
}
if (typeof args.ws === 'string') {
  const want = args.ws.toLowerCase()
  for (const [g, ts] of groups) {
    if (!g.toLowerCase().includes(want)) continue
    console.log(`${g} (${ts.length} open)`)
    for (const t of ts) console.log(`  ${t.id}  ${t.text.replace(/\s+/g, ' ').slice(0, 130)}`)
  }
  process.exit(0)
}
console.log(table(['open', 'workstream'], [...groups].map(([g, ts]) => [String(ts.length), g])))
console.log(`\n${tasks.length} open task(s). Details: --ws <name>, or give task IDs.`)
