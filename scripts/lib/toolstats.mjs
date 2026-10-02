/**
 * Per-tool call counts, failure rate and latency, read from session-log events (T-271). Pure: events
 * in, numbers out, so the dashboard and tests share it.
 * @module scripts/lib/toolstats
 */

/** Latency buckets (upper bound exclusive, ms) for the histogram; the last is open-ended. */
export const LATENCY_BUCKETS = [100, 500, 1000, 5000, 30000, Infinity]

/** @param {number} ms - a bucket bound. @returns {string} its label. */
const bucketLabel = (ms, i) => (ms === Infinity ? `≥ ${LATENCY_BUCKETS[i - 1] / 1000} s` : ms < 1000 ? `< ${ms} ms` : `< ${ms / 1000} s`)

/**
 * Pair each `tool/call` with its `tool/result`. Results are matched by call id when both carry one,
 * else in order (oldest unanswered call first). A call with no result gets no latency and no verdict.
 * @param {object[]} events - decoded session events.
 * @returns {{name: string, ms: number|undefined, failed: boolean|undefined}[]} one record per call.
 */
export function toolRuns(events) {
  const runs = []
  const pending = []
  const idOf = e => e.data?.id ?? e.data?.callId ?? e.data?.toolCallId ?? e.data?.tool_call_id
  for (const e of events) {
    if (e.type === 'tool/call') {
      const run = { name: String(e.data?.name ?? '?'), ms: undefined, failed: undefined, id: idOf(e), time: e.time }
      runs.push(run)
      pending.push(run)
    } else if (e.type === 'tool/result') {
      const id = idOf(e)
      const at = id === undefined ? 0 : pending.findIndex(r => r.id === id)
      const [run] = pending.splice(Math.max(0, at), 1)
      if (run === undefined) continue
      run.failed = e.data?.error !== undefined
      if (typeof e.time === 'number' && typeof run.time === 'number') run.ms = Math.max(0, e.time - run.time)
    }
  }
  return runs.map(({ name, ms, failed }) => ({ name, ms, failed }))
}

/**
 * @param {number[]} sorted - ascending values.
 * @param {number} q - quantile, 0..1.
 * @returns {number|undefined} the nearest-rank quantile.
 */
const quantile = (sorted, q) => (sorted.length === 0 ? undefined : sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)])

/**
 * Aggregate runs into per-tool rows (busiest first) and a latency histogram over all timed calls.
 * @param {{name: string, ms?: number, failed?: boolean}[]} runs - from {@link toolRuns}, possibly several sessions.
 * @returns {{tools: {name: string, calls: number, failures: number, failRate: number, p50?: number, p95?: number}[], histogram: {label: string, count: number}[], calls: number, failures: number}} the summary.
 */
export function summarizeTools(runs) {
  const by = new Map()
  for (const r of runs) {
    const t = by.get(r.name) ?? { name: r.name, calls: 0, failures: 0, ms: [] }
    t.calls++
    if (r.failed === true) t.failures++
    if (typeof r.ms === 'number') t.ms.push(r.ms)
    by.set(r.name, t)
  }
  const tools = [...by.values()].map(t => {
    const ms = t.ms.sort((a, b) => a - b)
    return { name: t.name, calls: t.calls, failures: t.failures, failRate: t.failures / t.calls, p50: quantile(ms, 0.5), p95: quantile(ms, 0.95) }
  }).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
  const histogram = LATENCY_BUCKETS.map((b, i) => ({ label: bucketLabel(b, i), count: 0 }))
  for (const r of runs) {
    if (typeof r.ms !== 'number') continue
    histogram[LATENCY_BUCKETS.findIndex(b => r.ms < b)].count++
  }
  return { tools, histogram, calls: runs.length, failures: runs.filter(r => r.failed === true).length }
}
