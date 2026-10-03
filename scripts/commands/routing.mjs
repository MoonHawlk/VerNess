/**
 * `/routing` — what the decision model would have routed lately, next to what the rules did (T-255).
 *
 * Reads the shadow log only: zero tokens, no sidecar call. It shows the last N records, then how
 * often the model agrees with the rules per question over the whole log, then the gate (T-223).
 * Agreement is not accuracy — only labels say who was right (`/decisions-data report`) — but a
 * sudden drop in it is the first sign that something changed.
 * @module scripts/commands/routing
 */

import { ROUTING_QUESTIONS, decisionsDir } from '../lib/decisions.mjs'
import { latestGate, readShadow } from '../lib/labels.mjs'
import { activePersonaId, loadPersonas, readState } from '../lib/personas.mjs'
import { catalogModelSpec, effectiveRoute } from '../lib/routes.mjs'
import { TIER_REQUIREMENTS, readRouterRecords, routeByCapability, routerAgreement, routerDir } from '../lib/router.mjs'
import { head, info, table, warn } from '../lib/util.mjs'

/** Records shown when no `--limit` is given. */
const DEFAULT_LIMIT = 10
/** Characters of task text per row. */
const TASK_WIDTH = 40

/**
 * The model's answer to one question in a record, tolerating every shape the log has held: v2
 * records (`{answer, confidence, probabilities, hash}`), older ones without probabilities or hash,
 * an `invalid` answer (an option outside the criteria), or no model entry at all.
 * @param {any} m - `record.model[question]`.
 * @returns {{answer?: string, confidence?: number, invalid?: boolean}} the readout.
 */
export function modelReadout(m) {
  if (typeof m === 'string') return { answer: m }
  if (m === null || typeof m !== 'object') return {}
  if (m.invalid === true) return { invalid: true }
  return {
    answer: typeof m.answer === 'string' ? m.answer : undefined,
    confidence: typeof m.confidence === 'number' ? m.confidence : undefined,
  }
}

/**
 * One line of task text, cut to `width` characters with an ellipsis.
 * @param {unknown} text - the task text.
 * @param {number} [width] - the maximum length.
 * @returns {string} the cut text.
 */
export function truncate(text, width = TASK_WIDTH) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= width ? t : `${t.slice(0, width - 1)}…`
}

/**
 * The table rows for the last `limit` records, newest first: when, task, then `rules / model` per
 * question (the model's confidence in brackets when it was logged).
 * @param {object[]} records - shadow records, oldest first (from `readShadow`).
 * @param {number} limit - how many to show.
 * @param {string[]} [questions] - the question keys.
 * @returns {string[][]} the rows.
 */
export function recentRows(records, limit, questions = Object.keys(ROUTING_QUESTIONS)) {
  return records.slice(-limit).reverse().map(r => [
    String(r.at ?? '').slice(0, 16).replace('T', ' '),
    truncate(r.task),
    ...questions.map(q => {
      const m = modelReadout(r.model?.[q])
      const model = m.invalid === true ? 'invalid' : m.answer === undefined ? '-'
        : m.confidence === undefined ? m.answer : `${m.answer} (${m.confidence.toFixed(2)})`
      return `${r.rules?.[q] ?? '-'} / ${model}`
    }),
  ])
}

/**
 * How often the model agrees with the rules, per question, over every record. Only records where
 * both gave a usable answer count; an invalid or missing model answer is left out of `n` (the rules
 * ran either way).
 * @param {object[]} records - shadow records.
 * @param {string[]} [questions] - the question keys.
 * @returns {Record<string, {agree: number, n: number, rate: number|null}>} per question; `rate` is
 *   null when there is nothing to compare.
 */
export function agreement(records, questions = Object.keys(ROUTING_QUESTIONS)) {
  const out = {}
  for (const q of questions) {
    let agree = 0
    let n = 0
    for (const r of records) {
      const m = modelReadout(r.model?.[q])
      const rule = r.rules?.[q]
      if (m.answer === undefined || typeof rule !== 'string') continue
      n++
      if (m.answer === rule) agree++
    }
    out[q] = { agree, n, rate: n === 0 ? null : agree / n }
  }
  return out
}

/**
 * The router table rows for the last `limit` router records, newest first: when, task, tier, the
 * pick and what actually ran.
 * @param {object[]} records - router records, oldest first.
 * @param {number} limit - how many to show.
 * @returns {string[][]} the rows.
 */
export function routerRows(records, limit) {
  return records.slice(-limit).reverse().map(r => [
    String(r.at ?? '').slice(0, 16).replace('T', ' '),
    truncate(r.task),
    String(r.tier ?? '-'),
    typeof r.pick === 'string' ? r.pick : 'none eligible',
    `${String(r.actual ?? '-')}${r.agree === true ? '' : ' *'}`,
  ])
}

/**
 * Lines describing one live ranking: the requirement, each eligible model with its reasons, then why
 * each other one was left out. Pure.
 * @param {ReturnType<typeof routeByCapability>} r - the ranking.
 * @param {string} actual - `route/model` the next task would actually run on.
 * @returns {string[]} the lines.
 */
export function rankingLines(r, actual) {
  const need = Object.entries(r.need).map(([k, v]) => `${k} ${v}`).join(', ')
  const L = [`tier ${r.tier ?? '-'}; needs ${need === '' ? 'nothing' : need} (persona requirements are declared, advisory)`]
  for (const w of r.warnings) L.push(`warning: ${w}`)
  L.push(`pick: ${r.pick?.key ?? 'nothing eligible'}; actually runs: ${actual}`)
  for (const [i, c] of r.ranked.entries()) L.push(`  ${i + 1}. ${c.key} - ${c.reasons.join('; ')}`)
  for (const x of r.ineligible) L.push(`  -  ${x.key} - ${x.why.join('; ')}`)
  return L
}

export default {
  name: 'routing',
  group: 'decisions',
  summary: 'recent shadow routing decisions: rules vs the decision model, and how often they agree',
  usage: '/routing [--limit N] | /routing --router [tier]',
  details: [
    '--router ranks the models for the active persona now (tier local_large unless named): advisory, never applied',
    'reads .finess/decisions/ only: zero tokens, no call to the decision model',
    'each cell is rules / model (confidence); nothing the model says is applied yet',
    'agreement is model == rules over the whole log; accuracy needs labels (/decisions-data report)',
  ],
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - flags.
   * @returns {Promise<number>} exit code.
   */
  async run(ctx, args) {
    const rAt = args.indexOf('--router')
    if (rAt >= 0) {
      const tier = args[rAt + 1] ?? 'local_large'
      if (!Object.hasOwn(TIER_REQUIREMENTS, tier)) { warn(`--router takes a tier: ${Object.keys(TIER_REQUIREMENTS).join(', ')}`); return 1 }
      const cfg = ctx.cfg
      const state = readState()
      const persona = loadPersonas(cfg).get(activePersonaId(cfg, state))
      const eff = effectiveRoute(cfg, { state, persona })
      const actual = `${eff.name}/${eff.model ?? '-'}`
      const specFor = (route, model, spec) => (spec.kind === 'catalog' ? catalogModelSpec(cfg, route, model) : undefined)
      const r = routeByCapability(cfg, { state, persona, tier, specFor, facts: { env: process.env }, actual })
      head(`capability router for persona ${persona?.id ?? '-'} (advisory - the route below still decides)`)
      for (const l of rankingLines(r, actual)) console.log(`  ${l}`)
      return 0
    }
    const lAt = args.indexOf('--limit')
    const limit = lAt >= 0 ? Number(args[lAt + 1]) : DEFAULT_LIMIT
    if (!Number.isInteger(limit) || limit <= 0) { warn('--limit takes a positive whole number'); return 1 }
    printRouting(decisionsDir(), limit)
    printRouter(routerDir(), limit)
    return 0
  },
}

/**
 * Print the recent records, the agreement per question and the gate line per question.
 * @param {string} dir - the decisions directory.
 * @param {number} limit - how many recent records to show.
 */
export function printRouting(dir, limit) {
  const records = readShadow(dir)
  if (records.length === 0) {
    warn('no shadow decisions logged yet')
    info('turn on decisions.enabled and decisions.shadow, start the sidecar (/decision up), or try /decide <task>')
    return
  }
  const questions = Object.keys(ROUTING_QUESTIONS)
  const rows = recentRows(records, limit, questions)
  head(`last ${rows.length} of ${records.length} shadow decision(s), newest first - rules / model (confidence)`)
  for (const l of table(['when', 'task', ...questions], rows)) console.log(`  ${l}`)

  head('agreement, model == rules, over the whole log')
  const agr = agreement(records, questions)
  const gate = latestGate(dir, questions)
  const width = Math.max(...questions.map(q => q.length))
  for (const q of questions) {
    const a = agr[q]
    const share = a.rate === null ? 'no comparable records' : `${Math.round(a.rate * 100)}% (${a.agree}/${a.n})`
    console.log(`  ${q.padEnd(width)}  ${share.padEnd(22)}  gate: ${gate[q].pass ? 'PASS' : `HOLD — ${gate[q].why}`}`)
  }
  info('shadow mode: the rules decided every one of these; the gate only reports (/decisions-data gate)')
}

/**
 * Print the capability router's shadow records (T-253) and how often its pick matched what ran.
 * @param {string} dir - the router log directory.
 * @param {number} limit - how many recent records to show.
 */
export function printRouter(dir, limit) {
  const records = readRouterRecords(dir)
  if (records.length === 0) { info('capability router: no shadow picks logged yet (every REPL task logs one)'); return }
  const rows = routerRows(records, limit)
  head(`capability router, last ${rows.length} of ${records.length} - advisory pick vs what ran (* = differs)`)
  for (const l of table(['when', 'task', 'tier', 'pick', 'ran'], rows)) console.log(`  ${l}`)
  const a = routerAgreement(records)
  console.log(`  pick == ran  ${a.rate === null ? 'no picks yet' : `${Math.round(a.rate * 100)}% (${a.agree}/${a.n})`}${a.noPick > 0 ? `, ${a.noPick} with nothing eligible` : ''}`)
  info('advisory: session choice > persona preset > config default (and fallback) decided every run; /routing --router explains a pick')
}
