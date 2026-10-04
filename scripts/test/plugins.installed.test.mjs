/**
 * A plugin the patch lists but the profile never installed is skipped by dsh without a word. For
 * the guard that meant irreversible commands ran unconfirmed, so the launcher checks before a task.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SAFETY_PLUGINS, missingPlugins } from '../finess.mjs'

const rows = [
  { package: '@finess/guard', enabled: true },
  { package: '@finess/thoughts', enabled: true },
  { package: '@finess/commands', enabled: true, surfaces: ['web'] },
  { package: '@finess/old', enabled: false },
]

test('missingPlugins lists enabled plugins of the surface the profile has not installed', () => {
  const installed = new Set(['@finess/thoughts'])
  assert.deepEqual(missingPlugins(rows, 'headless', p => installed.has(p)), ['@finess/guard'])
  assert.deepEqual(missingPlugins(rows, 'web', p => installed.has(p)), ['@finess/guard', '@finess/commands'])
  assert.deepEqual(missingPlugins(rows, 'headless', () => true), [])
  assert.deepEqual(missingPlugins(undefined, 'headless', () => false), [])
})

test('the guard is a safety plugin', () => {
  assert.ok(SAFETY_PLUGINS.includes('@finess/guard'))
})
