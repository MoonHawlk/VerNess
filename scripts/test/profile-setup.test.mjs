/**
 * Build decisions for pnpm 11 (settings.allowBuilds) merged into a profile's pnpm-workspace.yaml,
 * identically on macOS, Linux and Windows (LF or CRLF files).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyAllowBuilds, bundleName, enableBundle, mergeAllowBuilds, profileBundles, undecidedBuilds } from '../lib/profile-setup.mjs'

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
