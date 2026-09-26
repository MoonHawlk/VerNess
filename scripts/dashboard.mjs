#!/usr/bin/env node
/**
 * Task dashboard — a single self-contained HTML file built from what the harness already records:
 * the substrate's durable session logs, the shadow decision log, and team-run transcripts.
 *
 * Static on purpose: no server, no ports, no dependencies, no network. It is generated on demand,
 * opens from the filesystem, and works offline — the same reasoning that keeps the rest of the
 * launcher dependency-free.
 * @module scripts/dashboard
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { inline, markdownToHtml, parseBacklog } from './lib/backlog.mjs'
import { listSessions, readSessionEvents } from './lib/sessions.mjs'
import { REPO, WIN, human, info, num, ok, step } from './lib/util.mjs'

/** How many sessions get a full event timeline; older ones keep their summary row only. */
const DETAIL_LIMIT = 25

/**
 * @param {unknown} v - any value.
 * @returns {string} the value escaped for HTML text and attributes.
 */
const esc = v => String(v ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

/** @param {number} ms - a duration. @returns {string} a compact human duration. */
function dur(ms) {
  const n = Number(ms ?? 0)
  if (n <= 0) return '-'
  if (n < 1000) return `${n} ms`
  if (n < 60000) return `${(n / 1000).toFixed(1)} s`
  return `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`
}

/**
 * Walk one session's events into the shape the page renders: a timeline, tool calls and totals.
 * @param {object} summary - a session summary from `listSessions`.
 * @returns {object} the detailed session record.
 */
function detail(summary) {
  const events = readSessionEvents(join(summary.dir, 'session.v4.jsonl.zstd'))
  const t0 = events.find(e => typeof e.time === 'number')?.time ?? 0
  const timeline = []
  const tools = []
  let prompt
  let answer
  for (const e of events) {
    const at = Math.max(0, Number(e.time ?? t0) - t0)
    switch (e.type) {
      case 'user/message': {
        const text = (e.data?.message?.content ?? []).map(c => c.text ?? '').join(' ').trim()
        if (prompt === undefined && text !== '') prompt = text
        timeline.push({ at, kind: 'prompt', text: text.slice(0, 400) })
        break
      }
      case 'tool/call': {
        const args = typeof e.data?.arguments === 'string' ? e.data.arguments : JSON.stringify(e.data?.arguments ?? {})
        tools.push({ name: e.data?.name, args: args.slice(0, 300), at })
        timeline.push({ at, kind: 'tool', text: `${e.data?.name} ${args.slice(0, 160)}` })
        break
      }
      case 'tool/result': {
        const okFlag = e.data?.error === undefined
        timeline.push({ at, kind: okFlag ? 'result' : 'error', text: okFlag ? 'tool result' : `tool error: ${String(e.data?.error).slice(0, 200)}` })
        break
      }
      case 'assistant/message': {
        const content = e.data?.message?.content ?? []
        const text = content.filter(c => c.type === 'text').map(c => c.text).join(' ').trim()
        const think = content.filter(c => c.type === 'reasoning').map(c => c.text).join(' ').trim()
        if (text !== '') answer = text
        timeline.push({
          at,
          kind: 'assistant',
          text: (text !== '' ? text : think).slice(0, 400),
          usage: e.data?.usage,
          reasoning: think !== '' && text === '',
        })
        break
      }
      case 'turn/end':
        timeline.push({ at, kind: 'turn-end', text: `turn ${e.data?.turn} ${e.data?.reason?.kind ?? ''}` })
        break
      default: break
    }
  }
  const last = events[events.length - 1]?.time ?? t0
  const routes = [...summary.routes.values()]
  return {
    id: summary.id,
    identity: summary.identity,
    title: summary.title ?? '(untitled)',
    at: summary.at,
    wall: last - t0,
    turns: summary.turns,
    steps: summary.steps,
    toolCalls: summary.toolCalls,
    bytes: summary.bytes,
    route: routes.map(r => `${r.provider}/${r.model}`).join(', '),
    inputTokens: routes.reduce((a, r) => a + r.inputTokens, 0),
    outputTokens: routes.reduce((a, r) => a + r.outputTokens, 0),
    prompt: (prompt ?? '').slice(0, 300),
    answer: (answer ?? '').slice(0, 600),
    timeline: timeline.slice(0, 120),
    tools,
  }
}

/** @returns {object[]} every shadow decision recorded, newest last. */
function readDecisions() {
  const dir = join(REPO, '.verness', 'decisions')
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.jsonl')) continue
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try { out.push(JSON.parse(line)) } catch { /* partial line */ }
    }
  }
  return out
}

/** @returns {object[]} recorded team runs, newest first. */
function readTeamRuns() {
  const root = join(REPO, '.verness', 'runs')
  if (!existsSync(root)) return []
  const runs = []
  for (const team of readdirSync(root)) {
    const teamDir = join(root, team)
    if (!statSync(teamDir).isDirectory()) continue
    for (const stamp of readdirSync(teamDir)) {
      const dir = join(teamDir, stamp)
      if (!statSync(dir).isDirectory()) continue
      const files = readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'summary.md')
      const tasks = files.map(f => {
        const body = readFileSync(join(dir, f), 'utf8')
        const persona = /- persona: (.+)/.exec(body)?.[1] ?? '?'
        const exit = /- exit: (\d+)/.exec(body)?.[1] ?? '?'
        const seconds = /- seconds: ([\d.]+)/.exec(body)?.[1] ?? '?'
        return { id: f.replace(/\.md$/, ''), persona, exit, seconds, path: join(dir, f) }
      })
      runs.push({ team, stamp, dir, tasks, at: statSync(dir).mtime })
    }
  }
  return runs.sort((a, b) => b.at - a.at)
}

/** @returns {{tasks: object[], html: string}} open backlog tasks and the rendered backlog file. */
export function readBacklog() {
  const file = join(REPO, 'docs', '03-BACKLOG.md')
  if (!existsSync(file)) return { tasks: [], html: '' }
  const md = readFileSync(file, 'utf8')
  return { tasks: parseBacklog(md).map(t => ({ ...t, html: inline(t.text) })), html: markdownToHtml(md) }
}

/**
 * Render the page. Minimal CSS, no external assets, both colour schemes.
 * @param {object} data - everything the page shows.
 * @returns {string} the HTML document.
 */
function render(data) {
  const { sessions, decisions, teamRuns, totals, generated, backlog = { tasks: [], html: '' } } = data
  const agreeRate = decisions.length === 0
    ? '-'
    : `${Math.round((decisions.reduce((a, d) => a + (d.agreement ?? 0), 0) / (decisions.length * 3)) * 100)}%`
  const decisionMs = decisions.map(d => d.ms).filter(n => typeof n === 'number').sort((a, b) => a - b)
  const p50 = decisionMs.length === 0 ? '-' : `${decisionMs[Math.floor(decisionMs.length / 2)]} ms`

  const card = (label, value, sub) =>
    `<div class="card"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div>${sub === undefined ? '' : `<div class="s">${esc(sub)}</div>`}</div>`

  const sessionRows = sessions.map((s, i) => `
    <tr class="row" data-i="${i}">
      <td class="mono">${esc(s.id.slice(0, 8))}</td>
      <td>${esc(new Date(s.at).toISOString().slice(5, 16).replace('T', ' '))}</td>
      <td class="title">${esc(s.title)}</td>
      <td class="n">${esc(s.turns)}</td>
      <td class="n">${esc(s.toolCalls)}</td>
      <td class="n">${esc(num(s.inputTokens))}</td>
      <td class="n">${esc(num(s.outputTokens))}</td>
      <td class="n">${esc(dur(s.wall))}</td>
      <td class="mono dim">${esc(s.route)}</td>
    </tr>`).join('')

  const decisionRows = decisions.slice(-40).reverse().map(d => `
    <tr>
      <td>${esc(String(d.at).slice(5, 16).replace('T', ' '))}</td>
      <td class="title">${esc(String(d.task ?? '').slice(0, 90))}</td>
      <td class="mono">${esc(d.model?.level?.answer)} <span class="dim">${esc((d.model?.level?.confidence ?? 0).toFixed?.(2))}</span></td>
      <td class="mono">${esc(d.rules?.level)}</td>
      <td class="mono">${esc(d.model?.tier?.answer)} / ${esc(d.rules?.tier)}</td>
      <td class="mono">${esc(d.model?.pipeline?.answer)} / ${esc(d.rules?.pipeline)}</td>
      <td class="n ${d.agreement === 3 ? 'good' : d.agreement === 0 ? 'bad' : ''}">${esc(d.agreement)}/3</td>
      <td class="n">${esc(d.ms)} ms</td>
    </tr>`).join('')

  const teamRows = teamRuns.slice(0, 15).map(r => `
    <tr>
      <td class="mono">${esc(r.team)}</td>
      <td>${esc(String(r.stamp).slice(5, 16).replace('T', ' '))}</td>
      <td class="n">${esc(r.tasks.length)}</td>
      <td>${r.tasks.map(t => `<span class="pill ${t.exit === '0' ? 'good' : 'bad'}">${esc(t.id)} · ${esc(t.persona)} · ${esc(t.seconds)}s</span>`).join(' ')}</td>
      <td class="mono dim">${esc(r.dir.replace(REPO, '.'))}</td>
    </tr>`).join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VerNess — task dashboard</title>
<style>
:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1a1a18;--dim:#6b6b66;--line:#e3e3df;--card:#fff;--accent:#2f6f4f;--bad:#a33;--good:#2f6f4f}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#e8e8e4;--dim:#8f8f88;--line:#2a2a28;--card:#1c1c1a;--accent:#7fc0a0;--bad:#e08585;--good:#7fc0a0}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px}
h1{font-size:18px;margin:0 0 2px}h2{font-size:14px;margin:28px 0 8px;font-weight:600}
.sub{color:var(--dim);font-size:12px;margin-bottom:18px}
.cards{display:flex;flex-wrap:wrap;gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:120px;flex:1 1 120px}
.card .k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.card .v{font-size:20px;font-variant-numeric:tabular-nums}
.card .s{color:var(--dim);font-size:11px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.04em;font-weight:600}
tr:last-child td{border-bottom:none}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.dim{color:var(--dim)}.good{color:var(--good)}.bad{color:var(--bad)}
.title{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row{cursor:pointer}.row:hover{background:color-mix(in srgb,var(--accent) 8%,transparent)}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:11px;margin:1px 0}
.detail{display:none;background:var(--card);border:1px solid var(--line);border-top:none;border-radius:0 0 8px 8px;padding:14px}
.detail.open{display:block}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px;font-size:12px}
.bar select,.bar input,.bar button,td select{font:inherit;font-size:12px;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 6px}
.bar button{cursor:pointer}.bar input{flex:1 1 180px}
.bl td.grp{color:var(--dim);font-size:12px;max-width:200px}
.bl tr.subtask td.mono{padding-left:22px}
.p0{color:var(--bad);font-weight:600}.p1{color:var(--accent);font-weight:600}
.md{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:4px 18px;margin-top:8px}
.md h2{font-size:15px}.md h3{font-size:14px}.md h4{font-size:13px}.md ul{padding-left:20px;margin:4px 0}.md li{margin:2px 0}
.md blockquote{margin:6px 0;padding:2px 10px;border-left:3px solid var(--line);color:var(--dim)}
.md code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;background:var(--bg);border-radius:4px;padding:0 3px}
.md .cont{margin-left:22px;color:var(--dim)}.md a{color:var(--accent)}
.tl{display:grid;grid-template-columns:70px 90px 1fr;gap:2px 10px;font-size:12px}
.tl .t{color:var(--dim);font-variant-numeric:tabular-nums;text-align:right}
.tl .k{color:var(--dim)}
.tl .x{white-space:pre-wrap;word-break:break-word;border-bottom:1px solid var(--line);padding-bottom:4px;margin-bottom:4px}
.kind-tool .k{color:var(--accent)}.kind-error .k{color:var(--bad)}
details summary{cursor:pointer;color:var(--dim);font-size:12px;margin-top:8px}
pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;overflow:auto;font-size:11px;max-height:280px}
footer{color:var(--dim);font-size:11px;margin-top:28px;border-top:1px solid var(--line);padding-top:10px}
</style></head><body>
<h1>VerNess — task dashboard</h1>
<div class="sub">generated ${esc(generated)} · ${esc(totals.sessions)} sessions · click a row to open its timeline · regenerate with <span class="mono">/dashboard</span></div>

<div class="cards">
${card('sessions', num(totals.sessions))}
${card('turns', num(totals.turns))}
${card('tool calls', num(totals.toolCalls))}
${card('input tokens', num(totals.inputTokens))}
${card('output tokens', num(totals.outputTokens))}
${card('model time', dur(totals.wall), 'sum of session wall time')}
${card('decisions', num(decisions.length), `p50 ${p50} · ${agreeRate} agree with rules`)}
</div>

<h2>Backlog <span class="dim">(${esc(backlog.tasks.length)} open · docs/03-BACKLOG.md · priorities stay in this browser)</span></h2>
<div class="bar">
  <input id="bl-q" placeholder="filter by id or text">
  <select id="bl-g"><option value="">all groups</option>${[...new Set(backlog.tasks.map(t => t.group))].map(g => `<option>${esc(g)}</option>`).join('')}</select>
  <select id="bl-p"><option value="">any priority</option><option>P0</option><option>P1</option><option>P2</option><option>P3</option><option value="-">unset</option></select>
  <label><input type="checkbox" id="bl-sort"> sort by priority</label>
  <button id="bl-copy">copy prioritized list</button>
  <span id="bl-msg" class="dim"></span>
</div>
<table class="bl"><thead><tr><th>priority</th><th>id</th><th>task</th><th>group</th></tr></thead>
<tbody id="bl-body">${backlog.tasks.length === 0 ? '<tr><td colspan="4" class="dim">no open tasks found in docs/03-BACKLOG.md</td></tr>' : ''}</tbody></table>
<details><summary>full backlog file (rendered)</summary><div class="md">${backlog.html}</div></details>

<h2>Sessions</h2>
<table><thead><tr><th>id</th><th>when</th><th>title</th><th class="n">turns</th><th class="n">tools</th><th class="n">in</th><th class="n">out</th><th class="n">wall</th><th>route</th></tr></thead>
<tbody>${sessionRows || '<tr><td colspan="9" class="dim">no sessions yet</td></tr>'}</tbody></table>
<div id="detail" class="detail"></div>

<h2>Decisions <span class="dim">(shadow mode — logged, never applied)</span></h2>
<table><thead><tr><th>when</th><th>task</th><th>level (model)</th><th>level (rules)</th><th>tier m/r</th><th>pipeline m/r</th><th class="n">agree</th><th class="n">latency</th></tr></thead>
<tbody>${decisionRows || '<tr><td colspan="8" class="dim">no decisions logged — enable decisions.enabled or run /decide</td></tr>'}</tbody></table>

<h2>Team runs</h2>
<table><thead><tr><th>team</th><th>when</th><th class="n">tasks</th><th>outcome</th><th>transcripts</th></tr></thead>
<tbody>${teamRows || '<tr><td colspan="5" class="dim">no team runs yet — /team run &lt;id&gt;</td></tr>'}</tbody></table>

<footer>Backlog from <span class="mono">docs/03-BACKLOG.md</span>. Read from the substrate's durable session logs, <span class="mono">.verness/decisions/*.jsonl</span> and <span class="mono">.verness/runs/</span>. Static file, no server, no network.</footer>

<script>
const BACKLOG = ${JSON.stringify(backlog.tasks).replaceAll('<', '\\u003c')};
(() => {
  const KEY = 'verness.backlog.priority';
  let prio = {};
  try { prio = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { prio = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prio)); } catch { /* storage blocked */ } };
  const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rank = id => ({ P0: 0, P1: 1, P2: 2, P3: 3 }[prio[id]] ?? 4);
  const $ = id => document.getElementById(id);
  const visible = () => {
    const q = $('bl-q').value.toLowerCase(), g = $('bl-g').value, p = $('bl-p').value;
    let rows = BACKLOG.filter(t => (g === '' || t.group === g)
      && (p === '' || (p === '-' ? !prio[t.id] : prio[t.id] === p))
      && (q === '' || (t.id + ' ' + t.text).toLowerCase().includes(q)));
    if ($('bl-sort').checked) rows = rows.map((t, i) => [t, i]).sort((a, b) => rank(a[0].id) - rank(b[0].id) || a[1] - b[1]).map(x => x[0]);
    return rows;
  };
  const draw = () => {
    if (BACKLOG.length === 0) return;
    $('bl-body').innerHTML = visible().map(t => '<tr class="' + (t.parent ? 'subtask' : '') + '">'
      + '<td><select data-id="' + esc(t.id) + '" class="' + (prio[t.id] || '').toLowerCase() + '">'
      + ['', 'P0', 'P1', 'P2', 'P3'].map(v => '<option' + (prio[t.id] === v || (!prio[t.id] && v === '') ? ' selected' : '') + ' value="' + v + '">' + (v || '—') + '</option>').join('')
      + '</select></td><td class="mono">' + esc(t.id) + '</td><td>' + t.html + '</td>'
      + '<td class="grp">' + esc(t.group) + (t.sub ? ' · ' + esc(t.sub) : '') + '</td></tr>').join('')
      || '<tr><td colspan="4" class="dim">nothing matches</td></tr>';
  };
  $('bl-body').addEventListener('change', e => {
    const id = e.target.dataset.id; if (!id) return;
    if (e.target.value === '') delete prio[id]; else prio[id] = e.target.value;
    save(); draw();
  });
  ['bl-q', 'bl-g', 'bl-p', 'bl-sort'].forEach(id => $(id).addEventListener('input', draw));
  $('bl-copy').addEventListener('click', () => {
    const rows = BACKLOG.filter(t => prio[t.id]).sort((a, b) => rank(a.id) - rank(b.id));
    const md = rows.map(t => '- [ ] **' + prio[t.id] + '** ' + t.id + ' ' + t.text).join('\\n');
    const done = n => { $('bl-msg').textContent = n; setTimeout(() => { $('bl-msg').textContent = ''; }, 2500); };
    if (rows.length === 0) return done('set a priority first');
    (navigator.clipboard ? navigator.clipboard.writeText(md) : Promise.reject()).then(() => done(rows.length + ' copied'), () => { window.prompt('copy:', md); });
  });
  draw();
})();
const DATA = ${JSON.stringify(sessions).replaceAll('<', '\\u003c')};
const panel = document.getElementById('detail');
let open = null;
document.querySelectorAll('.row').forEach(row => row.addEventListener('click', () => {
  const i = Number(row.dataset.i);
  if (open === i) { panel.classList.remove('open'); open = null; return; }
  open = i;
  const s = DATA[i];
  const esc = t => String(t ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  panel.innerHTML =
    '<b>' + esc(s.title) + '</b> <span class="dim mono">' + esc(s.identity) + '</span>'
    + '<div class="dim" style="margin:4px 0 10px">' + esc(s.route) + ' · ' + s.turns + ' turns · ' + s.steps + ' steps · '
    + s.toolCalls + ' tool calls · ' + (s.inputTokens || 0) + ' in / ' + (s.outputTokens || 0) + ' out tokens</div>'
    + '<div class="tl">' + s.timeline.map(e =>
        '<div class="t">' + (e.at / 1000).toFixed(1) + 's</div>'
        + '<div class="k kind-' + e.kind + '">' + e.kind + (e.reasoning ? ' (thinking)' : '') + '</div>'
        + '<div class="x">' + esc(e.text) + '</div>').join('')
    + '</div>'
    + (s.tools.length ? '<details><summary>' + s.tools.length + ' tool call(s) with arguments</summary><pre>'
        + esc(s.tools.map(t => t.name + '  ' + t.args).join('\\n')) + '</pre></details>' : '')
    + (s.answer ? '<details><summary>final answer</summary><pre>' + esc(s.answer) + '</pre></details>' : '');
  panel.classList.add('open');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}));
</script>
</body></html>`
}

/**
 * Build the dashboard from local records.
 * @param {object} cfg - the VerNess configuration (unused today; kept for future filters).
 * @param {{open?: boolean, limit?: number}} [opts] - options.
 * @returns {string} the path written.
 */
export function buildDashboard(cfg, opts = {}) {
  const limit = opts.limit ?? DETAIL_LIMIT
  const workspace = REPO.replace(/[\\/:]+/g, '-').replace(/^-+|-+$/g, '')
  step('reading session logs')
  const sessions = listSessions({ workspace, limit }).map(detail)
  const decisions = readDecisions()
  const teamRuns = readTeamRuns()
  const totals = {
    sessions: sessions.length,
    turns: sessions.reduce((a, s) => a + s.turns, 0),
    toolCalls: sessions.reduce((a, s) => a + s.toolCalls, 0),
    inputTokens: sessions.reduce((a, s) => a + s.inputTokens, 0),
    outputTokens: sessions.reduce((a, s) => a + s.outputTokens, 0),
    wall: sessions.reduce((a, s) => a + s.wall, 0),
  }
  const backlog = readBacklog()
  const html = render({ sessions, decisions, teamRuns, totals, backlog, generated: new Date().toISOString().replace('T', ' ').slice(0, 19) })
  const out = join(REPO, '.verness', 'dashboard.html')
  mkdirSync(join(REPO, '.verness'), { recursive: true })
  writeFileSync(out, html, 'utf8')
  ok(`dashboard written (${human(Buffer.byteLength(html))}): ${out}`)
  info(`${totals.sessions} sessions · ${decisions.length} decisions · ${teamRuns.length} team runs · ${backlog.tasks.length} open tasks`)
  if (opts.open !== false) {
    const cmd = WIN ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    spawn(cmd, [out], { detached: true, stdio: 'ignore', shell: WIN }).on('error', () => info('open it manually')).unref()
  }
  return out
}

// Standalone CLI: `node scripts/dashboard.mjs [--no-open] [--limit N]`.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { loadConfigForCli } = await import('./verness.mjs')
  const at = process.argv.indexOf('--limit')
  buildDashboard(loadConfigForCli(), {
    open: !process.argv.includes('--no-open'),
    limit: at >= 0 ? Number(process.argv[at + 1]) : undefined,
  })
}
