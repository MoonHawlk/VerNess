/**
 * `/context` arithmetic: what the next task carries and roughly what it costs. Pure - the command
 * gathers the inputs. Token counts are ESTIMATES (characters / 4), never the model's own tokenizer.
 * @module scripts/lib/context
 */

/** Fraction of the window at which `/context` warns. */
export const WARN_AT = 0.8

/** @param {number} chars - characters. @returns {number} estimated tokens (chars / 4, rounded up). */
export const estimateTokens = chars => Math.ceil(Math.max(0, Number(chars) || 0) / 4)

/**
 * @typedef {object} ContextPart
 * @property {string} label - what the part is.
 * @property {number} [chars] - its characters (estimated to tokens).
 * @property {number} [tokens] - measured tokens, when known (wins over `chars`).
 * @property {string} [note] - shown beside the row.
 */

/**
 * @param {ContextPart[]} parts - what the next task carries.
 * @param {number} [window] - the model's context window in tokens, when known.
 * @returns {{rows: object[], totalTokens: number, window?: number, pct?: number, over: boolean, hints: string[]}} the report.
 */
export function buildContextReport(parts, window) {
  const rows = parts.map(p => ({
    label: p.label,
    chars: p.chars,
    tokens: p.tokens ?? estimateTokens(p.chars),
    measured: p.tokens !== undefined,
    note: p.note,
  }))
  const totalTokens = rows.reduce((n, r) => n + r.tokens, 0)
  const known = Number.isFinite(window) && window > 0
  const pct = known ? (100 * totalTokens) / window : undefined
  const over = known && totalTokens >= WARN_AT * window
  const hints = []
  if (over) {
    const has = label => rows.some(r => r.label === label && r.tokens > 0)
    if (has('conversation so far')) hints.push('/compact --yes summarizes it into a fresh session (one model turn)', '/new starts a fresh conversation')
    if (has('side notes')) hints.push('/btw drop <n> or /btw clear removes notes')
    if (has('project brief')) hints.push('shorten .finess/brief.md')
    hints.push('a model with a larger context window fits more')
  }
  return { rows, totalTokens, ...(known ? { window, pct } : {}), over, hints }
}

/**
 * @param {ReturnType<typeof buildContextReport>} r - the report.
 * @returns {{lines: string[], warnings: string[]}} plain lines, and the warning/hint lines to print loudly.
 */
export function formatContextReport(r) {
  const w = Math.max(...r.rows.map(x => x.label.length), 5)
  const fmt = n => Number(n).toLocaleString('en-US')
  const lines = r.rows.map(x => {
    const chars = x.chars === undefined ? '' : `${fmt(x.chars)} chars`
    const tok = `${x.measured ? '' : '~'}${fmt(x.tokens)} tok`
    return `${x.label.padEnd(w)}  ${chars.padStart(14)}  ${tok.padStart(10)}${x.note === undefined ? '' : `  ${x.note}`}`
  })
  const win = r.window === undefined ? 'context window unknown' : `${r.pct.toFixed(1)}% of ${fmt(r.window)}`
  lines.push(`${'total'.padEnd(w)}  ${''.padStart(14)}  ${`~${fmt(r.totalTokens)} tok`.padStart(10)}  ${win}`)
  lines.push('(token counts are estimates: characters / 4)')
  const warnings = r.over ? [`the next task fills ${r.pct.toFixed(0)}% of the context window`, ...r.hints.map(h => `  ${h}`)] : []
  return { lines, warnings }
}
