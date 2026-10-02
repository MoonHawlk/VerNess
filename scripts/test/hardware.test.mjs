/**
 * Hardware fit check for `/models add` (T-360). Pure inputs; no GPU, no network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fitCheck, needBytes } from '../lib/hardware.mjs'

const GiB = 2 ** 30
const quants = new Map([['Q8_0', 8 * GiB], ['Q6_K', 6 * GiB], ['Q4_K_M', 4 * GiB], ['Q2_K', 2 * GiB], ['IQ1', undefined]])

test('fits with headroom to spare', () => {
  const r = fitCheck({ quant: 'Q4_K_M', quants, freeRam: 16 * GiB })
  assert.deepEqual([r.known, r.fits, r.suggest], [true, true, undefined])
})

test('headroom counts: weights alone fit, weights plus context do not', () => {
  assert.ok(needBytes(4 * GiB) > 4 * GiB)
  const r = fitCheck({ quant: 'Q4_K_M', quants, freeRam: 4 * GiB })
  assert.equal(r.fits, false)
})

test('does not fit: suggests the largest smaller quant that does', () => {
  const r = fitCheck({ quant: 'Q8_0', quants, freeRam: 5.5 * GiB })
  assert.equal(r.fits, false)
  assert.equal(r.suggest, 'Q4_K_M')
})

test('does not fit and nothing smaller does: no suggestion', () => {
  const r = fitCheck({ quant: 'Q8_0', quants, freeRam: 1 * GiB })
  assert.deepEqual([r.fits, r.suggest], [false, undefined])
})

test('VRAM is a second pool: the larger of RAM and VRAM is the budget', () => {
  assert.equal(fitCheck({ quant: 'Q8_0', quants, freeRam: 2 * GiB, freeVram: 12 * GiB }).fits, true)
  assert.equal(fitCheck({ quant: 'Q8_0', quants, freeRam: 12 * GiB, freeVram: 2 * GiB }).fits, true)
})

test('unknown size is not judged; unknown-size quants are never suggested', () => {
  assert.deepEqual(fitCheck({ quant: 'IQ1', quants, freeRam: 1 * GiB }).known, false)
  assert.equal(fitCheck({ quant: 'Q2_K', quants, freeRam: 1 * GiB }).suggest, undefined)
})
