/**
 * Persona tool policy, enforced (T-042). The active persona's `tools: {allow, deny, approval}` reaches
 * this plugin as its row config (the launcher writes it into the profile patch and every per-run
 * persona overlay). Each agent's scoped `ctx.tools.restrict()` hides what the policy denies, so the
 * request never carries those schemas (T-234), and a `tools/pre-execute` listener refuses a forbidden
 * call with a reason the model reads in the tool result (the backstop).
 *
 * Semantics: deny wins; a non-empty allow list blocks everything not in it; `approval[tool]: 'ask'`
 * asks once through the substrate's approval seam (no approval channel = refused); an empty or absent
 * policy is unrestricted; harness tools (planning, goals, jobs) pass an allow list (`HARNESS`), and
 * capability names such as `web.fetch` match their substrate tools (`ALIASES`). A persona file that
 * failed to load arrives as `broken` and fails closed:
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

/**
 * Persona files name some tools by capability (`web.fetch`, `shell.execute`); these are the
 * substrate tools each one means. A capability with no substrate tool yet (`sql.query`,
 * `production.write`, ...) matches nothing until a plugin provides it.
 */
export const ALIASES = {
  'web.fetch': ['web_fetch'],
  'web.search': ['web_search'],
  'shell.execute': ['bash', 'pwsh'],
  'python.execute': ['bash', 'pwsh'],
  'artifact.create': ['write'],
}

/**
 * Harness tools an allow list never blocks: they plan, track or read, and change nothing outside
 * the session. Naming one in `deny` still blocks it. Tools that hand work to another agent
 * (`subagent`, `workflow`, ...) are not here: a subagent can write.
 */
export const HARNESS = ['todo_write', 'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode', 'job_list', 'job_output', 'job_kill', 'read_image', 'skill', 'list_agents']

/** @param {string} n @returns {string[]} the substrate tool names a policy entry stands for. */
const expand = n => ALIASES[n] ?? [n]

/**
 * @param {string} entry - a name from a policy (substrate name or capability alias).
 * @param {string} tool - the called substrate tool.
 * @returns {boolean} whether the entry covers the tool.
 */
export const sameTool = (entry, tool) => expand(entry).some(a => a === tool || (SHELL.has(a) && SHELL.has(tool)))

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
  if (policy.allow.length > 0 && !names(policy.allow, tool) && !HARNESS.includes(tool)) return no(`it allows only ${policy.allow.join(', ')}`)
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

/** The substrate's PTC transport: `tools.restrict()` refuses to name it. */
const RUN_CODE = 'run_code'

/**
 * The `ctx.tools.restrict()` filter that hides what `decide` would deny (T-234). Always a concrete
 * `deny` list, never `allow`: the substrate's allow hides everything unlisted (harness and `ask`
 * tools too) and knows neither ALIASES nor that bash and pwsh are one shell. `ask` tools stay offered.
 * Also the MCP filtering primitive: pass `{allow, deny}` over `mcp__<server>__<tool>` names.
 * @param {Policy|{allow?: string[], deny?: string[]}} policy - a policy, or a bare allow/deny filter.
 * @param {Iterable<string>} names - the tool names offered now (e.g. `ctx.tools.schemas(agent)`).
 * @returns {{deny: string[]}|undefined} the filter, or undefined when nothing is hidden
 *   (`restrict({})` throws).
 */
export function restrictionFor(policy, names) {
  const p = 'persona' in policy && 'approval' in policy ? /** @type {Policy} */ (policy) : policyOf(policy)
  const deny = [...new Set(names)].filter(n => n !== RUN_CODE && decide(p, n).kind === 'deny')
  return deny.length > 0 ? { deny } : undefined
}

/**
 * Hide denied tools from one agent's requests. Masks are per name, so one name the substrate refuses
 * (own-scope or unknown) costs only that name; reruns add only new names.
 * @param {object} ctx - the plugin context (`tools.schemas`, `logger`).
 * @param {Policy} policy - from `policyOf`.
 * @param {{ctx: {tools: {restrict: Function}}}} agent - the agent; its `ctx` is the scoped context.
 * @param {Set<string>} masked - names already hidden (or refused) for this agent.
 */
function mask(ctx, policy, agent, masked) {
  const offered = ctx.tools.schemas(agent).map(s => String(s.name))
  const filter = restrictionFor(policy, offered.filter(n => !masked.has(n)))
  for (const name of filter?.deny ?? []) {
    masked.add(name)
    try { agent.ctx.tools.restrict({ deny: [name] }) }
    catch (e) { ctx.logger?.warn?.(`tool-policy: cannot hide ${name} (still refused when called): ${e?.message ?? e}`) }
  }
}

/**
 * Mount: hide forbidden tools from every agent's requests (`tools.restrict`), and refuse forbidden
 * calls before dispatch as the backstop. An allowed call goes on to the next gate (`next()`), so other
 * policies still run; a refused one never reaches them or the tool.
 * @param {{on: Function, tools?: object, agents?: object, logger?: object}} ctx - registrant context.
 * @param {unknown} config - the row config (see `policyOf`).
 */
export function apply(ctx, config) {
  const policy = policyOf(config)
  if (!restricts(policy)) return
  ctx.on('tools/pre-execute', async (exec, next) => {
    const d = decide(policy, String(exec?.name ?? ''))
    return d.kind === 'allow' ? next() : d
  })
  if (typeof ctx.tools?.schemas !== 'function') return
  /** @type {Map<object, Set<string>>} */
  const agents = new Map()
  let busy = false
  // restrict() emits tools/change itself; the flag stops that rerun from recursing.
  const run = list => {
    if (busy) return
    busy = true
    try {
      for (const agent of list) {
        if (typeof agent?.ctx?.tools?.restrict !== 'function') continue
        if (!agents.has(agent)) agents.set(agent, new Set())
        mask(ctx, policy, agent, agents.get(agent))
      }
    } finally { busy = false }
  }
  run(ctx.agents?.list?.() ?? [])
  ctx.on('agent/created', ({ agent }) => run([agent]))
  ctx.on('agent/disposed', ({ agent }) => { agents.delete(agent) })
  ctx.on('tools/change', () => run([...agents.keys()]))
}
