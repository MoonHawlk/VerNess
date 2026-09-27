#!/usr/bin/env node
/**
 * `profiles` — the dsh profiles VerNess manages (headless and web), as installed on THIS machine:
 * bundles, dependencies, configured plugins vs installed ones, web bundles, undecided pnpm build
 * scripts, and the rows the generated patch inserts. The fastest way to see why a plugin or panel
 * is missing, on macOS or Windows alike.
 *
 *   node scripts/tools/profiles.mjs
 * @module scripts/tools/profiles
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parseJsonc } from '../lib/util.mjs'
import { profileBundles, undecidedBuilds } from '../lib/profile-setup.mjs'
import { helpIf, parseArgs, readText } from './_lib.mjs'

helpIf(parseArgs(process.argv.slice(2)), `
profiles
  for the headless and web profiles under $DSH_HOME/profiles: exists?, bundles, dependencies,
  configured plugins and web bundles vs installed, undecided build scripts, patch insert rows`)

const cfg = parseJsonc(readText('verness.config.json'))
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const name = cfg.profile?.name ?? 'verness'
const web = cfg.profile?.webName ?? `${name}-web`
const plugins = cfg.settings?.plugins ?? []
const webBundles = cfg.settings?.webBundles ?? []

for (const [label, profile, isWeb] of [['headless', name, false], ['web', web, true]]) {
  const dir = join(home, 'profiles', profile)
  console.log(`${label}: ${dir}`)
  if (!existsSync(join(dir, 'package.json'))) { console.log('  not created yet (setup creates it; web is created on first `web`)\n'); continue }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const deps = pkg.dependencies ?? {}
  console.log(`  bundles: ${profileBundles(dir).join(', ') || 'none'}`)
  for (const p of plugins) console.log(`  plugin ${p.package}: ${deps[p.package] === undefined ? 'NOT INSTALLED' : `installed (${deps[p.package].slice(0, 40)})`}`)
  if (isWeb) {
    for (const b of webBundles) {
      const inDeps = deps[b] !== undefined
      const inBundles = profileBundles(dir).includes(b)
      console.log(`  web bundle ${b}: ${inBundles ? 'mounted as a bundle' : inDeps ? 'INSTALLED BUT NOT A BUNDLE (patch not applied) - run setup' : 'NOT INSTALLED - run setup'}`)
    }
  }
  const undecided = undecidedBuilds(dir)
  console.log(`  undecided build scripts: ${undecided.length === 0 ? 'none' : `${undecided.join(', ')} - decide in settings.allowBuilds`}`)
  const patch = existsSync(join(dir, 'cordis.patch.yml')) ? readFileSync(join(dir, 'cordis.patch.yml'), 'utf8') : ''
  const rows = [...patch.matchAll(/^\s+- id: (\S+)\s*\n\s+name: '?([^'\n]+)'?/gm)].map(m => `${m[1]} (${m[2]})`)
  console.log(`  patch insert rows: ${rows.join(', ') || 'none'}\n`)
}
