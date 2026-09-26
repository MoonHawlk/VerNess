import type { CapabilityRequirements } from './capabilities.ts'

/** How a tool call is gated: run freely, ask the human first, or refuse. */
export type ApprovalMode = 'allow' | 'ask' | 'deny'
export const APPROVAL_MODES = ['allow', 'ask', 'deny'] as const

/** Where a persona's memory lives. */
export type MemoryScope = 'none' | 'session' | 'project'
export const MEMORY_SCOPES = ['none', 'session', 'project'] as const

/** Exactly what a `personas/<id>.json` file may contain (v2). Every field but `id` is optional. */
export interface PersonaFile {
  $schema?: string
  id: string
  version?: string                                   // semver-ish, default '1'
  name?: string
  description?: string
  prompt?: { prefix?: string, suffix?: string }
  model?: { id?: string, route?: string }            // explicit preference, enforced today
  models?: { requirements?: CapabilityRequirements } // for the capability router (T-253)
  tools?: { allow?: string[], deny?: string[], approval?: Record<string, ApprovalMode> }
  skills?: string[]
  evaluators?: string[]
  tips?: string[]
  commands?: string[]                                // names of persona-scoped commands, e.g. "profile-data"
  memory?: { scope?: MemoryScope }
  decisions?: { provider?: string, apply?: Record<string, boolean> }
}

export interface PersonaIdentity { name: string, description: string }
export interface ModelPolicy { preferred?: { id?: string, route?: string }, requirements: CapabilityRequirements }
export interface DecisionPolicy { provider?: string, apply: Record<string, boolean> }
export interface ToolPolicy { allow: string[], deny: string[], approval: Record<string, ApprovalMode> }
export interface MemoryPolicy { scope: MemoryScope }
export interface EvaluationPolicy { evaluators: string[] }
export interface SecurityPolicy { deny: string[] }   // mirrors tools.deny for M9 governance

/** The normalised persona every consumer reads. Built only by `validatePersonaFile`. */
export interface Persona {
  readonly id: string
  readonly version: string
  identity: PersonaIdentity
  prompt: { prefix: string, suffix: string }
  modelPolicy: ModelPolicy
  decisionPolicy: DecisionPolicy
  skills: string[]
  tools: ToolPolicy
  memory: MemoryPolicy
  evaluation: EvaluationPolicy
  security: SecurityPolicy
  tips: string[]
  commands: string[]
}

/** Every top-level field a persona file may carry, in canonical order. */
export const PERSONA_FIELDS = ['$schema', 'id', 'version', 'name', 'description', 'prompt', 'model', 'models', 'tools', 'skills', 'evaluators', 'tips', 'commands', 'memory', 'decisions'] as const
