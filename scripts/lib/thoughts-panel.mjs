/**
 * Dashboard panel for the thought graph (T-290): the current session's task graph as a tree with
 * its links, the promoted-node inventory per project with provenance (T-297) and pending
 * contradictions (T-296), and the decision model's shadow answers about new nodes (T-295).
 * Used by both the static export and `serve` (scripts/dashboard.mjs renders it into the page).
 * `readThoughtsPanel` does the IO; `renderThoughtsPanel` is pure. Claims and evidence are
 * model-written, so every value is escaped.
 * @module scripts/lib/thoughts-panel
 */

import { readUnit, storeFile } from '../../packages/thoughts/src/adapters.js'
import { foldEvents } from '../../packages/thoughts/src/fold.js'
import { pendingConflicts } from '../../packages/thoughts/src/conflicts.js'
import { originLine } from '../../packages/thoughts/src/provenance.js'
import { recordBytes } from '../../packages/thoughts/src/store.js'
import { readSessionEvents, sessionLogFile } from './sessions.mjs'

/**
 * @typedef {object} PanelData
 * @property {string|undefined} session - the current session identity.
 * @property {boolean} found - whether its log was found.
 * @property {import('../../packages/thoughts/src/schema.js').ThoughtNode[]} nodes - its task's nodes.
 * @property {{project: string, bytes: number, entries: object[], conflicts: object[]}[]} projects - the persistent store.
 * @property {object[]} shadow - `source: 'thoughts'` shadow records, newest last.
 * @property {string[]} errors - what could not be read.
 */

/**
 * Gather the panel's data.
 * @param {{session?: string, dshHome: string, sessionsRoot?: string, decisions?: object[]}} src - the
 *   current session identity, `$DSH_HOME`, the sessions root, and the shadow records already read.
 * @returns {PanelData} the data.
 */
export function readThoughtsPanel({ session, dshHome, sessionsRoot, decisions = [] }) {
  const errors = []
  let nodes = []
  let found = false
  if (session !== undefined) {
    const file = sessionLogFile(session, sessionsRoot)
    if (file !== undefined) {
      found = true
      try { nodes = foldEvents(readSessionEvents(file)).nodes } catch (e) { errors.push(`session log: ${e?.message ?? e}`) }
    }
  }
  let projects = []
  try {
    projects = [...readUnit(storeFile(dshHome))].map(([project, r]) => ({ project, bytes: recordBytes(r), entries: r.nodes, conflicts: pendingConflicts(r) }))
      .sort((a, b) => a.project.localeCompare(b.project))
  } catch (e) { errors.push(`persistent store: ${e?.message ?? e}`) }
  return { session, found, nodes, projects, shadow: decisions.filter(d => d.source === 'thoughts'), errors }
}

/**
 * The task graph as a forest: each node under the first parent it derives from (within the task),
 * roots first. A node with more parents lists them; edges to nodes outside the task are shown as ids.
 * @param {import('../../packages/thoughts/src/schema.js').ThoughtNode[]} nodes - the task's nodes.
 * @returns {{node: object, depth: number, also: string[], usedBy: string[]}[]} rows in display order.
 */
export function graphRows(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const children = new Map()
  const usedBy = new Map()
  for (const n of nodes) {
    for (const p of n.derivedFrom) usedBy.set(p, [...(usedBy.get(p) ?? []), n.id])
    const first = n.derivedFrom.find(p => byId.has(p))
    if (first !== undefined) children.set(first, [...(children.get(first) ?? []), n])
  }
  const rows = []
  const seen = new Set()
  const walk = (n, depth) => {
    if (seen.has(n.id)) return
    seen.add(n.id)
    const first = n.derivedFrom.find(p => byId.has(p))
    rows.push({ node: n, depth, also: n.derivedFrom.filter(p => p !== first || depth === 0), usedBy: usedBy.get(n.id) ?? [] })
    for (const c of children.get(n.id) ?? []) walk(c, depth + 1)
  }
  for (const n of nodes) if (!n.derivedFrom.some(p => byId.has(p))) walk(n, 0)
  for (const n of nodes) walk(n, 0) // cycles cannot happen (ids only point back), but never drop a node
  return rows
}

/**
 * Render the panel.
 * @param {PanelData} data - from {@link readThoughtsPanel}.
 * @param {(v: unknown) => string} esc - the page's HTML escaper.
 * @returns {string} the HTML section.
 */
export function renderThoughtsPanel(data, esc) {
  const line = n => `<span class="mono">${esc(n.id)}</span> <span class="pill">${esc(n.kind)}</span> <span class="pill ${n.confidence === 'verified' ? 'good' : ''}">${esc(n.confidence)}</span> ${esc(n.claim)}`
  const ev = n => (n.evidence.length === 0 ? '' : `<div class="dim mono th-ev">${n.evidence.map(esc).join(' · ')}</div>`)
  const rows = graphRows(data.nodes).map(r => `
    <li style="margin-left:${r.depth * 22}px">${r.depth > 0 ? '<span class="dim">└ </span>' : ''}${line(r.node)}
      ${r.also.length === 0 ? '' : `<span class="dim"> ← ${r.also.map(esc).join(', ')}</span>`}
      ${r.usedBy.length === 0 ? '' : `<span class="dim"> → ${r.usedBy.map(esc).join(', ')}</span>`}
      ${ev(r.node)}</li>`).join('')
  const head = data.session === undefined
    ? 'no current session'
    : `session <span class="mono">${esc(String(data.session).replace(/^session-/, '').slice(0, 12))}</span>${data.found ? '' : ' <span class="dim">(log not found)</span>'}`
  const graph = data.nodes.length === 0
    ? `<div class="dim">${head} · no nodes recorded in this task (the model writes them with think_add)</div>`
    : `<div class="dim">${head} · ${esc(data.nodes.length)} node(s) · ← derives from · → used by</div><ul class="th-tree">${rows}</ul>`

  const projects = data.projects.map(p => {
    const conflicts = p.conflicts.map(c => `<tr><td class="mono bad">${esc(c.id)}</td><td colspan="2">${line(c.entry.node)}<div class="dim">contradicts <span class="mono">${esc(c.against)}</span>: ${esc(c.reason)}</div></td><td class="dim">${esc(originLine(c.entry).trim().replace(/^origin: /, ''))}</td></tr>`).join('')
    const entries = p.entries.map(s => `<tr><td class="mono">${esc(s.node.id)}</td><td>${line(s.node)}${s.node.derivedFrom.length === 0 ? '' : `<span class="dim"> ← ${s.node.derivedFrom.map(esc).join(', ')}</span>`}</td><td class="mono dim">${esc(String(s.storedAt).slice(0, 16).replace('T', ' '))}</td><td class="dim">${esc(originLine(s).trim().replace(/^origin: /, ''))}</td></tr>`).join('')
    return `<h3 class="mono th-proj">${esc(p.project)} <span class="dim">(${esc(p.entries.length)} node(s), ${esc(p.bytes)} bytes${p.conflicts.length === 0 ? '' : `, <span class="bad">${esc(p.conflicts.length)} contradiction(s) pending</span>`})</span></h3>
<table><thead><tr><th>id</th><th>claim</th><th>stored</th><th>provenance</th></tr></thead><tbody>${entries || '<tr><td colspan="4" class="dim">none</td></tr>'}${conflicts}</tbody></table>`
  }).join('')

  const shadow = data.shadow.slice(-15).reverse().map(d => `
    <tr><td>${esc(String(d.at).slice(5, 16).replace('T', ' '))}</td><td class="mono">${esc(d.node)}</td><td class="title">${esc(String(d.task ?? '').slice(0, 90))}</td>
      <td class="mono">${esc(d.model?.persist?.answer)} / ${esc(d.rules?.persist)}</td>
      <td class="mono">${esc(d.model?.contradicts?.answer ?? '-')} / ${esc(d.rules?.contradicts ?? '-')}</td></tr>`).join('')

  return `<h2 id="thoughts">Thought graph <span class="dim">(this task's nodes · persistent nodes per project · /think)</span></h2>
<style>.th-tree{list-style:none;padding:8px 12px;margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px}.th-tree li{padding:3px 0}.th-ev{font-size:11px;margin-left:4px}.th-proj{font-size:13px;margin:14px 0 6px}</style>
${graph}
${data.projects.length === 0 ? '<div class="dim" style="margin-top:8px">no persistent nodes yet - /think promote &lt;n-id&gt; or /think add</div>' : projects}
${data.shadow.length === 0 ? '' : `<h3 class="th-proj">decision model on new nodes <span class="dim">(shadow - logged, never applied · model / rules)</span></h3>
<table><thead><tr><th>when</th><th>node</th><th>claim</th><th>persist?</th><th>contradicts</th></tr></thead><tbody>${shadow}</tbody></table>`}
${data.errors.length === 0 ? '' : `<div class="bad">${data.errors.map(esc).join('<br>')}</div>`}`
}
