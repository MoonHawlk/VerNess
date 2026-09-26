import type { Issue } from './issue.ts'
import { closest } from './issue.ts'

export type Path = (string | number)[]
export type Obj = Record<string, unknown>

export function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** An object at `path`, or `undefined` (with an issue unless the value is absent). */
export function expectObject(v: unknown, path: Path, errors: Issue[]): Obj | undefined {
  if (v === undefined) return undefined
  if (isObject(v)) return v
  errors.push({ path, message: 'expected an object' })
  return undefined
}

/** A string at `path`, or `undefined` (with an issue unless the value is absent). */
export function expectString(v: unknown, path: Path, errors: Issue[]): string | undefined {
  if (v === undefined) return undefined
  if (typeof v === 'string') return v
  errors.push({ path, message: 'expected a string' })
  return undefined
}

/**
 * A copy of an array of non-empty strings at `path`. Each bad item is its own issue at
 * `[...path, i]`; `check` may reject a string with a message. Returns `undefined` when absent or
 * when anything was wrong.
 */
export function expectStringArray(v: unknown, path: Path, errors: Issue[], check?: (s: string) => string | undefined): string[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) {
    errors.push({ path, message: 'expected an array of strings' })
    return undefined
  }
  const before = errors.length
  v.forEach((item: unknown, i) => {
    if (typeof item !== 'string' || item === '') {
      errors.push({ path: [...path, i], message: 'must be a non-empty string' })
      return
    }
    const problem = check?.(item)
    if (problem !== undefined) errors.push({ path: [...path, i], message: problem })
  })
  return errors.length === before ? [...(v as string[])] : undefined
}

/** One issue per key of `o` not in `known`, with a "did you mean" when one is close. */
export function unknownFields(o: Obj, known: readonly string[], path: Path, errors: Issue[]): void {
  for (const key of Object.keys(o)) {
    if (known.includes(key)) continue
    const suggestion = closest(key, known)
    const message = suggestion ? `unknown field "${key}" — did you mean "${suggestion}"?` : `unknown field "${key}"`
    errors.push({ path: [...path, key], message })
  }
}
