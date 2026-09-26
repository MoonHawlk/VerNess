import type { Issue, Result } from './issue.ts'
import type { SkillMetadata } from './skill.ts'
import type { Path } from './validate-helpers.ts'
import { expectObject, expectString, expectStringArray, isObject, unknownFields } from './validate-helpers.ts'

const SKILL_FIELDS = ['name', 'description', 'version', 'activation', 'requirements', 'evaluators'] as const

/** A required, non-empty string at `path`: one issue when absent, another when empty or the wrong type. */
function requireNonEmptyString(v: unknown, path: Path, errors: Issue[]): string | undefined {
  if (v === undefined) {
    errors.push({ path, message: 'required: a non-empty string' })
    return undefined
  }
  if (typeof v !== 'string') {
    errors.push({ path, message: 'expected a string' })
    return undefined
  }
  if (v === '') {
    errors.push({ path, message: 'must be a non-empty string' })
    return undefined
  }
  return v
}

function validateActivation(v: unknown, errors: Issue[]): SkillMetadata['activation'] {
  const o = expectObject(v, ['activation'], errors)
  if (o === undefined) return undefined
  unknownFields(o, ['triggers'], ['activation'], errors)
  const triggers = expectStringArray(o['triggers'], ['activation', 'triggers'], errors)
  const activation: NonNullable<SkillMetadata['activation']> = {}
  if (triggers !== undefined) activation.triggers = triggers
  return activation
}

function validateRequirements(v: unknown, errors: Issue[]): SkillMetadata['requirements'] {
  const o = expectObject(v, ['requirements'], errors)
  if (o === undefined) return undefined
  unknownFields(o, ['tools'], ['requirements'], errors)
  const tools = expectStringArray(o['tools'], ['requirements', 'tools'], errors)
  const requirements: NonNullable<SkillMetadata['requirements']> = {}
  if (tools !== undefined) requirements.tools = tools
  return requirements
}

/**
 * Validate a parsed skill metadata value (a skill's `SKILL.md`/manifest front matter) and
 * normalise it into a `SkillMetadata`. Collects all issues rather than stopping at the first;
 * on success, `value` is a fresh copy with no defaults injected and absent optional fields
 * omitted rather than set to `undefined`.
 */
export function validateSkillMetadata(v: unknown): Result<SkillMetadata> {
  if (!isObject(v)) return { ok: false, errors: [{ path: [], message: 'expected an object' }] }

  const errors: Issue[] = []
  unknownFields(v, SKILL_FIELDS, [], errors)

  const name = requireNonEmptyString(v['name'], ['name'], errors)
  const description = requireNonEmptyString(v['description'], ['description'], errors)
  const version = expectString(v['version'], ['version'], errors)
  const activation = validateActivation(v['activation'], errors)
  const requirements = validateRequirements(v['requirements'], errors)
  const evaluators = expectStringArray(v['evaluators'], ['evaluators'], errors)

  if (errors.length > 0 || name === undefined || description === undefined) return { ok: false, errors }

  const value: SkillMetadata = { name, description }
  if (version !== undefined) value.version = version
  if (activation !== undefined && Object.keys(activation).length > 0) value.activation = activation
  if (requirements !== undefined && Object.keys(requirements).length > 0) value.requirements = requirements
  if (evaluators !== undefined) value.evaluators = evaluators
  return { ok: true, value }
}
