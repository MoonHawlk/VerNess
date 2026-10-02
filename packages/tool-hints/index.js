/**
 * Corrective hints on failed tool calls (T-438). Small local models misuse the tool schemas in a few
 * recurring ways (glob's `path` used as the pattern, a required field left out, a write before the
 * read the policy demands, a guessed file name). This plugin appends ONE line with a concrete
 * corrected call to such a failure, so the retry copies JSON instead of re-deriving it from prose.
 *
 * It costs no prompt tokens: nothing is added to the system prompt, only to results that already
 * failed. It never rewrites arguments (the substrate forbids it: arguments are already logged) and
 * keeps `isError` and the error code, so telemetry still counts the failure.
 *
 * Plain ESM with no imports: no build step, nothing to link, and the tests run without dsh.
 * @module @finess/tool-hints
 */

export const name = 'finess-tool-hints'
export const inject = ['tools']

const WILD = /[*?[\]{}]/

/**
 * The call's arguments as an object: the registry passes parsed JSON, but a raw string or nothing
 * can arrive when parsing failed.
 * @param {unknown} args - `exec.arguments`.
 * @returns {Record<string, unknown>} the arguments, empty when unusable.
 */
export function argsOf(args) {
  if (typeof args === 'string') { try { args = JSON.parse(args) } catch { return {} } }
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {}
}

/** @param {string} tool @param {object} args @returns {string} a call the model can copy. */
const call = (tool, args) => `${tool} ${JSON.stringify(args)}`

/**
 * Clean a model-written path: stray quotes, trailing slashes and a trailing `/.`.
 * @param {string} p - the path.
 * @returns {string} the cleaned path.
 */
export const cleanPath = p => p.trim().replace(/^["']+|["']+$/g, '').replace(/[\\/]+\.?$/, '').replace(/["']+$/, '')

/** @param {string} p @returns {string} the last path segment. */
const base = p => p.split(/[\\/]/).filter(s => s !== '').pop() ?? p

/**
 * Split a glob `path` that carries wildcards into a plain directory and the wildcard rest.
 * @param {string} p - e.g. `docs/*` or `**\/docs/**`.
 * @returns {{dir: string|undefined, rest: string}} the directory before the first wildcard segment.
 */
export function splitWild(p) {
  const segs = cleanPath(p).split(/[\\/]/)
  const at = segs.findIndex(s => WILD.test(s))
  if (at < 0) return { dir: segs.join('/'), rest: '' }
  return { dir: at === 0 ? undefined : segs.slice(0, at).join('/'), rest: segs.slice(at).join('/') }
}

/**
 * The required parameter names of a tool definition (`parameters.<name>.required === true`).
 * @param {{parameters?: Record<string, {required?: boolean}>}|undefined} def - the tool definition.
 * @returns {string[]} the names, in declaration order.
 */
export const requiredOf = def => Object.entries(def?.parameters ?? {}).filter(([, s]) => s?.required === true).map(([k]) => k)

/**
 * The hint for one failed call, or undefined when there is nothing better to say than the error.
 * @param {{tool: string, args: unknown, code: string|undefined, message?: string, required?: string[]}} f
 *   the failure: tool name, arguments, error code, error text, and the tool's required parameters.
 * @returns {string|undefined} one line starting with `Hint:`.
 */
export function hintFor({ tool, args, code, message = '', required = [] }) {
  const a = argsOf(args)
  const path = typeof a.path === 'string' ? a.path : undefined
  const file = typeof a.file_path === 'string' ? a.file_path : undefined
  if (code === 'INVALID_ARGS') {
    if (tool === 'glob' && a.pattern === undefined && path !== undefined) {
      const { dir, rest } = splitWild(path)
      // A wildcard path is the pattern; a file name is a pattern too (no "/" = any depth); else a dir.
      const fix = rest !== '' ? (dir === undefined ? { pattern: rest } : { pattern: rest, path: dir })
        : /\.[A-Za-z0-9]+$/.test(dir) && !dir.includes('/') ? { pattern: dir }
          : { pattern: '*', path: dir }
      return `Hint: glob's "pattern" is the glob; "path" is only a directory. Try: ${call('glob', fix)}`
    }
    if (tool === 'pwsh' || tool === 'bash') {
      if (typeof a.command === 'string' && a.description === undefined && message.includes('"description"')) {
        return `Hint: add "description" (5-10 words). Try: ${call(tool, { command: a.command, description: 'Run the command' })}`
      }
    }
    if (tool === 'edit' && a.old_string === undefined && file !== undefined) {
      return `Hint: edit needs "old_string" (exact text to replace, copied from a read). To replace the whole file: ${call('read', { file_path: file })}, then write.`
    }
    const missing = [...message.matchAll(/missing required property "([^"]+)"/g)].map(m => m[1])
    if (missing.length === 0) return undefined
    const req = required.length > 0 ? ` (required: ${required.join(', ')})` : ''
    return `Hint: ${tool} is missing ${missing.map(r => `"${r}"`).join(', ')}${req}; resend the call with every required field.`
  }
  if (code === 'FS_NOT_OBSERVED' && file !== undefined) {
    return `Hint: do this first: ${call('read', { file_path: file })} - then repeat the ${tool}.`
  }
  if (code === 'FS_NOT_FOUND' && file !== undefined) {
    const clean = cleanPath(file)
    if (/["']/.test(file) && clean !== '') return `Hint: the path has stray quotes; did you mean "${clean}"?`
    const name = base(clean)
    return name === '' ? undefined : `Hint: do not guess paths. Find it: ${call('glob', { pattern: `**/${name}` })}`
  }
  if (code === 'FS_NOT_REGULAR_FILE' && file !== undefined) {
    return `Hint: that is a directory. List it: ${call('glob', { pattern: '*', path: cleanPath(file) })}`
  }
  if (code === 'SEARCH_FAILED' && tool === 'glob' && path !== undefined && WILD.test(path)) {
    const { dir, rest } = splitWild(path)
    const pattern = [rest, typeof a.pattern === 'string' ? a.pattern : '*'].filter(s => s !== '').join('/')
    return `Hint: "path" must be a plain directory, no wildcards. Try: ${call('glob', dir === undefined ? { pattern } : { pattern, path: dir })}`
  }
  return undefined
}

/**
 * Mount: decorate failed results after every other post-execute listener has decided. A `block`
 * decision is left alone (another policy owns that feedback); an accepted failure gets the hint
 * appended to whatever content it already carries.
 * @param {{on: Function, tools?: {get: Function}}} ctx - registrant context.
 */
export function apply(ctx) {
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept' || result.isError !== true || Object.hasOwn(decision, 'value')) return decision
    let required = []
    try { required = requiredOf(ctx.tools?.get(exec.name, exec.agent)) } catch { /* unknown tool */ }
    const hint = hintFor({ tool: exec.name, args: exec.arguments, code: result.error?.info?.code, message: result.error?.message, required })
    if (hint === undefined) return decision
    const content = decision.content ?? result.content ?? []
    return { ...decision, content: [...content, { type: 'text', text: hint }] }
  })
}
