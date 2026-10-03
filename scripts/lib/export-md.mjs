/**
 * Render one session's events as a readable Markdown transcript (`/export`). Pure: events in, text
 * out. The substrate's own `dsh-session-log-export` is a web-surface plugin (it ships the web
 * `/export`), not callable from the launcher, so the launcher renders the log itself.
 * @module scripts/lib/export-md
 */

const ARG_KEYS = ['path', 'file_path', 'pattern', 'command', 'url', 'query']

/** @param {string} s @param {number} n @returns {string} `s` on one line, cut to `n` chars. */
const clip = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 3)}...` : t }

/** @param {unknown} content - message content (parts or string). @returns {string} its text parts. */
const textOf = content => (typeof content === 'string' ? content : (content ?? []).filter(p => p?.type === 'text').map(p => p.text).join('\n')).trim()

/**
 * Compact one-line summary of a tool call's JSON arguments.
 * @param {string|object} raw - the `arguments` field.
 * @returns {string} e.g. `src/a.js` or `a=1 b=2`.
 */
export function summarizeArgs(raw) {
  let a = raw
  if (typeof raw === 'string') { try { a = JSON.parse(raw) } catch { return clip(raw, 70) } }
  if (a === null || typeof a !== 'object') return clip(a ?? '', 70)
  const key = ARG_KEYS.find(k => typeof a[k] === 'string')
  if (key !== undefined) return clip(a[key], 70)
  return clip(Object.entries(a).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' '), 70)
}

const nf = n => Number(n ?? 0).toLocaleString('en-US')
/** @param {{inputTokens:number, outputTokens:number, reported:boolean}} u @returns {string} usage line body. */
const usageText = u => (u.reported ? `${nf(u.inputTokens)} in / ${nf(u.outputTokens)} out` : 'not reported')

/**
 * @param {object[]} events - a session's events, in append order.
 * @param {{id?: string}} [opts] - the short id to show.
 * @returns {string} the Markdown document (ends with a newline).
 */
export function renderSessionMarkdown(events, opts = {}) {
  const head = events.find(e => e.type === 'session')
  const routes = []
  for (const e of events) {
    const c = e.type === 'request/header' ? e.data?.header?.config : e.type === 'request/context' ? e.data : undefined
    const r = c?.provider !== undefined ? `${c.provider}/${c.model}` : undefined
    if (r !== undefined && !routes.includes(r)) routes.push(r)
  }
  const turns = []
  const total = { inputTokens: 0, outputTokens: 0, reported: false }
  let cur
  const open = prompt => { cur = { prompt, texts: [], tools: [], usage: { inputTokens: 0, outputTokens: 0, reported: false } }; turns.push(cur) }
  for (const e of events) {
    const d = e.data ?? {}
    if (e.type === 'user/message') { if ((d.source?.kind ?? 'user') === 'user') open(textOf(d.content)) } // runtime-context snapshots are not prompts
    else if (e.type === 'assistant/message') {
      if (cur === undefined) open('')
      const t = textOf(d.message?.content)
      if (t !== '') cur.texts.push(t)
      const u = d.usage ?? d.message?.usage
      if (u !== undefined) {
        for (const x of [cur.usage, total]) {
          x.reported = true
          x.inputTokens += Number(u.inputTokens ?? 0)
          x.outputTokens += Number(u.outputTokens ?? 0)
        }
      }
    } else if (e.type === 'tool/call') {
      if (cur === undefined) open('')
      cur.tools.push({ id: d.callId, name: d.name, args: summarizeArgs(d.arguments), result: undefined })
    } else if (e.type === 'tool/result') {
      const t = cur?.tools.findLast(x => x.id === (d.message?.toolCallId ?? d.callId))
      if (t !== undefined) t.result = d.message?.isError || e.error ? `ERROR ${e.error?.code ?? ''}`.trim() : 'ok'
    }
  }

  const first = turns.find(t => t.prompt !== '')?.prompt ?? ''
  const out = [`# ${clip(first, 80) || 'Session'}`, '']
  out.push(`- Session: ${opts.id ?? String(head?.id ?? '?').replace(/^session-/, '')}`)
  out.push(`- Route: ${routes.length ? routes.join(', ') : 'unknown'}`)
  out.push(`- Started: ${Number.isFinite(head?.createdAt) ? new Date(head.createdAt).toISOString() : 'unknown'}`)
  out.push(`- Turns: ${turns.length}`, '')
  turns.forEach((t, i) => {
    out.push(`## Turn ${i + 1}`, '', '**User**', '', ...t.prompt.split('\n').map(l => `> ${l}`), '')
    if (t.texts.length) out.push('**Assistant**', '', t.texts.join('\n\n'), '')
    if (t.tools.length) out.push('**Tools**', '', ...t.tools.map(x => `- ${x.name} ${x.args} -> ${x.result ?? 'no result'}`), '')
    out.push(`Tokens: ${usageText(t.usage)}`, '')
  })
  out.push('## Total', '', `Tokens: ${usageText(total)}`, '')
  return out.join('\n')
}
