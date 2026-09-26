/**
 * Backlog reader for the dashboard: parse `docs/03-BACKLOG.md` into open tasks, and render the
 * file itself as HTML. Covers the Markdown subset the docs use (headings, lists with checkboxes,
 * quotes, rules, inline code/bold/italic/links) — no dependency, no network.
 * @module scripts/lib/backlog
 */

/**
 * @param {unknown} v - any value.
 * @returns {string} the value escaped for HTML text and attributes.
 */
export const esc = v => String(v ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

/**
 * Inline Markdown: code spans are held aside (their contents stay literal), then bold, italic and
 * links apply to the rest — so `**`code`**` still bolds.
 * @param {string} text - one line of Markdown.
 * @returns {string} HTML.
 */
export function inline(text) {
  const codes = []
  const held = String(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
  return esc(held)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(((?!javascript:)[^)\s]+)\)/gi, '<a href="$2">$1</a>')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`)
}

/**
 * Open tasks, in file order. A task is a `- [ ] T-NNN …` line; indented ones are subtasks of the
 * line above. `##` headings are workstreams (kept up to their first ` — ` or `(`); a short plain
 * line under one is a subgroup label.
 * @param {string} md - the backlog file.
 * @returns {{id: string, text: string, group: string, sub: string, parent?: string}[]} open tasks.
 */
export function parseBacklog(md) {
  const tasks = []
  let group = ''
  let sub = ''
  let lastTop
  for (const line of md.split('\n')) {
    const h = /^##\s+(.+)$/.exec(line)
    if (h !== null) { group = h[1].replace(/\s+(?:—|\().*$/, '').trim(); sub = ''; continue }
    const t = /^(\s*)- \[ \] (T-\d+[a-z]?(?: \/ T-\d+)?)\s+(.*)$/.exec(line)
    if (t !== null) {
      const task = { id: t[2], text: t[3].trim(), group, sub }
      if (t[1].length > 0 && lastTop !== undefined) task.parent = lastTop
      else lastTop = t[2]
      tasks.push(task)
      continue
    }
    if (group !== '' && line.trim().length <= 60 && /^[A-Z][^-#>|]*$/.test(line.trim()) && !line.startsWith(' ')) sub = line.trim()
  }
  return tasks
}

/**
 * Render a Markdown document (the subset above) as HTML.
 * @param {string} md - Markdown.
 * @returns {string} HTML.
 */
export function markdownToHtml(md) {
  const out = []
  const stack = []
  let para = []
  const flush = () => { if (para.length > 0) { out.push(`<p>${inline(para.join(' '))}</p>`); para = [] } }
  const closeLists = (depth = 0) => { while (stack.length > depth) out.push(`</${stack.pop()}>`) }
  let fence = null
  for (const raw of md.split('\n')) {
    if (fence !== null) {
      if (raw.trim().startsWith('```')) { out.push(`<pre>${esc(fence.join('\n'))}</pre>`); fence = null } else fence.push(raw)
      continue
    }
    if (raw.trim().startsWith('```')) { flush(); closeLists(); fence = []; continue }
    const line = raw.replace(/\s+$/, '')
    if (line === '') { flush(); closeLists(); continue }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h !== null) { flush(); closeLists(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue }
    if (/^-{3,}$/.test(line)) { flush(); closeLists(); out.push('<hr>'); continue }
    if (line.startsWith('>')) { flush(); closeLists(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue }
    const li = /^(\s*)[-*] (?:\[( |x)\] )?(.*)$/.exec(line)
    if (li !== null) {
      flush()
      const depth = Math.floor(li[1].length / 2) + 1
      while (stack.length < depth) { out.push('<ul>'); stack.push('ul') }
      closeLists(depth)
      const box = li[2] === undefined ? '' : `<input type="checkbox" disabled${li[2] === 'x' ? ' checked' : ''}> `
      out.push(`<li>${box}${inline(li[3])}</li>`)
      continue
    }
    if (stack.length > 0 && /^\s+/.test(raw)) { out.push(`<div class="cont">${inline(line.trim())}</div>`); continue }
    closeLists()
    para.push(line.trim())
  }
  if (fence !== null) out.push(`<pre>${esc(fence.join('\n'))}</pre>`)
  flush()
  closeLists()
  return out.join('\n')
}
