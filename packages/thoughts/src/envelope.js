/**
 * Boundary parsing for the parts of a stored project record that sit around the nodes: the
 * provenance envelope (`origin`, T-297) and the pending contradictions (`conflicts`, T-296). Kept
 * apart from `store.js` (which calls these from `parseProject`) so `provenance.js` and
 * `conflicts.js` can import the store without a cycle. Pure; depends only on the schema.
 * @module @finess/thoughts/envelope
 */

import { formatIssues, isPlainObject, validateThoughtNode } from './schema.js'

/** A conflict id: `c-<k>`, never confusable with a node id. */
export const CONFLICT_ID_RE = /^c-[1-9][0-9]*$/
/** How a conflict is settled (`/think resolve <id> keep|replace|both`). */
export const RESOLUTIONS = Object.freeze(['keep', 'replace', 'both'])

/**
 * @typedef {{by: 'operator'|'model', session?: string, model?: string, from?: string}} Origin
 *   who wrote it, in which session, with which model (`provider/model`, or 'unknown'), and the
 *   ephemeral id it was promoted from.
 * @typedef {{node: import('./schema.js').ThoughtNode, origin: Origin, storedAt: string}} StoredNode
 * @typedef {{id: string, entry: StoredNode, against: string, reason: string, at: string}} Conflict
 *   a write held back because `entry` contradicts the stored node `against`.
 */

/**
 * Validate an origin envelope; unknown fields are dropped, the known optional ones kept.
 * @param {unknown} o - the raw origin.
 * @param {string} where - error prefix.
 * @returns {Origin} the origin, or throws.
 */
export function parseOrigin(o, where) {
  if (!isPlainObject(o)) throw new Error(`${where}: origin is malformed`)
  const { by, session, model, from } = o
  if (by !== 'operator' && by !== 'model') throw new Error(`${where}: bad origin`)
  return {
    by,
    ...(typeof session === 'string' ? { session } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof from === 'string' ? { from } : {}),
  }
}

/**
 * Validate one stored entry (node + provenance).
 * @param {unknown} s - the raw entry.
 * @param {string} where - error prefix.
 * @returns {StoredNode} the entry, or throws.
 */
export function parseStoredEntry(s, where) {
  if (!isPlainObject(s) || !isPlainObject(s.origin) || typeof s.storedAt !== 'string') throw new Error(`${where} is malformed`)
  const r = validateThoughtNode(s.node)
  if (!r.ok || r.value.scope !== 'persistent') throw new Error(`${where}: ${r.ok ? 'not persistent' : formatIssues(r.errors)}`)
  return { node: r.value, origin: parseOrigin(s.origin, where), storedAt: s.storedAt }
}

/**
 * The optional conflict fields of a project record, validated. Absent means none.
 * @param {Record<string, unknown>} v - the raw project record.
 * @returns {{conflicts?: Conflict[], nextConflict?: number}} the fields to spread into the record.
 */
export function parseConflictFields(v) {
  if (v.conflicts === undefined && v.nextConflict === undefined) return {}
  if (!Array.isArray(v.conflicts) || !Number.isSafeInteger(v.nextConflict) || v.nextConflict < 1) throw new Error('thought store: malformed conflicts')
  const conflicts = v.conflicts.map((c, i) => {
    const where = `thought store: conflict ${i}`
    if (!isPlainObject(c) || typeof c.id !== 'string' || !CONFLICT_ID_RE.test(c.id) || typeof c.against !== 'string' || typeof c.reason !== 'string' || typeof c.at !== 'string') throw new Error(`${where} is malformed`)
    return { id: c.id, entry: parseStoredEntry(c.entry, where), against: c.against, reason: c.reason, at: c.at }
  })
  return { conflicts, nextConflict: v.nextConflict }
}
