/**
 * `/cost` — what the work cost, priced from `pricing` in `finess.config.json`.
 *
 * Cost is derived, never guessed: tokens come from the session logs, rates come from the config. A
 * local route has no rate and no reported tokens, so it prices at zero *by construction* — which is
 * the honest statement, and the reason the local-first baseline (ADR-0004) exists.
 * @module scripts/commands/cost
 */

import { aggregateUsage, listSessions, priceUsage } from '../lib/sessions.mjs'
import { head, info, num, table, warn } from '../lib/util.mjs'

export default {
  name: 'cost',
  group: 'telemetry',
  summary: 'priced usage per route (rates come from config `pricing`)',
  usage: '/cost [--all] [--limit N]',
  details: [
    'add rates in finess.config.json: "pricing": { "<route>": { "inputPer1M": 0.27, "outputPer1M": 1.1 } }',
    '"<route>/<model>" keys win over "<route>"; add "currency" to change USD',
    'a route with tokens but no rate shows tokens only ("price not configured"), never an assumed price',
  ],
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - flags.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const limitAt = args.indexOf('--limit')
    const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : undefined
    const workspace = args.includes('--all') ? undefined : ctx.workspaceKey
    const sessions = listSessions({ limit, workspace })
    if (sessions.length === 0) { info('no sessions recorded yet — run a task first'); return 0 }

    const { routes, anyReported } = aggregateUsage(sessions)
    const { rows, total, currency, unpriced } = priceUsage(routes, ctx.cfg.pricing ?? {})

    head(`cost over ${sessions.length} session(s)`)
    for (const l of table(
      ['route', 'model', 'input tok', 'output tok', `cost (${currency})`],
      rows.map(r => [
        r.provider, r.model,
        r.reported ? num(r.inputTokens) : '—',
        r.reported ? num(r.outputTokens) : '—',
        r.priced ? r.cost.toFixed(4) : (r.reported ? 'price not configured' : '0.0000'),
      ]),
    )) console.log(`  ${l}`)
    console.log(`  ${(unpriced.length > 0 ? 'total (priced routes only)' : 'total').padEnd(20)} ${total.toFixed(4)} ${currency}`)

    if (!anyReported) {
      info('every route here is local: no tokens billed, no accounting reported — cost is zero by construction')
    }
    if (unpriced.length > 0) {
      warn(`price is not configured for: ${unpriced.join(', ')} - showing tokens only, no cost is guessed`)
      info('write the rate under "pricing" in finess.config.json (key: route, or route/model); see the comment there')
    }
    return 0
  },
}
