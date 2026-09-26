/**
 * The labelled set (T-220 / T-260): shadow records joined with human labels. Labels are keyed by
 * record id and question; the newest label wins, and `skip` counts as labelled so a "none of the
 * above" task is never asked again.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendLabel, labelCounts, parseLabelInput, readLabels, readShadow, unlabelled } from '../lib/labels.mjs'

/** @param {(dir: string) => void} fn - body run against a fresh temp directory. */
function inTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'verness-labels-'))
  try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('readShadow skips bad lines, derives legacy ids and sorts oldest first', () => inTemp(dir => {
  writeFileSync(join(dir, '2026-09-27.jsonl'), `${JSON.stringify({ v: 2, id: 'b', at: '2026-09-27T00:00:00Z', task: 'two' })}\nnot json\n`)
  writeFileSync(join(dir, '2026-09-26.jsonl'), `${JSON.stringify({ at: '2026-09-26T00:00:00Z', task: 'one' })}\n\n`)
  writeFileSync(join(dir, 'labels.jsonl'), `${JSON.stringify({ id: 'b', question: 'level', label: 'simple' })}\n`)
  const recs = readShadow(dir)
  assert.deepEqual(recs.map(r => r.id), ['legacy-2026-09-26T00:00:00Z', 'b'])
}))

test('readShadow on a missing directory is empty', () => {
  assert.deepEqual(readShadow(join(tmpdir(), 'verness-labels-does-not-exist')), [])
})

test('readLabels: later lines win, per question', () => inTemp(dir => {
  appendLabel(dir, { id: 'a', question: 'level', label: 'simple' })
  appendLabel(dir, { id: 'a', question: 'tier', label: 'frontier' })
  appendLabel(dir, { id: 'a', question: 'level', label: 'complex' })
  const labels = readLabels(dir)
  assert.deepEqual(labels.get('a'), { level: 'complex', tier: 'frontier' })
  const line = JSON.parse(readFileSync(join(dir, 'labels.jsonl'), 'utf8').split('\n')[0])
  assert.equal(typeof line.at, 'string')
}))

test('unlabelled: another question does not count, skip does', () => {
  const recs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const labels = new Map([['a', { tier: 'frontier' }], ['b', { level: 'skip' }]])
  assert.deepEqual(unlabelled(recs, labels, 'level').map(r => r.id), ['a', 'c'])
})

test('labelCounts counts real labels and skips separately', () => {
  const labels = new Map([['a', { level: 'simple', tier: 'skip' }], ['b', { level: 'complex' }]])
  const c = labelCounts(labels, ['level', 'tier', 'pipeline'])
  assert.deepEqual(c, { level: { labelled: 2, skipped: 0 }, tier: { labelled: 0, skipped: 1 }, pipeline: { labelled: 0, skipped: 0 } })
})

test('parseLabelInput: numbers, names, skip, quit, junk', () => {
  const opts = ['trivial', 'simple', 'standard']
  assert.deepEqual(parseLabelInput('2', opts), { label: 'simple' })
  assert.deepEqual(parseLabelInput(' Standard ', opts), { label: 'standard' })
  assert.deepEqual(parseLabelInput('s', opts), { label: 'skip' })
  assert.deepEqual(parseLabelInput('q', opts), { quit: true })
  assert.deepEqual(parseLabelInput('4', opts), { invalid: true })
  assert.deepEqual(parseLabelInput('', opts), { invalid: true })
})
