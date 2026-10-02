/**
 * `/config` — the resolved configuration, and for each value the layer that owns it: built-in
 * default, `finess.config.json`, `.finess/state.json`, a persona file, or the environment.
 * Read-only and zero tokens; credentials are masked, never printed.
 * @module scripts/commands/config
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { formatValue, resolvedRows, settingRows } from '../lib/config-sources.mjs'
import { activePersonaId, loadPersonas, readState } from '../lib/personas.mjs'
import { accessMode, effectiveRoute } from '../lib/routes.mjs'
import { REPO, head, info, line, parseJsonc, table, warn } from '../lib/util.mjs'

export default {
  name: 'config',
  group: 'core',
  summary: 'the resolved configuration, and which file owns each value',
  usage: '/config [<filter>]',
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - an optional filter on the key names.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const cfg = ctx.cfg
    const file = join(REPO, 'finess.config.json')
    let raw
    if (existsSync(file)) {
      try { raw = parseJsonc(readFileSync(file, 'utf8')) } catch (e) { warn(`finess.config.json is not valid JSON (${e.message}); attributing everything to defaults`) }
    }
    const state = readState()
    const persona = loadPersonas(cfg).get(activePersonaId(cfg))
    const filter = (args[0] ?? '').toLowerCase()
    const keep = rows => rows.filter(r => r.key.toLowerCase().includes(filter))
    const render = rows => table(['key', 'value', 'source'], keep(rows).map(r => [r.key, formatValue(r.value), r.source]))

    head('resolved - what the next task runs with')
    const resolved = resolvedRows({
      cfg, raw, state, persona, effective: effectiveRoute(cfg), access: accessMode(), accessEnv: process.env.DSH_PERMISSION_MODE,
    })
    for (const l of render(resolved)) line(`  ${l}`)
    line('')
    head('settings - built-in defaults merged with finess.config.json')
    for (const l of render(settingRows(cfg, raw))) line(`  ${l}`)
    info('credentials are masked; edit finess.config.json, then /sync (state changes through /persona, /model, /api, /access)')
    return 0
  },
}
