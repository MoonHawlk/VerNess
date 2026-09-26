/**
 * Session-log reader. The substrate stores every session as `session.v4.jsonl.zstd` under
 * `$DSH_HOME/sessions/<workspace>/session-<id>/` — JSONL events, written as a sequence of
 * independent zstd frames (each append is its own frame), so a single `zstdDecompressSync` only
 * returns the first one. We split on the zstd magic and decode frame by frame.
 *
 * This is a READ-ONLY view for telemetry (`/usage`, `/cost`, `/sessions`). The session log stays the
 * substrate's source of truth; we never write to it.
 * @module scripts/lib/sessions
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Frames that could not be decoded on the last read of a given log, so callers can report a gap. */
export const lastReadSkippedFrames = new Map()

/** @returns {string} the sessions root, honouring `DSH_HOME`. */
export const sessionsRoot = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')

/**
 * Decode one session log into its events.
 * @param {string} file - path to a `session.v4.jsonl.zstd`.
 * @returns {object[]} the parsed events, in append order; empty when unreadable.
 */
export function readSessionEvents(file) {
  let buf
  try { buf = readFileSync(file) } catch { return [] }
  const offsets = []
  for (let i = 0; ;) {
    const at = buf.indexOf(ZSTD_MAGIC, i)
    if (at < 0) break
    offsets.push(at)
    i = at + 4
  }
  // The magic bytes can also occur inside compressed data, which would split one real frame in two
  // and make both halves undecodable. So a failed slice is merged with the next boundary and retried
  // rather than dropped: a silently skipped frame means undercounted usage with no warning.
  let text = ''
  let skipped = 0
  for (let n = 0; n < offsets.length;) {
    let decoded
    let end = n + 1
    for (; end <= offsets.length; end++) {
      const stop = end < offsets.length ? offsets[end] : buf.length
      try { decoded = zstdDecompressSync(buf.subarray(offsets[n], stop)).toString('utf8'); break } catch { /* widen */ }
    }
    if (decoded === undefined) { skipped++; n++; continue }
    text += decoded
    n = end
  }
  if (skipped > 0) lastReadSkippedFrames.set(file, skipped)
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { events.push(JSON.parse(line)) } catch { /* partial line at the write boundary */ }
  }
  return events
}

/**
 * Summarise one session without keeping its events in memory.
 * @param {string} dir - the `session-<id>` directory.
 * @returns {object|undefined} the summary, or undefined when the log is missing.
 */
export function summarizeSession(dir) {
  const file = join(dir, 'session.v4.jsonl.zstd')
  if (!existsSync(file)) return undefined
  const events = readSessionEvents(file)
  if (events.length === 0) return undefined

  const skippedBefore = lastReadSkippedFrames.get(file) ?? 0
  const s = {
    skippedFrames: skippedBefore,
    // The substrate's identity is the whole directory name ("the identity is opaque, so the exact
    // string is used" - dsh-headless README). `id` is only the short form we print.
    identity: dir.split(/[/\\]/).pop(),
    id: dir.split(/[/\\]/).pop().replace(/^session-/, ''),
    dir,
    title: undefined,
    at: statSync(file).mtime,
    bytes: statSync(file).size,
    events: events.length,
    turns: 0,
    steps: 0,
    toolCalls: 0,
    prompts: 0,
    routes: new Map(), // "provider/model" -> { inputTokens, outputTokens, calls, reported }
    reportedUsage: false,
  }
  let currentRoute
  for (const e of events) {
    switch (e.type) {
      case 'session/title': s.title = e.data?.title ?? s.title; break
      case 'turn/start': s.turns++; break
      case 'step/start': s.steps++; break
      case 'tool/call': s.toolCalls++; break
      case 'user/message': s.prompts++; break
      case 'request/header': {
        const c = e.data?.header?.config
        // Track the route this request actually used: attributing usage to the last key ever
        // inserted charges the wrong model as soon as a session switches route mid-run.
        if (c !== undefined) currentRoute = keyFor(s, c.provider, c.model)
        break
      }
      case 'assistant/message': {
        // `usage` is absent whenever the adapter reported no token accounting — which is the case
        // for OpenAI-compatible local routes. Absence is information, not an error.
        const u = e.data?.usage
        const k = currentRoute ?? keyFor(s, 'unknown', 'unknown')
        const row = s.routes.get(k)
        row.calls++
        if (u !== undefined) {
          s.reportedUsage = true
          row.reported = true
          row.inputTokens += Number(u.inputTokens ?? 0)
          row.outputTokens += Number(u.outputTokens ?? 0)
          row.cacheReadTokens += Number(u.cacheReadTokens ?? 0)
          row.reasoningTokens += Number(u.reasoningTokens ?? 0)
        }
        break
      }
      default: break
    }
  }
  return s
}

/**
 * Ensure a route row exists on a summary.
 * @param {object} s - the summary being built.
 * @param {string} provider - route name.
 * @param {string} model - model id.
 * @returns {string} the row key.
 */
function keyFor(s, provider, model) {
  const k = `${provider ?? 'unknown'}/${model ?? 'unknown'}`
  if (!s.routes.has(k)) {
    s.routes.set(k, { provider, model, calls: 0, reported: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 })
  }
  return k
}

/**
 * List session summaries, newest first.
 * @param {{limit?: number, workspace?: string}} [opts] - `limit` caps the count; `workspace` filters
 *   by the encoded workspace directory name (a substring match).
 * @returns {object[]} the summaries.
 */
export function listSessions(opts = {}) {
  const root = sessionsRoot()
  if (!existsSync(root)) return []
  const dirs = []
  for (const ws of readdirSync(root)) {
    if (opts.workspace !== undefined && !ws.includes(opts.workspace)) continue
    const wsDir = join(root, ws)
    let entries = []
    try { entries = readdirSync(wsDir) } catch { continue }
    for (const e of entries) {
      if (!e.startsWith('session-')) continue
      const dir = join(wsDir, e)
      const file = join(dir, 'session.v4.jsonl.zstd')
      if (existsSync(file)) dirs.push({ dir, at: statSync(file).mtime, workspace: ws })
    }
  }
  dirs.sort((a, b) => b.at - a.at)
  const out = []
  for (const d of dirs) {
    if (opts.limit !== undefined && out.length >= opts.limit) break
    const s = summarizeSession(d.dir)
    if (s !== undefined) { s.workspace = d.workspace; out.push(s) }
  }
  return out
}

/**
 * Aggregate usage across sessions, per route.
 * @param {object[]} sessions - summaries from {@link listSessions}.
 * @returns {{routes: object[], totals: object, anyReported: boolean}} the aggregate.
 */
export function aggregateUsage(sessions) {
  const routes = new Map()
  const totals = { sessions: sessions.length, turns: 0, steps: 0, toolCalls: 0, prompts: 0, inputTokens: 0, outputTokens: 0, calls: 0 }
  let anyReported = false
  for (const s of sessions) {
    totals.turns += s.turns
    totals.steps += s.steps
    totals.toolCalls += s.toolCalls
    totals.prompts += s.prompts
    for (const [k, r] of s.routes) {
      const row = routes.get(k) ?? { ...r, inputTokens: 0, outputTokens: 0, calls: 0, reported: false, sessions: 0 }
      row.calls += r.calls
      row.inputTokens += r.inputTokens
      row.outputTokens += r.outputTokens
      row.reported = row.reported || r.reported
      row.sessions++
      routes.set(k, row)
      totals.calls += r.calls
      totals.inputTokens += r.inputTokens
      totals.outputTokens += r.outputTokens
      anyReported = anyReported || r.reported
    }
  }
  return { routes: [...routes.values()].sort((a, b) => b.calls - a.calls), totals, anyReported }
}

/**
 * Price an aggregate with the configured per-million rates. A route with no rate and no reported
 * tokens is free by construction (a local model); a route with tokens but no rate is unpriced and
 * says so rather than guessing.
 * @param {object[]} routes - rows from {@link aggregateUsage}.
 * @param {Record<string, {inputPer1M?: number, outputPer1M?: number, currency?: string}>} pricing - config table.
 * @returns {{rows: object[], total: number, currency: string, unpriced: string[]}} the priced view.
 */
export function priceUsage(routes, pricing = {}) {
  const rows = []
  const unpriced = []
  let total = 0
  let currency = 'USD'
  for (const r of routes) {
    const rate = pricing[r.provider] ?? pricing[`${r.provider}/${r.model}`]
    if (rate?.currency !== undefined) currency = rate.currency
    if (rate === undefined) {
      if (r.inputTokens + r.outputTokens > 0) unpriced.push(`${r.provider}/${r.model}`)
      rows.push({ ...r, cost: 0, priced: false })
      continue
    }
    const cost = (r.inputTokens / 1e6) * Number(rate.inputPer1M ?? 0) + (r.outputTokens / 1e6) * Number(rate.outputPer1M ?? 0)
    total += cost
    rows.push({ ...r, cost, priced: true })
  }
  return { rows, total, currency, unpriced }
}
