/**
 * The persistent tier (T-284): nodes that outlive the session, kept in `ctx.storage` - deliberately
 * outside the session log (no replay, no compaction). Pure: every operation takes a project record
 * and returns the next one, or throws. The IO adapters are `domain-store.js` (the dsh plugin, through
 * `ctx.storageDomain`) and `file-store.js` (the launcher, the same JSON file on disk).
 *
 * One domain, `finess_thoughts`, table `projects`, keyed by project (see {@link projectKey}). Each
 * project record is capped in bytes; a write that would exceed the cap THROWS
 * {@link ThoughtStoreFullError} and changes nothing - unless a node write (add, promote) can make
 * room by demoting older recoverable nodes to stubs (T-288, evict.js); demoted ids are returned.
 * Each stored node carries a provenance envelope (`origin`) so T-297 can trace and revoke.
 * @module @finess/thoughts/store
 */

import { demoteToFit } from './evict.js'
import { buildNode, formatIssues, isPlainObject, validateThoughtNode } from './schema.js'

/** Domain (= storage-json unit file) name; must match the substrate's UNIT_NAME_RE `^[a-z][a-z0-9_]*$`. */
export const DOMAIN_NAME = 'finess_thoughts'
/** Bump on any change to the stored record shape. */
export const DOMAIN_VERSION = 1
export const TABLE = 'projects'
/** Per-project byte cap of the serialized record. */
export const DEFAULT_CAP_BYTES = 16 * 1024

/**
 * @typedef {import('./schema.js').ThoughtNode} ThoughtNode
 * @typedef {{by: 'operator'|'model', session?: string, from?: string}} Origin
 *   who wrote it, in which session, and the ephemeral id it was promoted from.
 * @typedef {{node: ThoughtNode, origin: Origin, storedAt: string}} StoredNode
 * @typedef {{nextId: number, nodes: StoredNode[]}} ProjectRecord
 */

/** The persistent store is at its byte cap; the caller must consolidate (forget) first. */
export class ThoughtStoreFullError extends Error {
  /** @param {number} bytes - size the write would have produced. @param {number} cap - the cap. */
  constructor(bytes, cap) {
    super(`persistent thought store is full: this write needs ${bytes} bytes, the cap is ${cap}. Consolidate first: forget nodes that no longer matter (/think forget <id>).`)
    this.name = 'ThoughtStoreFullError'
    this.code = 'THOUGHTS_FULL'
    this.bytes = bytes
    this.cap = cap
  }
}

/**
 * The project a store record belongs to: the working directory, absolute, forward slashes, no
 * trailing slash. A drive-letter path is lower-cased whole (Windows paths are case-insensitive);
 * any other path keeps its case. The rule depends on the path's shape, not the host OS.
 * @param {string} dir - an absolute directory.
 * @returns {string} the key.
 */
export function projectKey(dir) {
  let p = String(dir).replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[A-Za-z]:(\/|$)/.test(p)) p = p.toLowerCase()
  return p === '' ? '/' : p
}

/** @returns {ProjectRecord} an empty project. */
export const emptyProject = () => ({ nextId: 1, nodes: [] })

/** @param {ProjectRecord} r @returns {number} UTF-8 bytes of the serialized record. */
export const recordBytes = r => Buffer.byteLength(JSON.stringify(r), 'utf8')

/**
 * Validate a stored project record (the domain's `valueSchema.parse`; the file adapter uses it too).
 * @param {unknown} v - the raw record.
 * @returns {ProjectRecord} the record, or throws.
 */
export function parseProject(v) {
  if (!isPlainObject(v) || !Number.isSafeInteger(v.nextId) || v.nextId < 1 || !Array.isArray(v.nodes)) throw new Error('thought store: malformed project record')
  const nodes = v.nodes.map((s, i) => {
    if (!isPlainObject(s) || !isPlainObject(s.origin) || typeof s.storedAt !== 'string') throw new Error(`thought store: entry ${i} is malformed`)
    const r = validateThoughtNode(s.node)
    if (!r.ok || r.value.scope !== 'persistent') throw new Error(`thought store: entry ${i}: ${r.ok ? 'not persistent' : formatIssues(r.errors)}`)
    const { by, session, from } = s.origin
    if (by !== 'operator' && by !== 'model') throw new Error(`thought store: entry ${i}: bad origin`)
    return { node: r.value, origin: { by, ...(typeof session === 'string' ? { session } : {}), ...(typeof from === 'string' ? { from } : {}) }, storedAt: s.storedAt }
  })
  return { nextId: v.nextId, nodes }
}

/** The storage-domain spec (`ctx.storageDomain.open`); schemas are duck-typed `{parse}`. */
export const DOMAIN_SPEC = Object.freeze({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  tables: { [TABLE]: { valueSchema: { parse: parseProject } } },
})

/**
 * Refuse a record over the cap.
 * @param {ProjectRecord} r - the candidate.
 * @param {number} cap - bytes.
 * @returns {ProjectRecord} the same record.
 */
function capped(r, cap) {
  const bytes = recordBytes(r)
  if (bytes > cap) throw new ThoughtStoreFullError(bytes, cap)
  return r
}

/**
 * Fit a node write under the cap by demotion (T-288), else refuse it unchanged.
 * @param {ProjectRecord} r - the candidate.
 * @param {number} cap - bytes.
 * @param {string} id - the node being written (never demoted).
 * @returns {{record: ProjectRecord, demoted: string[]}} the record that fits and what was demoted.
 */
function fitted(r, cap, id) {
  const out = demoteToFit(r, cap, [id])
  if (recordBytes(out.record) > cap) throw new ThoughtStoreFullError(recordBytes(r), cap)
  return out
}

/** @param {ProjectRecord} r @param {string} id @returns {StoredNode|undefined} the entry. */
export const findStored = (r, id) => r.nodes.find(s => s.node.id === id)

/**
 * Add a node written straight to the persistent tier (the operator's `/think add`).
 * @param {ProjectRecord} r - the project.
 * @param {object} input - `{kind, claim, evidence?, confidence?, derivedFrom?}`.
 * @param {{at: string, origin: Origin, cap?: number}} opts - timestamp, provenance, byte cap.
 * @returns {{record: ProjectRecord, node: ThoughtNode, demoted: string[]}} the next record, the stored node, and the ids demoted to make room.
 */
export function addPersistent(r, input, { at, origin, cap = DEFAULT_CAP_BYTES }) {
  const built = buildNode(input, { id: `p-${r.nextId}`, scope: 'persistent', turn: 0, at })
  if (!built.ok) throw new Error(`invalid node: ${formatIssues(built.errors)}`)
  const node = built.value
  const unknown = node.derivedFrom.filter(id => findStored(r, id) === undefined)
  if (unknown.length > 0) throw new Error(`derivedFrom names nodes not in the persistent store: ${unknown.join(', ')}`)
  const { record, demoted } = fitted({ nextId: r.nextId + 1, nodes: [...r.nodes, { node, origin, storedAt: at }] }, cap, node.id)
  return { record, node, demoted }
}

/**
 * Promote an ephemeral node: a copy under a fresh `p-` id. Edges to other ephemeral nodes are
 * dropped (they reset with the task); the source id is kept in `origin.from`.
 * @param {ProjectRecord} r - the project.
 * @param {ThoughtNode} eph - the ephemeral node.
 * @param {{at: string, origin: Origin, cap?: number}} opts - timestamp, provenance, byte cap.
 * @returns {{record: ProjectRecord, node: ThoughtNode, demoted: string[]}} the next record, the stored node, and the ids demoted to make room.
 */
export function promote(r, eph, { at, origin, cap = DEFAULT_CAP_BYTES }) {
  if (eph.scope !== 'ephemeral') throw new Error(`${eph.id} is already persistent`)
  const dup = r.nodes.find(s => s.origin.session !== undefined && s.origin.session === origin.session && s.origin.from === eph.id && s.node.claim === eph.claim)
  if (dup !== undefined) throw new Error(`${eph.id} was already promoted as ${dup.node.id}`)
  const v = validateThoughtNode({ ...eph, id: `p-${r.nextId}`, scope: 'persistent', derivedFrom: eph.derivedFrom.filter(id => findStored(r, id) !== undefined) })
  if (!v.ok) throw new Error(`invalid node: ${formatIssues(v.errors)}`)
  const { record, demoted } = fitted({ nextId: r.nextId + 1, nodes: [...r.nodes, { node: v.value, origin: { ...origin, from: eph.id }, storedAt: at }] }, cap, v.value.id)
  return { record, node: v.value, demoted }
}

/**
 * Add the edge "`a` was derived from `b`" between two persistent nodes.
 * @param {ProjectRecord} r - the project.
 * @param {string} a - the derived node.
 * @param {string} b - its source.
 * @param {{cap?: number}} [opts] - byte cap.
 * @returns {ProjectRecord} the next record.
 */
export function link(r, a, b, { cap = DEFAULT_CAP_BYTES } = {}) {
  const sa = findStored(r, a)
  if (sa === undefined) throw new Error(`no persistent node ${a}`)
  if (findStored(r, b) === undefined) throw new Error(`no persistent node ${b}`)
  if (a === b) throw new Error('a node cannot derive from itself')
  if (sa.node.derivedFrom.includes(b)) throw new Error(`${a} already derives from ${b}`)
  const v = validateThoughtNode({ ...sa.node, derivedFrom: [...sa.node.derivedFrom, b] })
  if (!v.ok) throw new Error(`invalid node: ${formatIssues(v.errors)}`)
  return capped({ ...r, nodes: r.nodes.map(s => (s === sa ? { ...s, node: v.value } : s)) }, cap)
}

/**
 * Remove a persistent node and every edge pointing at it. The id is never reused.
 * @param {ProjectRecord} r - the project.
 * @param {string} id - the node.
 * @returns {ProjectRecord} the next record.
 */
export function forget(r, id) {
  if (findStored(r, id) === undefined) throw new Error(`no persistent node ${id}`)
  const nodes = r.nodes.filter(s => s.node.id !== id).map(s => (s.node.derivedFrom.includes(id) ? { ...s, node: { ...s.node, derivedFrom: s.node.derivedFrom.filter(x => x !== id) } } : s))
  return { ...r, nodes }
}

/**
 * Re-read check after a write: the node must be stored exactly as written. A persistent write is
 * never trusted on the writer's word (docs/10-THOUGHT-GRAPH.md, prior art 3).
 * @param {ProjectRecord|undefined} reread - the record read back.
 * @param {ThoughtNode} node - what was written.
 * @returns {void} throws when it is missing or differs.
 */
export function verifyStored(reread, node) {
  const s = reread === undefined ? undefined : findStored(reread, node.id)
  if (s === undefined || JSON.stringify(s.node) !== JSON.stringify(node)) throw new Error(`write of ${node.id} did not verify on re-read`)
}

/** @param {ProjectRecord} r @returns {ThoughtNode[]} the nodes, oldest first. */
export const storedNodes = r => r.nodes.map(s => s.node)
