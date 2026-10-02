/**
 * Profile install helpers that must behave the same on macOS, Linux and Windows.
 *
 * pnpm 11 refuses to finish an install while any dependency's install script is undecided
 * (`ERR_PNPM_IGNORED_BUILDS`, exit 1): it writes `<pkg>: set this to true or false` placeholders into
 * the profile's `pnpm-workspace.yaml` and stops. That silently broke adding
 * `@linxin666/dsh-web-all`. The decisions therefore live in `finess.config.json`
 * (`settings.allowBuilds`) and setup writes them into every profile before installing.
 * @module scripts/lib/profile-setup
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** @param {string} key - a package name. @returns {string} it as a YAML mapping key. */
const yamlKey = key => (/^[A-Za-z0-9._-]+$/.test(key) ? key : `'${key.replaceAll("'", "''")}'`)

/**
 * Merge build decisions into a `pnpm-workspace.yaml`. Existing `true`/`false` entries are kept
 * unless a decision overrides them; placeholders pnpm wrote are replaced when a decision exists and
 * kept otherwise (so pnpm keeps asking about genuinely new packages). Everything outside the
 * `allowBuilds:` block is left untouched, and the file's line ending is preserved.
 * @param {string} text - the current file contents ('' when missing).
 * @param {Record<string, boolean>} decisions - package → run its install script?
 * @returns {string} the new contents.
 */
export function mergeAllowBuilds(text, decisions) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/)
  const start = lines.findIndex(l => /^allowBuilds:\s*$/.test(l))
  const current = new Map()
  let end = start
  if (start >= 0) {
    for (end = start + 1; end < lines.length && /^\s+\S/.test(lines[end]); end++) {
      const m = /^\s+('(?:[^']|'')*'|"[^"]*"|[^:]+):\s*(.*)$/.exec(lines[end])
      if (m === null) continue
      const key = m[1].replace(/^'(.*)'$/, '$1').replaceAll("''", "'").replace(/^"(.*)"$/, '$1')
      current.set(key, m[2].trim())
    }
  }
  for (const [k, v] of Object.entries(decisions)) current.set(k, v ? 'true' : 'false')
  if (current.size === 0) return text
  const block = ['allowBuilds:', ...[...current].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `  ${yamlKey(k)}: ${v}`)]
  const out = start >= 0 ? [...lines.slice(0, start), ...block, ...lines.slice(end)] : [...lines, ...block]
  return `${out.join(eol)}${eol}`
}

/**
 * Write the configured build decisions into a profile's `pnpm-workspace.yaml`.
 * @param {string} dir - the profile directory.
 * @param {Record<string, boolean>} decisions - from `settings.allowBuilds`.
 * @returns {boolean} whether the file changed.
 */
export function applyAllowBuilds(dir, decisions) {
  if (Object.keys(decisions ?? {}).length === 0) return false
  const file = join(dir, 'pnpm-workspace.yaml')
  const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const after = mergeAllowBuilds(before, decisions)
  if (after === before) return false
  writeFileSync(file, after, 'utf8')
  return true
}

/**
 * The placeholders pnpm left because a dependency's install script is still undecided.
 * @param {string} dir - the profile directory.
 * @returns {string[]} the undecided package names.
 */
export function undecidedBuilds(dir) {
  const file = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split(/\r?\n/)
    .map(l => /^\s+('(?:[^']|'')*'|[^:]+):\s*set this to true or false\s*$/.exec(l))
    .filter(m => m !== null)
    .map(m => m[1].replace(/^'(.*)'$/, '$1').replaceAll("''", "'"))
}

/**
 * Turn an installed bundle on: append it to `dsh.profile.bundles`, exactly what dsh's plugin
 * manager writes when a bundle is enabled. Needed because `dsh plugin add` only enables a bundle it
 * newly installs; one that was already a dependency (an earlier plain `pnpm add`, a previous setup)
 * stays off, and its patch never applies.
 * @param {string} dir - the profile directory.
 * @param {string} name - the bundle package, already a dependency.
 * @returns {boolean} whether the manifest changed.
 */
export function enableBundle(dir, name) {
  const file = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  if (manifest.dependencies?.[name] === undefined) return false
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (bundles.includes(name)) return false
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, name] } }
  writeFileSync(file, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
  return true
}

/**
 * The bundles a profile composes (`package.json` → `dsh.profile.bundles`).
 * @param {string} dir - the profile directory.
 * @returns {string[]} the bundle package names.
 */
export function profileBundles(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dsh?.profile?.bundles ?? [] } catch { return [] }
}
