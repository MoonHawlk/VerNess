import type { ModelCapabilities } from './capabilities.ts'
import type { Issue, Result } from './issue.ts'
import type { ApprovalMode, DecisionPolicy, MemoryScope, ModelPolicy, Persona, PersonaFile } from './persona.ts'
import type { Path } from './validate-helpers.ts'
import { validateCapabilities } from './capabilities.ts'
import { APPROVAL_MODES, MEMORY_SCOPES, PERSONA_FIELDS } from './persona.ts'
import { expectObject, expectString, expectStringArray, isObject, unknownFields } from './validate-helpers.ts'

const ID_PATTERN = /^[a-z][a-z0-9-]*$/

function oneOf(values: readonly string[]): string {
  return `expected one of "${values.join('", "')}"`
}

function checkCommand(s: string): string | undefined {
  if (s.startsWith('/') && ID_PATTERN.test(s.slice(1))) return `"${s}" — drop the leading slash: "${s.slice(1)}"`
  if (!ID_PATTERN.test(s)) return `"${s}" must match ${ID_PATTERN.source}`
  return undefined
}

function validateId(v: unknown, expectedId: string | undefined, errors: Issue[]): string | undefined {
  if (v === undefined) {
    errors.push({ path: ['id'], message: `required: a string matching ${ID_PATTERN.source}` })
    return undefined
  }
  const id = expectString(v, ['id'], errors)
  if (id === undefined) return undefined
  const before = errors.length
  if (!ID_PATTERN.test(id)) errors.push({ path: ['id'], message: `"${id}" must match ${ID_PATTERN.source}` })
  if (expectedId !== undefined && id !== expectedId) {
    errors.push({ path: ['id'], message: `id "${id}" does not match the file name "${expectedId}"` })
  }
  return errors.length === before ? id : undefined
}

function validateModel(v: unknown, errors: Issue[]): ModelPolicy['preferred'] {
  const o = expectObject(v, ['model'], errors)
  if (o === undefined) return undefined
  unknownFields(o, ['id', 'route'], ['model'], errors)
  const id = expectString(o['id'], ['model', 'id'], errors)
  const route = expectString(o['route'], ['model', 'route'], errors)
  if (id === undefined && route === undefined) return undefined
  const preferred: NonNullable<ModelPolicy['preferred']> = {}
  if (id !== undefined) preferred.id = id
  if (route !== undefined) preferred.route = route
  return preferred
}

function validateRequirements(v: unknown, errors: Issue[]): ModelCapabilities {
  const o = expectObject(v, ['models'], errors)
  if (o === undefined) return {}
  unknownFields(o, ['requirements'], ['models'], errors)
  if (o['requirements'] === undefined) return {}
  const r = validateCapabilities(o['requirements'], ['models', 'requirements'])
  if (!r.ok) {
    errors.push(...r.errors)
    return {}
  }
  return r.value
}

function validateTools(v: unknown, errors: Issue[]): Persona['tools'] {
  const tools: Persona['tools'] = { allow: [], deny: [], approval: {} }
  const o = expectObject(v, ['tools'], errors)
  if (o === undefined) return tools
  unknownFields(o, ['allow', 'deny', 'approval'], ['tools'], errors)
  tools.allow = expectStringArray(o['allow'], ['tools', 'allow'], errors) ?? []
  tools.deny = expectStringArray(o['deny'], ['tools', 'deny'], errors) ?? []

  const allow = o['allow']
  const deny = o['deny']
  if (Array.isArray(allow) && Array.isArray(deny)) {
    deny.forEach((name: unknown, i) => {
      if (typeof name === 'string' && name !== '' && allow.includes(name)) {
        errors.push({ path: ['tools', 'deny', i], message: `"${name}" is both allowed and denied` })
      }
    })
  }

  const approval = expectObject(o['approval'], ['tools', 'approval'], errors)
  for (const [tool, mode] of Object.entries(approval ?? {})) {
    if (!(APPROVAL_MODES as readonly unknown[]).includes(mode)) {
      errors.push({ path: ['tools', 'approval', tool], message: oneOf(APPROVAL_MODES) })
      continue
    }
    tools.approval[tool] = mode as ApprovalMode
  }
  return tools
}

function validateMemory(v: unknown, errors: Issue[]): MemoryScope {
  const o = expectObject(v, ['memory'], errors)
  if (o === undefined) return 'session'
  unknownFields(o, ['scope'], ['memory'], errors)
  const scope = o['scope']
  if (scope === undefined) return 'session'
  if (!(MEMORY_SCOPES as readonly unknown[]).includes(scope)) {
    errors.push({ path: ['memory', 'scope'], message: oneOf(MEMORY_SCOPES) })
    return 'session'
  }
  return scope as MemoryScope
}

function validateDecisions(v: unknown, errors: Issue[]): DecisionPolicy {
  const policy: DecisionPolicy = { apply: {} }
  const o = expectObject(v, ['decisions'], errors)
  if (o === undefined) return policy
  unknownFields(o, ['provider', 'apply'], ['decisions'], errors)
  const provider = expectString(o['provider'], ['decisions', 'provider'], errors)
  if (provider !== undefined) policy.provider = provider
  const apply = expectObject(o['apply'], ['decisions', 'apply'], errors)
  for (const [key, on] of Object.entries(apply ?? {})) {
    if (typeof on !== 'boolean') {
      errors.push({ path: ['decisions', 'apply', key], message: 'expected a boolean' })
      continue
    }
    policy.apply[key] = on
  }
  return policy
}

/**
 * Validate a parsed `personas/<id>.json` file and normalise it into a `Persona`, applying every
 * default. Collects all issues rather than stopping at the first.
 * @param v - the parsed file contents.
 * @param opts.expectedId - the file's base name; `id` must equal it when given.
 */
export function validatePersonaFile(v: unknown, opts: { expectedId?: string } = {}): Result<Persona> {
  if (!isObject(v)) return { ok: false, errors: [{ path: [], message: 'expected an object' }] }

  const errors: Issue[] = []
  unknownFields(v, PERSONA_FIELDS, [], errors)

  const id = validateId(v['id'], opts.expectedId, errors)
  expectString(v['$schema'], ['$schema'], errors)
  const version = expectString(v['version'], ['version'], errors) ?? '1'
  const name = expectString(v['name'], ['name'], errors)
  const description = expectString(v['description'], ['description'], errors) ?? ''

  const prompt = { prefix: '', suffix: '' }
  const promptObj = expectObject(v['prompt'], ['prompt'], errors)
  if (promptObj !== undefined) {
    unknownFields(promptObj, ['prefix', 'suffix'], ['prompt'], errors)
    prompt.prefix = expectString(promptObj['prefix'], ['prompt', 'prefix'], errors) ?? ''
    prompt.suffix = expectString(promptObj['suffix'], ['prompt', 'suffix'], errors) ?? ''
  }

  const modelPolicy: ModelPolicy = { requirements: validateRequirements(v['models'], errors) }
  const preferred = validateModel(v['model'], errors)
  if (preferred !== undefined) modelPolicy.preferred = preferred

  const tools = validateTools(v['tools'], errors)
  const skills = expectStringArray(v['skills'], ['skills'], errors) ?? []
  const evaluators = expectStringArray(v['evaluators'], ['evaluators'], errors) ?? []
  const tips = expectStringArray(v['tips'], ['tips'], errors) ?? []
  const commands = expectStringArray(v['commands'], ['commands'], errors, checkCommand) ?? []
  const scope = validateMemory(v['memory'], errors)
  const decisionPolicy = validateDecisions(v['decisions'], errors)

  if (errors.length > 0 || id === undefined) return { ok: false, errors }
  return {
    ok: true,
    value: {
      id,
      version,
      identity: { name: name ?? id, description },
      prompt,
      modelPolicy,
      decisionPolicy,
      skills,
      tools,
      memory: { scope },
      evaluation: { evaluators },
      security: { deny: [...tools.deny] },
      tips,
      commands,
    },
  }
}

/**
 * Turn a normalised `Persona` back into a persona file that re-validates to an equal `Persona`.
 * Defaults are written out explicitly; `security.deny` is not a file field (it mirrors `tools.deny`).
 * @param p - a persona built by `validatePersonaFile`.
 */
export function personaToFile(p: Persona): PersonaFile {
  const file: PersonaFile = {
    id: p.id,
    version: p.version,
    name: p.identity.name,
    description: p.identity.description,
    prompt: { ...p.prompt },
    models: { requirements: { ...p.modelPolicy.requirements } },
    tools: { allow: [...p.tools.allow], deny: [...p.tools.deny], approval: { ...p.tools.approval } },
    skills: [...p.skills],
    evaluators: [...p.evaluation.evaluators],
    tips: [...p.tips],
    commands: [...p.commands],
    memory: { scope: p.memory.scope },
    decisions: { apply: { ...p.decisionPolicy.apply } },
  }
  if (p.modelPolicy.preferred !== undefined) file.model = { ...p.modelPolicy.preferred }
  if (p.decisionPolicy.provider !== undefined) file.decisions = { provider: p.decisionPolicy.provider, apply: { ...p.decisionPolicy.apply } }
  return file
}
