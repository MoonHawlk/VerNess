/**
 * Contradictions (T-296): a persistent write whose claim contradicts a stored node is held back as a
 * pending conflict, never written over it and never dropped. The operator settles it with
 * `/think resolve <c-id> keep|replace|both`.
 *
 * The rule is structural, deliberately simple and explainable (a model only shadows it, T-295):
 * a claim is read as `subject predicate [not] value` over a closed predicate list. Two claims
 * contradict when subject and predicate match and
 *  - one is negated and the other not, with the same value ("X is Y" / "X is not Y"), or
 *  - both are positive with different values, for a single-valued predicate ("X is Y" / "X is Z").
 * Multi-valued predicates (uses, includes, has, ...) only conflict on a negation flip. An explicit
 * `--contradicts p-k` always counts. Pure: every operation takes a project record and returns the next.
 * @module @finess/thoughts/conflicts
 */

import { CONFLICT_ID_RE, RESOLUTIONS } from './envelope.js'
import { formatIssues, validateThoughtNode } from './schema.js'
import { DEFAULT_CAP_BYTES, ThoughtStoreFullError, findStored, forget, recordBytes } from './store.js'

/** @typedef {import('./store.js').ProjectRecord} ProjectRecord */
/** @typedef {import('./envelope.js').Conflict} Conflict */
/** @typedef {{subject: string, predicate: string, negated: boolean, value: string}} Triple */

/** Surface form -> canonical predicate and whether it holds a single value. Longest phrases first. */
const PREDICATES = [
  ['defaults to', 'defaults to', true], ['default to', 'defaults to', true],
  ['must be', 'must be', true], ['should be', 'must be', true],
  ['runs on', 'runs on', true], ['run on', 'runs on', true],
  ['lives in', 'lives in', true], ['live in', 'lives in', true],
  ['points to', 'points to', true], ['point to', 'points to', true],
  ['belongs to', 'belongs to', true], ['belong to', 'belongs to', true],
  ['equals', 'equals', true], ['equal', 'equals', true],
  ['returns', 'returns', true], ['return', 'returns', true],
  ['is', 'is', true], ['are', 'is', true], ['was', 'is', true], ['were', 'is', true],
  ['uses', 'uses', false], ['use', 'uses', false],
  ['requires', 'requires', false], ['require', 'requires', false],
  ['needs', 'requires', false], ['need', 'requires', false],
  ['includes', 'includes', false], ['include', 'includes', false],
  ['contains', 'includes', false], ['contain', 'includes', false],
  ['has', 'has', false], ['have', 'has', false],
].map(([surface, canon, single]) => ({ words: surface.split(' '), canon, single }))

const SINGLE = new Map(PREDICATES.map(p => [p.canon, p.single]))
const AUX = new Set(['does', 'do', 'did', 'can', 'will'])
const NEGATORS = new Set(['not', 'never'])
const ARTICLES = new Set(['the', 'a', 'an'])

/** @param {string} s @returns {string[]} lower-case words, contractions expanded, quotes and end punctuation stripped. */
const words = s => String(s).toLowerCase()
  .replace(/\bcan['’]t\b|\bcannot\b/g, 'can not').replace(/n['’]t\b/g, ' not')
  .replace(/[`"'‘’“”](?![a-z])|(?<![a-z])[`"'‘’“”]/g, ' ')
  .replace(/[.!?;,]+(\s|$)/g, ' ').split(/\s+/).filter(w => w !== '')

/** @param {string[]} ws @returns {string} the phrase without leading articles. */
const phrase = ws => { let i = 0; while (i < ws.length && ARTICLES.has(ws[i])) i++; return ws.slice(i).join(' ') }

/**
 * Read a claim as `subject predicate [not] value`, or undefined when it has no listed predicate.
 * @param {string} claim - a node claim.
 * @returns {Triple|undefined} the parts.
 */
export function claimTriple(claim) {
  const ws = words(claim)
  for (let i = 1; i < ws.length; i++) {
    const p = PREDICATES.find(c => c.words.every((w, k) => ws[i + k] === w))
    if (p === undefined) continue
    let subj = ws.slice(0, i)
    let negated = false
    // "X does not use Y", "X never returns Y"
    while (subj.length > 1 && (NEGATORS.has(subj.at(-1)) || AUX.has(subj.at(-1)))) { if (NEGATORS.has(subj.at(-1))) negated = true; subj = subj.slice(0, -1) }
    let rest = ws.slice(i + p.words.length)
    if (rest[0] === 'not' || rest[0] === 'never' || rest[0] === 'no') { negated = true; rest = rest.slice(1) }
    const subject = phrase(subj)
    const value = phrase(rest)
    if (subject === '' || value === '') return undefined
    return { subject, predicate: p.canon, negated, value }
  }
  return undefined
}

/**
 * Why two claims contradict under the structural rule, or undefined.
 * @param {string} a - one claim.
 * @param {string} b - the other.
 * @returns {string|undefined} a one-line reason.
 */
export function contradiction(a, b) {
  const x = claimTriple(a)
  const y = claimTriple(b)
  if (x === undefined || y === undefined || x.subject !== y.subject || x.predicate !== y.predicate) return undefined
  const head = `"${x.subject}" ${x.predicate}`
  if (x.value === y.value) return x.negated === y.negated ? undefined : `${head}: "${x.value}" asserted and denied`
  if (!x.negated && !y.negated && SINGLE.get(x.predicate) === true) return `${head}: "${x.value}" vs "${y.value}"`
  return undefined
}

/**
 * The first stored node a claim contradicts.
 * @param {ProjectRecord} r - the project.
 * @param {string} claim - the incoming claim.
 * @returns {{against: string, reason: string}|undefined} the hit.
 */
export function findContradiction(r, claim) {
  for (const s of r.nodes) {
    const reason = contradiction(claim, s.node.claim)
    if (reason !== undefined) return { against: s.node.id, reason }
  }
  return undefined
}

/** @param {ProjectRecord} r @returns {Conflict[]} the pending conflicts, oldest first. */
export const pendingConflicts = r => r.conflicts ?? []

/** @param {ProjectRecord} r @param {number} cap @returns {ProjectRecord} r, or throws when over the cap. */
function capped(r, cap) {
  const bytes = recordBytes(r)
  if (bytes > cap) throw new ThoughtStoreFullError(bytes, cap)
  return r
}

/**
 * Run a persistent write (`addPersistent` / `promote` from store.js) through the contradiction
 * guard. When the new claim contradicts a stored node (or `contradicts` names one), the write is
 * held back as a pending conflict: the node is not stored, its reserved id is not reused.
 * @param {ProjectRecord} r - the project.
 * @param {(r: ProjectRecord) => {record: ProjectRecord, node: import('./schema.js').ThoughtNode}} write - the write.
 * @param {{at: string, contradicts?: string, cap?: number}} opts - timestamp, explicit target, byte cap.
 * @returns {{record: ProjectRecord, node?: import('./schema.js').ThoughtNode, conflict?: Conflict}} stored, or held.
 */
export function guardedWrite(r, write, { at, contradicts, cap = DEFAULT_CAP_BYTES }) {
  if (contradicts !== undefined && findStored(r, contradicts) === undefined) throw new Error(`--contradicts names no persistent node ${contradicts}`)
  const res = write(r)
  const entry = res.record.nodes.at(-1)
  const same = pendingConflicts(r).find(c => c.entry.node.claim === entry.node.claim && c.entry.origin.from === entry.origin.from && c.entry.origin.session === entry.origin.session)
  if (same !== undefined) throw new Error(`this claim is already pending as ${same.id} - /think resolve ${same.id} keep|replace|both`)
  const hit = contradicts !== undefined ? { against: contradicts, reason: 'marked as contradicting by the writer' } : findContradiction(r, entry.node.claim)
  if (hit === undefined) return res
  const n = r.nextConflict ?? 1
  const conflict = { id: `c-${n}`, entry, against: hit.against, reason: hit.reason, at }
  return { record: capped({ ...r, nextId: res.record.nextId, conflicts: [...pendingConflicts(r), conflict], nextConflict: n + 1 }, cap), conflict }
}

/**
 * Settle a pending conflict.
 * - keep: the stored node stays, the incoming one is discarded.
 * - replace: the stored node is forgotten (edges to it too), the incoming one is stored.
 * - both: both stay; the operator judged them compatible.
 * @param {ProjectRecord} r - the project.
 * @param {string} id - a `c-<k>` id.
 * @param {string} how - keep | replace | both.
 * @param {{cap?: number}} [opts] - byte cap.
 * @returns {{record: ProjectRecord, conflict: Conflict, node?: import('./schema.js').ThoughtNode, removed?: import('./envelope.js').StoredNode}} the next record.
 */
export function resolveConflict(r, id, how, { cap = DEFAULT_CAP_BYTES } = {}) {
  if (!CONFLICT_ID_RE.test(id)) throw new Error(`expected a conflict id like c-1, got ${id}`)
  if (!RESOLUTIONS.includes(how)) throw new Error(`resolve how: ${RESOLUTIONS.join(' | ')}`)
  const conflict = pendingConflicts(r).find(c => c.id === id)
  if (conflict === undefined) throw new Error(`no pending conflict ${id} - /think conflicts lists them`)
  const rest = pendingConflicts(r).filter(c => c !== conflict)
  const without = { ...r, conflicts: rest }
  if (how === 'keep') return { record: without, conflict }
  const removed = how === 'replace' ? findStored(r, conflict.against) : undefined
  const base = removed === undefined ? without : forget(without, conflict.against)
  const v = validateThoughtNode({ ...conflict.entry.node, derivedFrom: conflict.entry.node.derivedFrom.filter(x => findStored(base, x) !== undefined) })
  if (!v.ok) throw new Error(`invalid node: ${formatIssues(v.errors)}`)
  const record = capped({ ...base, nodes: [...base.nodes, { ...conflict.entry, node: v.value }] }, cap)
  return { record, conflict, node: v.value, ...(removed === undefined ? {} : { removed }) }
}
