/**
 * Hardware fit for a GGUF (T-360): will these weights load into free memory? A pure check plus
 * best-effort probes. Warn-only: callers never block on it.
 * @module scripts/lib/hardware
 */

import { spawnSync } from 'node:child_process'
import os from 'node:os'

const MIB = 2 ** 20
/** Context/KV-cache allowance on top of the weights: a flat floor plus a fraction of their size. */
const HEADROOM_FLAT = 512 * MIB
const HEADROOM_FRAC = 0.1

/**
 * @param {number} bytes - weight file size.
 * @returns {number} bytes needed to run it: the weights plus modest KV-cache/context headroom.
 */
export const needBytes = bytes => Math.ceil(bytes * (1 + HEADROOM_FRAC) + HEADROOM_FLAT)

/**
 * Does a model fit, and if not, which smaller quant from the same repo would? The model runs from
 * either pool (the engine uses the GPU when the weights fit there, else the CPU), so the budget is
 * the larger of free RAM and free VRAM. On unified memory (macOS) VRAM is not a separate pool.
 * @param {object} p - inputs.
 * @param {string} p.quant - the chosen quant.
 * @param {Map<string, number|undefined>} p.quants - every quant the repo publishes -> bytes.
 * @param {number} p.freeRam - free system RAM, bytes.
 * @param {number} [p.freeVram] - free GPU memory, bytes; undefined when unknown.
 * @returns {{known: boolean, fits: boolean, need?: number, budget: number, suggest?: string}} `known` is
 *   false when the chosen quant's size is unknown (nothing to judge); `suggest` is the largest quant
 *   that is smaller than the chosen one and fits.
 */
export function fitCheck({ quant, quants, freeRam, freeVram }) {
  const budget = Math.max(freeRam, freeVram ?? 0)
  const bytes = quants.get(quant)
  if (bytes === undefined) return { known: false, fits: true, budget }
  const need = needBytes(bytes)
  if (need <= budget) return { known: true, fits: true, need, budget }
  const smaller = [...quants].filter(([q, b]) => q !== quant && b !== undefined && b < bytes && needBytes(b) <= budget).sort((a, b) => b[1] - a[1])
  return { known: true, fits: false, need, budget, suggest: smaller[0]?.[0] }
}

/**
 * Free GPU memory via nvidia-smi, summed to the largest single card; skipped silently when absent.
 * @returns {number|undefined} free VRAM in bytes, or undefined when unknown.
 */
export function freeVram() {
  try {
    const r = spawnSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    if (r.status !== 0 || typeof r.stdout !== 'string') return undefined
    const mib = r.stdout.split('\n').map(l => Number.parseInt(l.trim(), 10)).filter(Number.isFinite)
    return mib.length === 0 ? undefined : Math.max(...mib) * MIB
  } catch { return undefined }
}

/** @returns {{freeRam: number, freeVram?: number}} what this machine has free right now (macOS: unified, RAM only). */
export function probeHardware() {
  return { freeRam: os.freemem(), freeVram: process.platform === 'darwin' ? undefined : freeVram() }
}
