import type { Issue, Result } from './issue.ts'
import { closest } from './issue.ts'

export const CAPABILITY_KEYS = ['code', 'reasoning', 'vision', 'structured_output', 'tool_calling'] as const
export type CapabilityKey = typeof CAPABILITY_KEYS[number]
export const CAPABILITY_LEVELS = ['none', 'low', 'medium', 'high'] as const
export type CapabilityLevel = typeof CAPABILITY_LEVELS[number]

/** What a model can do. `context` is its window in tokens. */
export type ModelCapabilities = Partial<Record<CapabilityKey, CapabilityLevel>> & { context?: number }
/** What a persona or task needs; same shape, read as minimums. */
export type CapabilityRequirements = ModelCapabilities

/** Rank of a capability level, `undefined` treated as `'none'`. */
export function levelRank(l: CapabilityLevel | undefined): number {
  return CAPABILITY_LEVELS.indexOf(l ?? 'none')
}

/** Every requirement the capabilities fall short of, as `key: have < need`. Empty means eligible. */
export function capabilityGaps(have: ModelCapabilities, need: CapabilityRequirements): string[] {
  const gaps: string[] = []
  for (const k of CAPABILITY_KEYS) {
    if (need[k] !== undefined && levelRank(have[k]) < levelRank(need[k])) gaps.push(`${k}: ${have[k] ?? 'none'} < ${need[k]}`)
  }
  if (need.context !== undefined && (have.context ?? 0) < need.context) gaps.push(`context: ${have.context ?? 0} < ${need.context}`)
  return gaps
}

/** Merge requirements, keeping the stricter value per key. */
export function mergeRequirements(...rs: CapabilityRequirements[]): CapabilityRequirements {
  const out: CapabilityRequirements = {}
  for (const r of rs) {
    for (const k of CAPABILITY_KEYS) {
      const v = r[k]
      if (v === undefined) continue
      const current = out[k]
      if (current === undefined || levelRank(v) > levelRank(current)) out[k] = v
    }
    if (r.context !== undefined) {
      out.context = out.context === undefined ? r.context : Math.max(out.context, r.context)
    }
  }
  return out
}

/** Validate and normalise a `ModelCapabilities`/`CapabilityRequirements` value. */
export function validateCapabilities(v: unknown, path: (string | number)[] = []): Result<ModelCapabilities> {
  const errors: Issue[] = []

  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, errors: [{ path, message: 'expected an object' }] }
  }

  const value: ModelCapabilities = {}
  for (const [key, raw] of Object.entries(v)) {
    if (key === 'context') {
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
        errors.push({ path: [...path, 'context'], message: 'expected a non-negative integer' })
        continue
      }
      value.context = raw
      continue
    }

    if ((CAPABILITY_KEYS as readonly string[]).includes(key)) {
      if (!(CAPABILITY_LEVELS as readonly string[]).includes(raw as string)) {
        errors.push({
          path: [...path, key],
          message: `expected one of "${CAPABILITY_LEVELS.join('", "')}"`,
        })
        continue
      }
      value[key as CapabilityKey] = raw as CapabilityLevel
      continue
    }

    const suggestion = closest(key, CAPABILITY_KEYS)
    const message = suggestion
      ? `unknown capability "${key}" — did you mean "${suggestion}"?`
      : `unknown capability "${key}", expected one of "${CAPABILITY_KEYS.join('", "')}"`
    errors.push({ path: [...path, key], message })
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value }
}
