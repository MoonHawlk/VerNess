/**
 * Budgets (T-091): limits on tokens, money and time so a run cannot burn them unnoticed. The
 * evaluation is pure over injected usage; `gatherUsage` and `budgetGate` only collect inputs and print.
 * Every limit is optional, and unset means no limit.
 * @module scripts/lib/budget
 */

import { aggregateUsageByDay, listSessions, localDay, priceUsage } from './sessions.mjs'

/** Warn at this share of a limit; refuse at 100%. */
export const WARN_AT = 0.8

/** Budget keys, in display order, with a short label. */
export const BUDGET_KEYS = [
  ['sessionTokens', 'tokens in this session'],
  ['dailyTokens', 'tokens today (all sessions)'],
  ['dailyCost', 'priced cost today'],
  ['taskSeconds', 'wall-clock time per task or round'],
]

/** @param {unknown} v @returns {boolean} true for a usable positive limit. */
const isLimit = v => typeof v === 'number' && Number.isFinite(v) && v > 0

/**
 * Judge usage against the configured limits. `taskSeconds` is enforced as a timeout, not here.
 * @param {Partial<Record<string, number>>|undefined} budget - config `budget`.
 * @param {{sessionTokens?: number, dailyTokens?: number, dailyCost?: number}} usage - what was used so far.
 * @returns {{items: {key: string, limit: number, used: number, remaining: number, ratio: number, level: 'ok'|'warn'|'block'}[], blocked: object[], warned: object[]}} the verdicts.
 */
export function evaluateBudget(budget, usage) {
  const items = []
  for (const [key] of BUDGET_KEYS) {
    if (key === 'taskSeconds' || !isLimit(budget?.[key])) continue
    const limit = budget[key]
    const used = usage?.[key] ?? 0
    const ratio = used / limit
    items.push({ key, limit, used, remaining: Math.max(0, limit - used), ratio, level: ratio >= 1 ? 'block' : ratio >= WARN_AT ? 'warn' : 'ok' })
  }
  return { items, blocked: items.filter(i => i.level === 'block'), warned: items.filter(i => i.level === 'warn') }
}

/**
 * The per-task timeout in milliseconds, or undefined without a `taskSeconds` budget.
 * @param {object|undefined} budget - config `budget`.
 * @returns {number|undefined} milliseconds.
 */
export const taskTimeoutMs = budget => (isLimit(budget?.taskSeconds) ? budget.taskSeconds * 1000 : undefined)

/**
 * Collect usage from session logs.
 * @param {{pricing?: object}} cfg - configuration (`pricing`).
 * @param {{sessionId?: string, sessions?: object[], now?: number}} [opts] - the current session's identity; `sessions` and `now` are for tests.
 * @returns {{sessionTokens: number, dailyTokens: number, dailyCost: number}} usage so far.
 */
export function gatherUsage(cfg, opts = {}) {
  const day = localDay(opts.now ?? Date.now())
  const sessions = opts.sessions ?? listSessions({ limit: 300 }).filter(s => s.days?.has(day))
  let sessionTokens = 0
  const cur = opts.sessionId === undefined ? undefined : sessions.find(s => s.identity === opts.sessionId) ?? (opts.sessions === undefined ? listSessions({ limit: 60 }).find(s => s.identity === opts.sessionId) : undefined)
  for (const r of cur?.routes?.values() ?? []) sessionTokens += r.inputTokens + r.outputTokens
  const today = aggregateUsageByDay(sessions).rows.filter(r => r.day === day)
  const dailyTokens = today.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0)
  return { sessionTokens, dailyTokens, dailyCost: priceUsage(today, cfg.pricing ?? {}).total }
}

const LABEL = Object.fromEntries(BUDGET_KEYS)
/** @param {string} key @param {number} n @returns {string} a number in the unit of its budget. */
export const fmtAmount = (key, n) => (key === 'dailyCost' ? n.toFixed(4) : String(Math.round(n)))

/**
 * Check the budgets before a task starts: one warning line at 80%, a refusal at 100% unless the
 * user allowed one over-budget task with `/budget allow once` (consumed here).
 * @param {object} cfg - configuration.
 * @param {{sessionId?: string, usage?: object, allowOnce?: boolean, consume?: () => void, say?: (line: string) => void}} [io] - injected for tests.
 * @returns {{ok: boolean, lines: string[]}} whether to proceed, and what was said.
 */
export function budgetGate(cfg, io = {}) {
  const lines = []
  const out = l => { lines.push(l); io.say?.(l) }
  const budget = cfg.budget
  if (!BUDGET_KEYS.some(([k]) => k !== 'taskSeconds' && isLimit(budget?.[k]))) return { ok: true, lines }
  const v = evaluateBudget(budget, io.usage ?? gatherUsage(cfg, { sessionId: io.sessionId }))
  for (const w of v.warned) out(`budget: ${LABEL[w.key]} at ${Math.round(w.ratio * 100)}% (${fmtAmount(w.key, w.used)} of ${fmtAmount(w.key, w.limit)})`)
  if (v.blocked.length === 0) return { ok: true, lines }
  const names = v.blocked.map(b => `budget.${b.key} (${fmtAmount(b.key, b.used)} of ${fmtAmount(b.key, b.limit)})`).join(', ')
  if (io.allowOnce === true) {
    io.consume?.()
    out(`budget: over ${names} - running this one task because you allowed it`)
    return { ok: true, lines }
  }
  out(`budget: not started, ${names} is used up. Raise it in finess.config.json or /budget, or run /budget allow once`)
  return { ok: false, lines }
}
