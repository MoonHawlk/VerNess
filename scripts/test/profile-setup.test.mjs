/**
 * Build decisions for pnpm 11 (settings.allowBuilds) merged into a profile's pnpm-workspace.yaml,
 * identically on macOS, Linux and Windows (LF or CRLF files).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyAllowBuilds, bundleName, hashPluginDir, pluginNeedsReinstall, readPluginHashes, writePluginHash, enableBundle, isWorktree, patchCheckout, syncWarnings, mergeAllowBuilds, profileBundles, undecidedBuilds } from '../lib/profile-setup.mjs'

const PNPM_WROTE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
allowBuilds:
  '@google/genai': set this to true or false
  cloudflared: set this to true or false
  esbuild: true
`

test('decisions replace placeholders, keep other entries, and leave the rest of the file alone', () => {
  const out = mergeAllowBuilds(PNPM_WROTE, { '@google/genai': false, cloudflared: false })
  assert.match(out, /^packages:\n {2}- \.\n\nnodeLinker: hoisted\nautoInstallPeers: false\n/)
  assert.match(out, /\n {2}'@google\/genai': false\n/)
  assert.match(out, /\n {2}cloudflared: false\n/)
  assert.match(out, /\n {2}esbuild: true\n/)
  assert.ok(!out.includes('set this to'))
})

test('an undecided package stays a placeholder, so pnpm keeps asking about genuinely new ones', () => {
  const out = mergeAllowBuilds(PNPM_WROTE, { cloudflared: false })
  assert.match(out, /'@google\/genai': set this to true or false/)
})

test('no allowBuilds block yet: one is appended; CRLF files stay CRLF', () => {
  const crlf = 'packages:\r\n  - .\r\n'
  const out = mergeAllowBuilds(crlf, { ssh2: false })
  assert.equal(out, 'packages:\r\n  - .\r\nallowBuilds:\r\n  ssh2: false\r\n')
  assert.equal(mergeAllowBuilds(out, { ssh2: false }), out, 'idempotent')
})

test('apply writes once, reports undecided builds, and reads bundles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finess-profile-'))
  try {
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), PNPM_WROTE)
    assert.deepEqual(undecidedBuilds(dir), ['@google/genai', 'cloudflared'])
    assert.equal(applyAllowBuilds(dir, { '@google/genai': false, cloudflared: false }), true)
    assert.equal(applyAllowBuilds(dir, { '@google/genai': false, cloudflared: false }), false)
    assert.deepEqual(undecidedBuilds(dir), [])
    assert.ok(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8').includes('esbuild: true'))
    assert.deepEqual(profileBundles(dir), [])
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['a', 'b'] } } }))
    assert.deepEqual(profileBundles(dir), ['a', 'b'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('enableBundle appends an installed bundle once, and never enables one that is not installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finess-profile-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { web: '^1.0.0' }, dsh: { profile: { bundles: ['base'] }, other: 1 } }))
    assert.equal(enableBundle(dir, 'missing'), false)
    assert.equal(enableBundle(dir, 'web'), true)
    assert.equal(enableBundle(dir, 'web'), false)
    const m = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    assert.deepEqual(m.dsh.profile.bundles, ['base', 'web'])
    assert.equal(m.dsh.other, 1, 'other dsh keys are kept')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('bundleName strips a pinned version and keeps the scope', () => {
  assert.equal(bundleName('@linxin666/dsh-web-all@0.4.3'), '@linxin666/dsh-web-all')
  assert.equal(bundleName('@linxin666/dsh-web-all'), '@linxin666/dsh-web-all')
  assert.equal(bundleName('plain@1.2.3'), 'plain')
  assert.equal(bundleName('plain'), 'plain')
})

test('patchCheckout reads the stamp; an unstamped patch has none', () => {
  assert.equal(patchCheckout('# GENERATED\r\n# checkout: C:\\a\\repo\r\n- insert:\r\n'), 'C:\\a\\repo')
  assert.equal(patchCheckout('# GENERATED\n- insert:\n'), undefined)
})

test('syncWarnings: another checkout and a worktree warn; the same checkout (any slash or case) does not', () => {
  assert.deepEqual(syncWarnings({ existing: undefined, repo: '/r', worktree: false }), [])
  assert.deepEqual(syncWarnings({ existing: '# checkout: C:\\Repo\n', repo: 'c:/repo', worktree: false }), [])
  const other = syncWarnings({ existing: '# checkout: /other\n', repo: '/r', worktree: false })
  assert.equal(other.length, 1)
  assert.match(other[0], /another checkout \(\/other\)/)
  assert.match(syncWarnings({ existing: undefined, repo: '/r', worktree: true })[0], /worktree/)
})

test('isWorktree: a .git file is a linked worktree, a .git directory or none is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finess-wt-'))
  try {
    assert.equal(isWorktree(dir), false)
    writeFileSync(join(dir, '.git'), 'gitdir: /x/.git/worktrees/y\n')
    assert.equal(isWorktree(dir), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('hashPluginDir changes only with the plugin files, ignoring node_modules and dotfiles', () => {
  const d = mkdtempSync(join(tmpdir(), 'finess-hash-'))
  try {
    writeFileSync(join(d, 'index.js'), 'a')
    const h1 = hashPluginDir(d)
    assert.equal(hashPluginDir(d), h1)
    mkdirSync(join(d, 'node_modules'))
    writeFileSync(join(d, 'node_modules', 'x.js'), 'junk')
    writeFileSync(join(d, '.DS_Store'), 'junk')
    assert.equal(hashPluginDir(d), h1)
    writeFileSync(join(d, 'index.js'), 'b')
    const h2 = hashPluginDir(d)
    assert.notEqual(h2, h1)
    mkdirSync(join(d, 'sub'))
    writeFileSync(join(d, 'sub', 'm.js'), 'c')
    assert.notEqual(hashPluginDir(d), h2)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('pluginNeedsReinstall only when installed and the hash differs', () => {
  assert.equal(pluginNeedsReinstall({ stored: 'a', current: 'b', installed: true }), true)
  assert.equal(pluginNeedsReinstall({ stored: undefined, current: 'b', installed: true }), true)
  assert.equal(pluginNeedsReinstall({ stored: 'a', current: 'a', installed: true }), false)
  assert.equal(pluginNeedsReinstall({ stored: 'a', current: 'b', installed: false }), false)
})

test('plugin hashes round-trip through the profile dir', () => {
  const d = mkdtempSync(join(tmpdir(), 'finess-hash-'))
  try {
    assert.deepEqual(readPluginHashes(d), {})
    writePluginHash(d, '@finess/a', 'h1')
    writePluginHash(d, '@finess/b', 'h2')
    assert.deepEqual(readPluginHashes(d), { '@finess/a': 'h1', '@finess/b': 'h2' })
  } finally { rmSync(d, { recursive: true, force: true }) }
})
