/**
 * The labelled set (T-220 / T-260): shadow-mode decision records joined with human labels.
 *
 * Records live in `.verness/decisions/<day>.jsonl` (written by `logShadowDecision`); labels live
 * beside them in `labels.jsonl`, one `{id, question, label, at}` line each, append-only. The newest
 * label for an `(id, question)` wins, so a mistake is corrected by labelling again. `skip` is a
 * label: it marks a task that fits none of the options, and it is never asked again.
 * @module scripts/lib/labels
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The label file inside the decisions directory. */
export const LABELS_FILE = 'labels.jsonl'

/**
 * @param {string} file - a JSONL file.
 * @returns {object[]} every line that parses as a JSON object; blank and bad lines are skipped.
 */
function readJsonl(file) {
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const v = JSON.parse(line)
      if (v !== null && typeof v === 'object') out.push(v)
    } catch { /* a torn or hand-edited line; skip it */ }
  }
  return out
}

/**
 * Every shadow record, oldest first. Records from before `v: 2` have no `id`, so they get
 * `legacy-<at>` and can still be labelled.
 * @param {string} dir - the decisions directory.
 * @returns {object[]} the records.
 */
export function readShadow(dir) {
  if (!existsSync(dir)) return []
  const recs = []
  for (const f of readdirSync(dir).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))) {
    for (const r of readJsonl(join(dir, f))) recs.push(r.id === undefined ? { ...r, id: `legacy-${r.at}` } : r)
  }
  return recs.sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

/**
 * @param {string} dir - the decisions directory.
 * @returns {Map<string, Record<string, string>>} record id → question → label (`'skip'` included).
 */
export function readLabels(dir) {
  const labels = new Map()
  const file = join(dir, LABELS_FILE)
  if (!existsSync(file)) return labels
  for (const l of readJsonl(file)) {
    if (typeof l.id !== 'string' || typeof l.question !== 'string' || typeof l.label !== 'string') continue
    labels.set(l.id, { ...labels.get(l.id), [l.question]: l.label })
  }
  return labels
}

/**
 * Append one label. Written as it is entered, so quitting a labelling session loses nothing.
 * @param {string} dir - the decisions directory.
 * @param {{id: string, question: string, label: string}} label - the label.
 */
export function appendLabel(dir, { id, question, label }) {
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, LABELS_FILE), `${JSON.stringify({ id, question, label, at: new Date().toISOString() })}\n`, 'utf8')
}

/**
 * @param {object[]} records - shadow records, in the order to label them.
 * @param {Map<string, Record<string, string>>} labels - from `readLabels`.
 * @param {string} question - the question key.
 * @returns {object[]} the records with no label (not even `skip`) for this question.
 */
export function unlabelled(records, labels, question) {
  return records.filter(r => labels.get(r.id)?.[question] === undefined)
}

/**
 * @param {Map<string, Record<string, string>>} labels - from `readLabels`.
 * @param {string[]} questions - the question keys to count.
 * @returns {Record<string, {labelled: number, skipped: number}>} per question.
 */
export function labelCounts(labels, questions) {
  const c = Object.fromEntries(questions.map(q => [q, { labelled: 0, skipped: 0 }]))
  for (const byQ of labels.values()) {
    for (const q of questions) {
      if (byQ[q] === undefined) continue
      if (byQ[q] === 'skip') c[q].skipped++
      else c[q].labelled++
    }
  }
  return c
}

/**
 * Read what the operator typed at the label prompt: an option number (1-based), an option name,
 * `s` to skip or `q` to quit.
 * @param {string} input - the raw line.
 * @param {string[]} options - the question's option keys, in display order.
 * @returns {{label: string} | {quit: true} | {invalid: true}} the parsed input.
 */
export function parseLabelInput(input, options) {
  const t = input.trim().toLowerCase()
  if (t === 'q') return { quit: true }
  if (t === 's') return { label: 'skip' }
  if (/^\d+$/.test(t)) {
    const i = Number(t) - 1
    return i >= 0 && i < options.length ? { label: options[i] } : { invalid: true }
  }
  return options.includes(t) ? { label: t } : { invalid: true }
}
