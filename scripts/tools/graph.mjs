#!/usr/bin/env node
/**
 * `graph` — the Engram code graph: size, freshness (built from which commit, and which code files
 * changed since), and the biggest hubs. `--rebuild` refreshes it through the launcher (no LLM calls).
 *
 *   node scripts/tools/graph.mjs              stats + freshness
 *   node scripts/tools/graph.mjs --rebuild    rebuild, then stats
 * @module scripts/tools/graph
 */

import { spawnSync } from 'node:child_process'

import { REPO, git, helpIf, loadGraph, parseArgs, readText, table } from './_lib.mjs'

const args = parseArgs(process.argv.slice(2))
helpIf(args, `
graph [--rebuild]
  nodes/edges/communities, the commit the graph was built from, code files changed since, top hubs.
  --rebuild runs node scripts/finess.mjs graph (engram update ., code only, no LLM)`)

if (args.rebuild === true) {
  const r = spawnSync(process.execPath, ['scripts/finess.mjs', 'graph'], { cwd: REPO, encoding: 'utf8', windowsHide: true })
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter(l => /Rebuilt|updated|error/i.test(l))
  console.log(tail.join('\n') || `rebuild exited ${r.status}`)
}

const g = loadGraph()
if (g === undefined) { console.log('no graph yet: node scripts/tools/graph.mjs --rebuild'); process.exit(1) }
const communities = new Set(g.nodes.map(n => n.community))
console.log(`graph: ${g.nodes.length} nodes, ${g.links.length} edges, ${communities.size} communities, ${new Set(g.nodes.map(n => n.source_file)).size} files`)

let builtFrom = ''
try { builtFrom = JSON.parse(readText('.engram/scope.json')).head ?? '' } catch { /* no scope file */ }
if (builtFrom !== '') {
  const changed = git(['diff', '--name-only', builtFrom, '--', '*.mjs', '*.ts', '*.js']).out.split('\n').filter(Boolean)
  const dirty = git(['status', '--porcelain', '--', '*.mjs', '*.ts', '*.js']).out.split('\n').filter(Boolean)
  const stale = changed.length + dirty.length
  console.log(`built from: ${builtFrom.slice(0, 7)} (HEAD ${git(['rev-parse', '--short', 'HEAD']).out})${stale === 0 ? ' - fresh' : ` - STALE: ${stale} code file(s) changed; run --rebuild`}`)
}

const degree = new Map()
for (const l of g.links) for (const id of [l.source, l.target]) degree.set(id, (degree.get(id) ?? 0) + 1)
const byId = new Map(g.nodes.map(n => [n.id, n]))
const hubs = [...degree].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, d]) => [String(d), byId.get(id)?.label ?? id, byId.get(id)?.source_file ?? ''])
console.log(`\n${table(['edges', 'hub', 'file'], hubs)}`)
