/**
 * Calibration of the decision model against human labels (T-221, T-222 / T-261): accuracy, ECE,
 * AUROC, and a temperature refit that is judged on held-out data.
 *
 * Pure: no I/O and no imports. `report()` takes the current option-set hashes as an argument, so
 * this module never depends on `decisions.mjs` (which imports `applyTemperature` from here).
 * @module scripts/lib/calibration
 */

/** Labels per question below which the refit, and the gate, refuse to judge. */
export const MIN_LABELS = 50

/**
 * @param {{pred?: string, label: string}[]} rows - predictions and labels.
 * @returns {number} the share predicted correctly; `NaN` for no rows.
 */
export function accuracy(rows) {
  if (rows.length === 0) return Number.NaN
  return rows.filter(r => r.pred === r.label).length / rows.length
}

/**
 * Expected calibration error over equal-width bins: `Σ_b (n_b / N) · |acc_b − conf_b|`.
 * @param {{conf: number, correct: boolean}[]} rows - confidence and correctness.
 * @param {number} [bins] - how many bins over [0, 1].
 * @returns {number} the ECE; `NaN` for no rows.
 */
export function ece(rows, bins = 10) {
  if (rows.length === 0) return Number.NaN
  const acc = Array.from({ length: bins }, () => ({ n: 0, right: 0, conf: 0 }))
  for (const r of rows) {
    const b = acc[Math.min(bins - 1, Math.max(0, Math.floor(r.conf * bins)))]
    b.n++
    b.conf += r.conf
    if (r.correct) b.right++
  }
  return acc.reduce((s, b) => (b.n === 0 ? s : s + (b.n / rows.length) * Math.abs(b.right / b.n - b.conf / b.n)), 0)
}

/**
 * Does confidence separate right answers from wrong ones? Mann–Whitney, ties count ½.
 * @param {{conf: number, correct: boolean}[]} rows - confidence and correctness.
 * @returns {number|null} the AUROC, or null when every row is right or every row is wrong.
 */
export function auroc(rows) {
  const pos = rows.filter(r => r.correct).map(r => r.conf)
  const neg = rows.filter(r => !r.correct).map(r => r.conf)
  if (pos.length === 0 || neg.length === 0) return null
  let wins = 0
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0
  return wins / (pos.length * neg.length)
}

/**
 * Rescale a probability map: `p_i ∝ p_i^(1/T)`, renormalised. `T > 1` flattens, `T < 1` sharpens,
 * `T = 1` is the identity, and a zero stays zero. The ranking never changes, so neither does the answer.
 * @param {Record<string, number>} probs - option → probability.
 * @param {number} T - the temperature.
 * @returns {Record<string, number>} the rescaled map.
 */
export function applyTemperature(probs, T) {
  if (T === 1) return { ...probs }
  const raised = Object.fromEntries(Object.entries(probs).map(([k, p]) => [k, p > 0 ? p ** (1 / T) : 0]))
  const sum = Object.values(raised).reduce((s, x) => s + x, 0)
  if (sum === 0) return { ...probs }
  return Object.fromEntries(Object.entries(raised).map(([k, x]) => [k, x / sum]))
}

/**
 * @param {{probs: Record<string, number>, label: string}[]} rows - probability maps and labels.
 * @param {number} T - the temperature to apply first.
 * @returns {number} mean negative log-likelihood of the labels.
 */
export function nll(rows, T) {
  if (rows.length === 0) return Number.NaN
  return rows.reduce((s, r) => s - Math.log(Math.max(applyTemperature(r.probs, T)[r.label] ?? 0, 1e-12)), 0) / rows.length
}

/**
 * Grid-search the temperature that minimises NLL, over 0.25 … 5 in steps of 0.05. Deterministic.
 * @param {{probs: Record<string, number>, label: string}[]} rows - probability maps and labels.
 * @returns {{T: number, nllBefore: number, nllAfter: number}} the fit.
 */
export function fitTemperature(rows) {
  const nllBefore = nll(rows, 1)
  let best = { T: 1, nllAfter: nllBefore }
  // Integer steps, so the grid carries no floating-point drift.
  for (let k = 5; k <= 100; k++) {
    const T = k / 20
    const v = nll(rows, T)
    if (v < best.nllAfter) best = { T, nllAfter: v }
  }
  return { T: best.T, nllBefore, nllAfter: best.nllAfter }
}

/**
 * A deterministic train/holdout split: a seeded LCG shuffle, never `Math.random`.
 * @template T
 * @param {T[]} rows - the rows.
 * @param {number} [fraction] - the holdout share.
 * @param {number} [seed] - the LCG seed.
 * @returns {{train: T[], holdout: T[]}} the split.
 */
export function splitHoldout(rows, fraction = 0.3, seed = 42) {
  let s = seed >>> 0
  const next = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 }
  const idx = rows.map((_, i) => i)
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[idx[i], idx[j]] = [idx[j], idx[i]]
  }
  const cut = Math.round(rows.length * fraction)
  return { holdout: idx.slice(0, cut).map(i => rows[i]), train: idx.slice(cut).map(i => rows[i]) }
}

/**
 * @param {{pred?: string, label: string, conf: number}[]} rows - scored rows.
 * @returns {{accuracy: number, ece: number, auroc: number|null}} the three metrics.
 */
function metrics(rows) {
  const scored = rows.map(r => ({ conf: r.conf, correct: r.pred === r.label }))
  return { accuracy: accuracy(rows), ece: ece(scored), auroc: auroc(scored) }
}

/**
 * The calibration report: one row per `(question, option-set hash)` with at least one real label
 * (`skip` is not a label). The model is scored on its logged confidence; the rules have none, so
 * they are scored as always fully confident (1.0) and their ECE is `1 − accuracy`.
 *
 * With at least `MIN_LABELS` rows that carry probabilities, a temperature is fitted on a train split
 * and judged on the holdout. It is reported (`T`, `modelRefit`) only when holdout NLL improves.
 * @param {object[]} records - shadow records (from `readShadow`).
 * @param {Map<string, Record<string, string>>} labels - from `readLabels`.
 * @param {{questions: string[], hashes: Record<string, string>}} opts - the question keys, and each
 *   one's current option-set hash (records logged before hashes existed count under it).
 * @returns {object[]} the report rows.
 */
export function report(records, labels, { questions, hashes }) {
  const out = []
  for (const q of questions) {
    const groups = new Map()
    for (const r of records) {
      const label = labels.get(r.id)?.[q]
      if (label === undefined || label === 'skip') continue
      const m = r.model?.[q] ?? {}
      const hash = m.hash ?? hashes[q]
      if (!groups.has(hash)) groups.set(hash, [])
      groups.get(hash).push({ label, pred: m.answer, conf: m.confidence ?? 0, probs: m.probabilities, rule: r.rules?.[q] })
    }
    for (const [hash, rows] of groups) {
      const row = {
        question: q,
        hash,
        n: rows.length,
        model: metrics(rows),
        rules: metrics(rows.map(r => ({ pred: r.rule, label: r.label, conf: 1 }))),
      }
      const withProbs = rows.filter(r => r.probs !== undefined)
      if (withProbs.length >= MIN_LABELS) {
        const { train, holdout } = splitHoldout(withProbs)
        const fit = fitTemperature(train)
        if (nll(holdout, fit.T) < nll(holdout, 1)) {
          row.T = fit.T
          row.modelRefit = {
            ...metrics(holdout.map(r => ({ pred: r.pred, label: r.label, conf: Math.max(...Object.values(applyTemperature(r.probs, fit.T))) }))),
            n: holdout.length,
          }
        }
      }
      out.push(row)
    }
  }
  return out
}
