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

import { ROUTING_QUESTIONS, optionHash } from '../lib/decisions.mjs'
import { appendLabel, labelCounts, latestGate, matchRecords, parseLabelInput, readLabels, readShadow, unlabelled } from '../lib/labels.mjs'

/** @param {(dir: string) => void} fn - body run against a fresh temp directory. */
function inTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'finess-labels-'))
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
  assert.deepEqual(readShadow(join(tmpdir(), 'finess-labels-does-not-exist')), [])
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

test('matchRecords: an exact id wins; otherwise a case-insensitive task substring', () => {
  const recs = [
    { id: 'a1b2c3d4e5f6', task: 'create a file called notes.txt' },
    { id: 'ffffffffffff', task: 'Switch to the reviewer persona' },
    { id: 'eeeeeeeeeeee', task: 'switch to the data-scientist persona' },
  ]
  assert.deepEqual(matchRecords(recs, 'a1b2c3d4e5f6').map(r => r.id), ['a1b2c3d4e5f6'])
  assert.deepEqual(matchRecords(recs, 'SWITCH TO').map(r => r.id), ['ffffffffffff', 'eeeeeeeeeeee'])
  assert.deepEqual(matchRecords(recs, 'nothing like this'), [])
  assert.deepEqual(matchRecords(recs, '   '), [])
})

test('latestGate: recomputed from the logs and labels; unlabelled questions hold', () => inTemp(dir => {
  const hash = optionHash(ROUTING_QUESTIONS.level)
  const lines = []
  for (let i = 0; i < 60; i++) {
    const right = i % 10 < 8
    lines.push(JSON.stringify({
      v: 2, id: `r${i}`, at: `2026-09-27T00:00:${String(i).padStart(2, '0')}Z`, task: `task ${i}`,
      model: { level: { answer: 'simple', confidence: right ? 0.9 : 0.4, hash } },
      rules: { level: right ? 'simple' : 'complex' },
    }))
    appendLabel(dir, { id: `r${i}`, question: 'level', label: right ? 'simple' : 'trivial' })
  }
  writeFileSync(join(dir, '2026-09-27.jsonl'), `${lines.join('\n')}\n`)
  const g = latestGate(dir)
  assert.deepEqual(Object.keys(g), [...Object.keys(ROUTING_QUESTIONS), 'guard', 'supervisor'])
  // level: accuracy .8 = rules .8; ECE = .8·.1 + .2·.4 = .16 < rules .2, but > .15.
  assert.deepEqual({ pass: g.level.pass, why: g.level.why, n: g.level.n, hash: g.level.hash }, { pass: false, why: 'ECE 0.16 > 0.15', n: 60, hash })
  assert.deepEqual({ pass: g.tier.pass, why: g.tier.why, n: g.tier.n }, { pass: false, why: 'insufficient data (0 < 50)', n: 0 })
}))
