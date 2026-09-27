#!/usr/bin/env node
/**
 * `where` — locate a concept in code (through the Engram graph) and in the docs, in one call.
 *
 *   node scripts/tools/where.mjs readAnswer
 *   node scripts/tools/where.mjs persona family --limit 5
 *   node scripts/tools/where.mjs calibration --docs-only
 *
 * Code: graph nodes whose label, id or file matches every term, with `file:line`, community and
 * direct neighbours (imports, calls, contains). Docs: tracked Markdown lines that mention the terms,
 * under their nearest heading. Rebuild the graph after code changes: node scripts/tools/graph.mjs --rebuild
 * @module scripts/tools/where
 */

import { helpIf, loadGraph, parseArgs, readText, trackedFiles } from './_lib.mjs'

const args = parseArgs(process.argv.slice(2))
helpIf(args, `
where <term...> [--limit N] [--code-only | --docs-only]
  code (Engram graph): matching definitions with file:line, community and neighbours
  docs (tracked *.md, not upstream/): matching lines under their heading`)

const terms = args._.map(t => t.toLowerCase())
if (terms.length === 0) { console.error('give at least one term: where <term...>'); process.exit(1) }
const limit = Number(args.limit ?? 8)
const hit = s => terms.every(t => String(s).toLowerCase().includes(t))

if (args['docs-only'] !== true) {
  const g = loadGraph()
  if (g === undefined) console.log('code: no graph yet - run node scripts/tools/graph.mjs --rebuild')
  else {
    const byId = new Map(g.nodes.map(n => [n.id, n]))
    const nodes = g.nodes
      .filter(n => hit(`${n.label} ${n.id} ${n.source_file ?? ''}`))
      // Prefer a label match over a file-path-only match, then shorter labels (more specific).
      .sort((a, b) => Number(hit(b.label)) - Number(hit(a.label)) || a.label.length - b.label.length)
    console.log(`code: ${nodes.length} graph node(s) match${nodes.length > limit ? ` (showing ${limit})` : ''}`)
    for (const n of nodes.slice(0, limit)) {
      console.log(`  ${n.label}  ${n.source_file ?? '?'}:${String(n.source_location ?? '').replace(/^L/, '')}  [${n.community_name ?? `community ${n.community}`}]`)
      const out = []
      const inc = []
      for (const l of g.links) {
        if (l.source === n.id && byId.has(l.target)) out.push(`${l.relation} ${byId.get(l.target).label}`)
        else if (l.target === n.id && byId.has(l.source)) inc.push(`${byId.get(l.source).label} ${l.relation}`)
      }
      if (out.length > 0) console.log(`      -> ${[...new Set(out)].slice(0, 6).join(', ')}${out.length > 6 ? ', ...' : ''}`)
      if (inc.length > 0) console.log(`      <- ${[...new Set(inc)].slice(0, 6).join(', ')}${inc.length > 6 ? ', ...' : ''}`)
    }
  }
}

if (args['code-only'] !== true) {
  const found = []
  for (const f of trackedFiles(/\.md$/)) {
    let heading = ''
    readText(f).split('\n').forEach((line, i) => {
      if (/^#{1,6} /.test(line)) heading = line.replace(/^#+ /, '')
      if (hit(line)) found.push({ f, i: i + 1, heading, line: line.trim() })
    })
  }
  const files = [...new Set(found.map(x => x.f))]
  console.log(`docs: ${found.length} line(s) in ${files.length} file(s)${found.length > limit * 2 ? ` (showing ${limit * 2})` : ''}`)
  for (const x of found.slice(0, limit * 2)) {
    console.log(`  ${x.f}:${x.i}  § ${x.heading.slice(0, 50)}\n      ${x.line.slice(0, 150)}`)
  }
}
