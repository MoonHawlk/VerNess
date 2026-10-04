/**
 * Eviction by demotion (T-288): when a node write would push a project past its byte cap, older
 * nodes are demoted to STUBS until it fits. A stub is never deleted: it keeps its id, kind, turn,
 * timestamp and edges, a 60-character head of its claim, and a recovery pointer to the session log
 * that still holds the full node (`/think restore <p-id>`).
 *
 * Encoding, inside the existing node fields (no store-shape change, so DOMAIN_VERSION stays 1 and
 * an older reader sees a short, plainly marked node rather than a wrong one):
 *   claim     `[demoted] <head>…`
 *   evidence  [`recover: <session>#<n-id>`]
 *   confidence `asserted`
 * Only a node whose origin names both the session and the ephemeral id it was promoted from can be
 * recovered, so only those are demotable. Operator-written nodes are not: a write that cannot be
 * made to fit by demoting still throws ThoughtStoreFullError and changes nothing (store.js).
 * Order: attempts, artifacts, findings, decisions, constraints last; oldest first within a kind.
 * @module @finess/thoughts/evict
 */

import { isTaskStart, recordOf } from './fold.js'
import { formatIssues, validateThoughtNode } from './schema.js'

export const STUB_PREFIX = '[demoted] '
export const RECOVER_PREFIX = 'recover: '
export const STUB_CLAIM_CHARS = 60
/** Demotion order by kind: first demoted first. */
export const DEMOTE_ORDER = Object.freeze(['attempt', 'artifact', 'finding', 'decision', 'constraint'])

/**
 * @typedef {import('./schema.js').ThoughtNode} ThoughtNode
 * @typedef {import('./store.js').StoredNode} StoredNode
 * @typedef {import('./store.js').ProjectRecord} ProjectRecord
 */

const bytes = r => Buffer.byteLength(JSON.stringify(r), 'utf8')

/** @param {ThoughtNode} n @returns {boolean} whether the node is a demoted stub. */
export const isStubNode = n => n.claim.startsWith(STUB_PREFIX) && n.evidence.some(e => e.startsWith(RECOVER_PREFIX))

/** @param {StoredNode} s @returns {boolean} whether the entry can be demoted (recoverable, not yet a stub). */
export const demotable = s => typeof s.origin.session === 'string' && typeof s.origin.from === 'string' && !isStubNode(s.node)

/**
 * The recovery pointer of a stub.
 * @param {ThoughtNode} n - a stub.
 * @returns {{session: string, from: string}|undefined} where the full node lives.
 */
export function recoveryOf(n) {
  const e = n.evidence.find(x => x.startsWith(RECOVER_PREFIX))
  const m = e === undefined ? null : /^(.+)#(n-[1-9][0-9]*)$/.exec(e.slice(RECOVER_PREFIX.length))
  return m === null ? undefined : { session: m[1], from: m[2] }
}

/**
 * Demote one entry to its stub.
 * @param {StoredNode} s - a demotable entry.
 * @returns {StoredNode} the stub entry.
 */
export function stubOf(s) {
  const head = s.node.claim.length <= STUB_CLAIM_CHARS ? s.node.claim : `${s.node.claim.slice(0, STUB_CLAIM_CHARS).trimEnd()}…`
  const v = validateThoughtNode({ ...s.node, claim: `${STUB_PREFIX}${head}`, evidence: [`${RECOVER_PREFIX}${s.origin.session}#${s.origin.from}`], confidence: 'asserted' })
  if (!v.ok) throw new Error(`cannot demote ${s.node.id}: ${formatIssues(v.errors)}`)
  return { ...s, node: v.value }
}

/**
 * Demote entries, in DEMOTE_ORDER, until the record fits the cap or nothing demotable is left.
 * @param {ProjectRecord} r - the candidate record (possibly over the cap).
 * @param {number} cap - bytes.
 * @param {Iterable<string>} [protect] - ids never demoted (the node being written).
 * @returns {{record: ProjectRecord, demoted: string[]}} the record (still over the cap when nothing more could go) and the demoted ids.
 */
export function demoteToFit(r, cap, protect = []) {
  if (bytes(r) <= cap) return { record: r, demoted: [] }
  const keep = new Set(protect)
  const rank = s => DEMOTE_ORDER.indexOf(s.node.kind)
  const queue = r.nodes.filter(s => demotable(s) && !keep.has(s.node.id))
    .sort((a, b) => rank(a) - rank(b) || a.storedAt.localeCompare(b.storedAt) || Number(a.node.id.slice(2)) - Number(b.node.id.slice(2)))
  let record = r
  const demoted = []
  for (const s of queue) {
    if (bytes(record) <= cap) break
    record = { ...record, nodes: record.nodes.map(x => (x.node.id === s.node.id ? stubOf(x) : x)) }
    demoted.push(s.node.id)
  }
  return { record, demoted }
}

/**
 * Find the full node a stub points at in its session log. Ephemeral ids repeat across tasks, so
 * the record must also match the stub's timestamp and kind.
 * @param {ThoughtNode} stub - the stub.
 * @param {Iterable<unknown>} events - the session log named by the pointer.
 * @returns {ThoughtNode|undefined} the original ephemeral node.
 */
export function findOriginal(stub, events) {
  const p = recoveryOf(stub)
  if (p === undefined) return undefined
  for (const e of events) {
    if (isTaskStart(e)) continue
    const n = recordOf(e)
    if (n !== undefined && n.id === p.from && n.at === stub.at && n.kind === stub.kind) return n
  }
  return undefined
}

/**
 * Re-inflate a stub from its original (the caller caps the result; other nodes may be demoted).
 * @param {ProjectRecord} r - the project.
 * @param {string} id - the stub's id.
 * @param {ThoughtNode} original - from {@link findOriginal}.
 * @returns {ProjectRecord} the record with the full node back under the same id and edges.
 */
export function restoreStub(r, id, original) {
  const s = r.nodes.find(x => x.node.id === id)
  if (s === undefined) throw new Error(`no persistent node ${id}`)
  if (!isStubNode(s.node)) throw new Error(`${id} is not a demoted stub`)
  const v = validateThoughtNode({ ...original, id, scope: 'persistent', derivedFrom: s.node.derivedFrom })
  if (!v.ok) throw new Error(`cannot restore ${id}: ${formatIssues(v.errors)}`)
  return { ...r, nodes: r.nodes.map(x => (x === s ? { ...x, node: v.value } : x)) }
}
