/**
 * Persona tool policy, enforced (T-042). The active persona's `tools: {allow, deny, approval}` reaches
 * this plugin as its row config (the launcher writes it into the profile patch and every per-run
 * persona overlay), and a `tools/pre-execute` listener refuses what the policy forbids with a reason
 * the model reads in the tool result.
 *
 * Semantics: deny wins; a non-empty allow list blocks everything not in it; `approval[tool]: 'ask'`
 * asks once through the substrate's approval seam (no approval channel = refused); an empty or absent
 * policy is unrestricted. A persona file that failed to load arrives as `broken` and fails closed:
 * only read-only tools run. `bash` and `pwsh` are one shell, so a policy reads the same on macOS and
 * Windows.
 *
 * Plain ESM with no imports: the launcher's `/tools` and `/permissions` import `decide` from here, so
 * the plugin and the quick-tools never disagree.
 * @module @finess/tool-policy
 */

export const name = 'finess-tool-policy'

/** Tools that run even for a broken persona: they only read. */
export const READ_ONLY = ['read', 'grep', 'glob']

/** Platform aliases of one tool: the shell is `bash` on macOS/Linux and `pwsh` on Windows. */
const SHELL = new Set(['bash', 'pwsh'])

/** @param {string} a @param {string} b @returns {boolean} whether two tool names mean the same tool. */
export const sameTool = (a, b) => a === b || (SHELL.has(a) && SHELL.has(b))

/** @param {string[]} list @param {string} tool @returns {boolean} whether the list names the tool. */
const names = (list, tool) => list.some(t => sameTool(t, tool))

/** @param {unknown} v @returns {string[]} the strings of an array, else []. */
const strings = v => (Array.isArray(v) ? v.filter(s => typeof s === 'string' && s !== '') : [])

/**
 * @typedef {object} Policy
 * @property {string} persona - the persona id, for reasons.
 * @property {string[]} allow - when non-empty, the only tools that run.
 * @property {string[]} deny - tools that never run.
 * @property {Record<string, 'allow'|'ask'|'deny'>} approval - per-tool approval mode.
 * @property {string} [broken] - the persona file that failed to load; set = fail closed.
 */

/**
 * Normalize the plugin's row config into a policy. Anything missing is unrestricted.
 * @param {unknown} config - `{persona, allow, deny, approval, broken}` from the patch.
 * @returns {Policy} the policy.
 */
export function policyOf(config) {
  const c = config !== null && typeof config === 'object' ? /** @type {Record<string, unknown>} */ (config) : {}
  const approval = {}
  if (c.approval !== null && typeof c.approval === 'object') {
    for (const [tool, mode] of Object.entries(c.approval)) if (mode === 'allow' || mode === 'ask' || mode === 'deny') approval[tool] = mode
  }
  const policy = {
    persona: typeof c.persona === 'string' && c.persona !== '' ? c.persona : 'unknown',
    allow: strings(c.allow),
    deny: strings(c.deny),
    approval,
  }
  if (typeof c.broken === 'string' && c.broken !== '') policy.broken = c.broken
  return policy
}

/**
 * The row config the launcher writes for a persona (the inverse of `policyOf`).
 * @param {{id: string, tools?: {allow?: string[], deny?: string[], approval?: object}, broken?: string, source?: string}} persona
 *   a normalized persona from `scripts/lib/personas.mjs`.
 * @returns {{persona: string, allow: string[], deny: string[], approval: object, broken?: string}} the config.
 */
export function configOf(persona) {
  const out = {
    persona: persona.id,
    allow: [...(persona.tools?.allow ?? [])],
    deny: [...(persona.tools?.deny ?? [])],
    approval: { ...(persona.tools?.approval ?? {}) },
  }
  if (persona.broken !== undefined) out.broken = persona.source ?? persona.id
  return out
}

/** @param {Record<string, string>} approval @param {string} tool @returns {string|undefined} the tool's mode. */
const modeOf = (approval, tool) => Object.entries(approval).find(([t]) => sameTool(t, tool))?.[1]

/**
 * The pre-execute decision for one tool under a policy.
 * @param {Policy} policy - from `policyOf`.
 * @param {string} tool - the called tool's name.
 * @returns {{kind: 'allow'} | {kind: 'deny', reason: string} | {kind: 'ask', reason: string}} the decision,
 *   in the substrate's `PreToolDecision` shape.
 */
export function decide(policy, tool) {
  const no = why => ({ kind: 'deny', reason: `tool ${tool} is not allowed for persona ${policy.persona} (${why})` })
  if (policy.broken !== undefined && !names(READ_ONLY, tool)) {
    return no(`${policy.broken} failed to load, so only ${READ_ONLY.join(', ')} run until it is fixed`)
  }
  if (names(policy.deny, tool)) return no('denied by its tool policy')
  const mode = modeOf(policy.approval, tool)
  if (mode === 'deny') return no('its approval mode is deny')
  if (policy.allow.length > 0 && !names(policy.allow, tool)) return no(`it allows only ${policy.allow.join(', ')}`)
  if (mode === 'ask') return { kind: 'ask', reason: `tool ${tool} needs approval for persona ${policy.persona}` }
  return { kind: 'allow' }
}

/**
 * One word for listings: what `decide` would do.
 * @param {Policy} policy - from `policyOf`.
 * @param {string} tool - the tool name.
 * @returns {'allowed'|'denied'|'ask'} the verdict.
 */
export function verdict(policy, tool) {
  const d = decide(policy, tool)
  return d.kind === 'allow' ? 'allowed' : d.kind === 'ask' ? 'ask' : 'denied'
}

/** @param {Policy} policy @returns {boolean} whether the policy restricts anything. */
export const restricts = policy => policy.broken !== undefined || policy.allow.length > 0 || policy.deny.length > 0
  || Object.values(policy.approval).some(m => m !== 'allow')

/**
 * Mount: refuse forbidden calls before dispatch. An allowed call goes on to the next gate (`next()`),
 * so other policies still run; a refused one never reaches them or the tool.
 * @param {{on: Function}} ctx - registrant context.
 * @param {unknown} config - the row config (see `policyOf`).
 */
export function apply(ctx, config) {
  const policy = policyOf(config)
  if (!restricts(policy)) return
  ctx.on('tools/pre-execute', async (exec, next) => {
    const d = decide(policy, String(exec?.name ?? ''))
    return d.kind === 'allow' ? next() : d
  })
}
