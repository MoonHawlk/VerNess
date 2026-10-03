/**
 * `/permissions` — the active persona's tool policy as `@finess/tool-policy` enforces it (T-155). The
 * policy is built with the plugin's own `configOf`/`policyOf`, so this table and the enforcement agree.
 * @module scripts/commands/permissions
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { READ_ONLY, restricts } from '../../packages/tool-policy/index.js'
import { activePolicy } from '../lib/personas.mjs'
import { head, info, REPO, warn } from '../lib/util.mjs'

/** @returns {string} the plugin's package version, or `?` when unreadable. */
const pluginVersion = () => {
  try { return JSON.parse(readFileSync(join(REPO, 'packages', 'tool-policy', 'package.json'), 'utf8')).version } catch { return '?' }
}

/**
 * The report lines for an active policy.
 * @param {ReturnType<typeof activePolicy>} active - from `activePolicy`.
 * @param {string} version - the plugin version.
 * @returns {string[]} the lines.
 */
export function permissionLines({ id, policy, row }, version) {
  const state = row === undefined ? 'NOT configured (no finess-tool-policy row): nothing is enforced'
    : row.enabled === false ? 'disabled in finess.config.json: nothing is enforced'
      : '[enforced] on tools/pre-execute'
  const list = xs => (xs.length === 0 ? '(none)' : xs.join(', '))
  const ask = Object.entries(policy.approval).map(([t, m]) => `${t}=${m}`)
  const L = [
    `persona: ${id}`,
    `plugin:  @finess/tool-policy ${version} — ${state}`,
    `allow:   ${policy.allow.length === 0 ? '(any tool)' : list(policy.allow)}`,
    `deny:    ${list(policy.deny)}`,
    `approval: ${list(ask)}`,
  ]
  if (policy.broken !== undefined) L.push(`BROKEN:  ${policy.broken} failed to load; only ${READ_ONLY.join(', ')} run`)
  L.push(restricts(policy) ? 'deny wins; a non-empty allow blocks every other tool; bash and pwsh count as one shell'
    : 'unrestricted: this persona declares no tool policy')
  return L
}

export default {
  name: 'permissions',
  group: 'personas',
  summary: "the active persona's enforced tool policy",
  usage: '/permissions',
  /**
   * @param {object} ctx - command context.
   * @returns {number} exit code.
   */
  run(ctx) {
    const active = activePolicy(ctx.cfg)
    head(`tool policy (persona ${active.id})`)
    for (const l of permissionLines(active, pluginVersion())) console.log(`  ${l}`)
    if (active.persona === undefined) { warn(`persona "${active.id}" has no definition`); return 1 }
    info('a change applies from the next task; /tools marks each offered tool')
    return 0
  },
}
