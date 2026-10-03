/**
 * Conversation compaction (T-151). Pure helpers; the command and the patch renderer wire them in.
 *
 * Two mechanisms, because the substrate offers only one of them to a CLI run:
 *  - AUTOMATIC: `@deepseek-ai/dsh-compaction-basic` (mounted by dsh-base) condenses old history when
 *    the request nears `min(W * thresholdRatio, W - O - headroomTokens)`. Its default headroom is
 *    65536 tokens, which leaves NO pressure budget in a 32k window (resolveCompactSpec throws), so
 *    `compact.autoPercent` renders a ratio and a headroom that fit the smallest window we route to.
 *  - MANUAL: the substrate's `/compact` is a command of the interactive surfaces; the headless
 *    runner submits the task text as a plain user message and never dispatches commands. So FiNess's
 *    `/compact` asks the model for a summary, then seeds a new session with it.
 * @module scripts/lib/compact
 */

/** Lowest and highest `autoPercent` accepted; outside it the substrate default is kept. */
export const AUTO_MIN = 20
export const AUTO_MAX = 95

/** Output tokens assumed per request when a route does not say. */
const DEFAULT_OUTPUT = 4096

/**
 * @param {unknown} v - `compact.autoPercent` from the config.
 * @returns {number|undefined} the percent, or undefined when unset, 0 (off) or out of range.
 */
export function autoPercentOf(v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= AUTO_MIN && n <= AUTO_MAX ? n : undefined
}

/**
 * Settings for compaction-basic so automatic compaction starts at `autoPercent` of the window on
 * every listed route. Headroom is what is left of the smallest window after the threshold and the
 * largest output reservation, so `min(W * ratio, W - O - headroom)` resolves to the ratio.
 * @param {number|undefined} autoPercent - from `autoPercentOf`.
 * @param {{contextWindow?: number, maxTokens?: number}[]} routes - routes with a declared window.
 * @returns {{thresholdRatio: number, headroomTokens: number}|undefined} undefined when off or no window is known.
 */
export function compactSettings(autoPercent, routes) {
  if (autoPercent === undefined) return undefined
  const windows = routes.map(r => r.contextWindow).filter(w => Number.isInteger(w) && w > 0)
  if (windows.length === 0) return undefined
  const w = Math.min(...windows)
  const o = Math.max(...routes.map(r => (Number.isInteger(r.maxTokens) && r.maxTokens > 0 ? r.maxTokens : DEFAULT_OUTPUT)))
  const thresholdRatio = autoPercent / 100
  const headroomTokens = Math.max(256, w - o - Math.ceil(w * thresholdRatio))
  return { thresholdRatio, headroomTokens }
}

/**
 * @param {{thresholdRatio: number, headroomTokens: number}|undefined} s - from `compactSettings`.
 * @returns {string[]} the profile-patch lines for the compaction row ([] when nothing to set).
 */
export function renderCompactRow(s) {
  if (s === undefined) return []
  return [
    '# Automatic compaction at compact.autoPercent of the window (the default headroom is larger than a small window).',
    '- id: compaction-basic',
    '  config:',
    `    thresholdRatio: ${s.thresholdRatio}`,
    `    headroomTokens: ${s.headroomTokens}`,
    '',
  ]
}

/** @returns {string} the one-turn prompt that asks the model to condense the conversation. */
export function summaryPrompt() {
  return [
    'Write a dense summary of this conversation so a fresh session can continue the work without it.',
    'Keep: the goal, decisions made and why, files and commands that matter (exact paths and names),',
    'what is done, what is still open, and any constraint the operator gave.',
    'Drop pleasantries and anything already superseded. Plain text, no preamble, at most 400 words.',
  ].join(' ')
}

/**
 * Parse the substrate's `--json` event stream for the committed answer.
 * @param {string} out - captured output.
 * @returns {{answer: string, usage: {input: number, output: number}}} the final text and the tokens spent.
 */
export function parseSummaryRun(out) {
  let answer = ''
  const usage = { input: 0, output: 0 }
  for (const line of String(out ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let e
    try { e = JSON.parse(t) } catch { continue }
    if (e.type === 'final') answer = String(e.text ?? '')
    else if (e.type === 'status' && e.usage !== undefined) {
      usage.input += Number(e.usage.inputTokens ?? 0)
      usage.output += Number(e.usage.outputTokens ?? 0)
    }
  }
  return { answer: answer.trim(), usage }
}

/**
 * The context block that opens the new session: the summary, cut at a line end under the cap.
 * @param {string} summary - the model's summary.
 * @param {number} maxChars - cap for the summary body.
 * @returns {string} the seed text ('' when the summary is empty).
 */
export function seedText(summary, maxChars) {
  let s = String(summary ?? '').trim()
  if (s === '') return ''
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars)
    const nl = cut.lastIndexOf('\n')
    s = `${(nl > maxChars / 2 ? cut.slice(0, nl) : cut).trimEnd()}\n[summary cut at ${maxChars} characters]`
  }
  return `Summary of the earlier conversation (compacted by /compact; continue from it):\n${s}`
}
