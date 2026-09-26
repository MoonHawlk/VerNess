/**
 * `/api` — run the agent on a hosted model instead of the local one.
 *
 *   /api                            active route, and every provider the adapter knows, key present or not
 *   /api models <provider> [text]   the provider's catalog models, optionally filtered
 *   /api use <provider> <model>     switch the agent to that provider and model
 *   /api key <provider>             which variable holds the provider's key, and whether it is set
 *   /api local                      back to the local model
 *
 * Providers come from the route adapter installed in the profile (pi-ai's catalog): endpoint,
 * protocol and model list are its business, so VerNess names no vendor and writes only the key
 * variable into the profile patch. Keys belong in the gitignored `.env` — never on this command line,
 * which lands in history.
 *
 * Tools: an API model drives the same shell, file and web tools the local one has. `/access` decides
 * how far they reach. Zero tokens: this command never calls a model.
 * @module scripts/commands/api
 */

import { join } from 'node:path'

import { accessMode, catalogProviders, effectiveRoute, keyEnvFor, knownRoutes } from '../lib/routes.mjs'
import { readState, writeState } from '../lib/personas.mjs'
import { head, info, ok, paint, REPO, warn } from '../lib/util.mjs'

/**
 * @param {string|undefined} name - an environment variable name.
 * @returns {boolean} whether it is set (the value is never read out).
 */
const isSet = name => name !== undefined && (process.env[name] ?? '') !== ''

/**
 * @param {string|undefined} keyEnv - the provider's key variable.
 * @returns {string} how to provide it.
 */
const keyHint = keyEnv => (keyEnv === undefined
  ? 'this provider signs in with ambient cloud credentials, not a key variable'
  : `add a line  ${keyEnv}=<your key>  to ${join(REPO, '.env')} (gitignored), then run the task again`)

export default {
  name: 'api',
  group: 'model',
  summary: 'use a hosted API model instead of the local one: /api use <provider> <model>',
  usage: '/api [models <provider> [filter] | use <provider> <model> | key <provider> | local]',
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - subcommand and arguments.
   * @returns {Promise<number>} exit code.
   */
  async run(ctx, args) {
    const cfg = ctx.cfg
    const [sub, provider, ...rest] = args
    const catalog = catalogProviders(cfg)
    const declared = Object.entries(knownRoutes(cfg)).filter(([, r]) => r.kind === 'declared').map(([n]) => n)

    if (sub === undefined || sub === 'list') {
      const e = effectiveRoute(cfg)
      head(`active: ${e.model ?? '-'} via ${e.name} (${e.route?.kind ?? '?'}) - tools run ${accessMode()}`)
      if (catalog.size === 0) {
        warn('the route adapter catalog is not installed yet - run: ./turn_on.sh setup')
        return 1
      }
      const rows = await Promise.all([...catalog.entries()].map(async ([id, c]) => [id, c.models.length, await keyEnvFor(cfg, id)]))
      const ready = rows.filter(r => isSet(r[2]))
      const w = Math.max(...rows.map(r => r[0].length))
      const show = r => console.log(`  ${isSet(r[2]) ? paint('green', 'key') : '   '} ${r[0].padEnd(w)}  ${String(r[1]).padStart(3)} models  ${paint('dim', r[2] ?? 'ambient credentials')}`)
      if (ready.length > 0) { info('ready (key found):'); ready.forEach(show) }
      info(`${ready.length === 0 ? 'providers' : 'other providers'} (add the key to .env to use one):`)
      rows.filter(r => !isSet(r[2])).forEach(show)
      if (declared.length > 0) info(`declared in extraRoutes: ${declared.join(', ')}`)
      info('next: /api models <provider>   then   /api use <provider> <model>')
      return 0
    }

    if (sub === 'local') {
      writeState({ route: undefined, model: undefined, modelRoute: undefined })
      ctx.sync()
      const e = effectiveRoute(cfg)
      ok(`back to the local route: ${e.model} via ${e.name}`)
      return 0
    }

    if (provider === undefined) { warn(`usage: ${this.usage}`); return 1 }
    const known = catalog.get(provider)
    if (known === undefined && !declared.includes(provider)) {
      warn(`unknown provider: ${provider}`)
      const near = [...catalog.keys()].filter(p => p.includes(provider) || provider.includes(p)).slice(0, 5)
      info(near.length > 0 ? `did you mean: ${near.join(', ')}?` : 'list them with /api')
      return 1
    }

    if (sub === 'models') {
      if (known === undefined) { info(`${provider} is a declared route; its models are listed in extraRoutes`); return 0 }
      const filter = rest.join(' ').toLowerCase()
      const models = known.models.filter(m => filter === '' || m.toLowerCase().includes(filter))
      head(`${provider}: ${models.length} model(s)${filter === '' ? '' : ` matching "${filter}"`}`)
      for (const m of models) console.log(`  ${m}`)
      info(`use one: /api use ${provider} <model>`)
      return 0
    }

    if (sub === 'key') {
      const keyEnv = known === undefined ? knownRoutes(cfg)[provider]?.apiKeyEnv : await keyEnvFor(cfg, provider)
      head(`${provider}: key variable ${keyEnv ?? '(none)'} - ${isSet(keyEnv) ? 'set' : 'not set'}`)
      info(keyHint(keyEnv))
      return 0
    }

    if (sub === 'use') {
      const model = rest[0]
      if (declared.includes(provider)) {
        // A declared route carries its own model; switching to it needs no catalog lookup.
        writeState({ route: provider, model, modelRoute: model === undefined ? undefined : provider })
        ctx.sync()
        ok(`switched to ${provider}${model === undefined ? '' : ` / ${model}`}`)
        return 0
      }
      if (model === undefined) {
        warn(`name a model: /api use ${provider} <model>`)
        info(`${known.models.length} available - /api models ${provider}`)
        return 1
      }
      if (!known.models.includes(model)) {
        warn(`${model} is not in the ${provider} catalog`)
        const near = known.models.filter(m => m.includes(model) || model.includes(m)).slice(0, 5)
        info(near.length > 0 ? `did you mean: ${near.join(', ')}?` : `list them with /api models ${provider}`)
        return 1
      }
      const keyEnv = await keyEnvFor(cfg, provider)
      const state = readState()
      writeState({
        route: provider,
        model,
        modelRoute: provider,
        apiRoutes: { ...(state.apiRoutes ?? {}), [provider]: keyEnv === undefined ? {} : { apiKeyEnv: keyEnv } },
      })
      ctx.sync()
      ok(`the agent now runs on ${model} via ${provider} (tools: ${accessMode()})`)
      if (keyEnv !== undefined && !isSet(keyEnv)) {
        warn(`${keyEnv} is not set - tasks will be refused until it is`)
        info(keyHint(keyEnv))
      }
      info('tokens are billed by the provider from here on; /usage and /cost show what was reported')
      info('back to the local model: /api local')
      return 0
    }

    warn(`unknown subcommand: ${sub}`)
    info(this.usage)
    return 1
  },
}
