/**
 * IO for the persistent tier. Both adapters expose the same two calls over the pure operations of
 * `store.js`:
 *   read(project)            -> ProjectRecord (empty when absent)
 *   mutate(project, op)      -> op's result; `op(record)` returns `{record, node?}`, the record is
 *                               written, and when a node is returned it is re-read and verified.
 *
 * `domainStore` (the dsh plugin) goes through `ctx.storageDomain.open(spec)`
 * (upstream packages/storage/storage-domain/src/index.ts:103) and CLOSES the domain after every
 * operation. The storage-json backend holds a unit in memory while it is open and republishes the
 * whole file on each write (storage-json/src/single-unit.ts), so a long-lived handle would overwrite
 * whatever `/think` wrote meanwhile. Open-per-operation re-reads the file each time; operations are
 * serialised because the facility refuses a second open of one name ("already-open").
 *
 * `fileStore` (the launcher's `/think`) reads and writes the same unit file directly:
 * `$DSH_HOME/storages/finess_thoughts.json` (dsh-base mounts storage-json with
 * `root: dshHomePath('storages')`, dsh-base/cordis.patch.yml:168-171), in storage-json's
 * single-layout document `{unit: {name, version}, global, tables}` (storage-json/src/format.ts:28-38),
 * replaced by write-to-temp-then-rename like the backend's own writeAtomic.
 * @module @finess/thoughts/adapters
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DOMAIN_NAME, DOMAIN_SPEC, DOMAIN_VERSION, TABLE, emptyProject, parseProject, verifyStored } from './store.js'

/** @typedef {import('./store.js').ProjectRecord} ProjectRecord */
/** @typedef {(r: ProjectRecord) => {record: ProjectRecord, node?: import('./schema.js').ThoughtNode}} Op */

/**
 * The plugin-side adapter.
 * @param {{open: (spec: object) => Promise<{table: (n: string) => {get: Function, put: Function}, close: () => Promise<void>}>}} facility
 *   `ctx.storageDomain`.
 * @returns {{read: (p: string) => Promise<ProjectRecord>, mutate: (p: string, op: Op) => Promise<object>}} the store.
 */
export function domainStore(facility) {
  let chain = Promise.resolve()
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} fn, after every earlier call settled. */
  const serial = fn => {
    const p = chain.then(fn)
    chain = p.catch(() => {})
    return p
  }
  const withTable = async fn => {
    const domain = await facility.open(DOMAIN_SPEC)
    try { return await fn(domain.table(TABLE)) } finally { await domain.close() }
  }
  return {
    read: project => serial(() => withTable(t => t.get(project) ?? emptyProject())),
    mutate: (project, op) => serial(async () => {
      const out = await withTable(async t => {
        const res = op(t.get(project) ?? emptyProject())
        await t.put(project, res.record)
        return res
      })
      if (out.node !== undefined) verifyStored(await withTable(t => t.get(project)), out.node)
      return out
    }),
  }
}

/**
 * @param {string} dshHome - `$DSH_HOME` (explicit, else `DSH_HOME`, else `~/.dsh`; the caller resolves it).
 * @returns {string} the unit file the plugin's domain lives in.
 */
export const storeFile = dshHome => join(dshHome, 'storages', `${DOMAIN_NAME}.json`)

/**
 * Read the unit file into its project table.
 * @param {string} file - the unit file.
 * @returns {Map<string, ProjectRecord>} the projects; empty when the file does not exist.
 */
export function readUnit(file) {
  let text
  try { text = readFileSync(file, 'utf8') } catch (e) { if (e?.code === 'ENOENT') return new Map(); throw e }
  const doc = JSON.parse(text)
  if (doc?.unit?.name !== DOMAIN_NAME) throw new Error(`${file}: not a ${DOMAIN_NAME} unit`)
  if (doc.unit.version !== DOMAIN_VERSION) throw new Error(`${file}: stored version ${doc.unit.version} != expected ${DOMAIN_VERSION}`)
  const raw = doc.tables?.[TABLE] ?? {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${file}: table ${TABLE} is not an object`)
  return new Map(Object.entries(raw).map(([k, v]) => [k, parseProject(v)]))
}

/**
 * Replace the unit file atomically (temp file in the same directory, then rename).
 * @param {string} file - the unit file.
 * @param {Map<string, ProjectRecord>} projects - every project.
 * @returns {void}
 */
export function writeUnit(file, projects) {
  mkdirSync(dirname(file), { recursive: true })
  const doc = { unit: { name: DOMAIN_NAME, version: DOMAIN_VERSION }, global: null, tables: { [TABLE]: Object.fromEntries(projects) } }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  try { renameSync(tmp, file) } catch (e) { rmSync(tmp, { force: true }); throw e }
}

/**
 * The launcher-side adapter: same contract as {@link domainStore}, synchronous.
 * @param {string} file - the unit file ({@link storeFile}).
 * @returns {{read: (p: string) => ProjectRecord, mutate: (p: string, op: Op) => object}} the store.
 */
export function fileStore(file) {
  return {
    read: project => readUnit(file).get(project) ?? emptyProject(),
    mutate: (project, op) => {
      const all = readUnit(file)
      const out = op(all.get(project) ?? emptyProject())
      all.set(project, out.record)
      writeUnit(file, all)
      if (out.node !== undefined) verifyStored(readUnit(file).get(project), out.node)
      return out
    },
  }
}
