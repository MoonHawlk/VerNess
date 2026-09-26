import type { ArtifactRef, Evidence } from './evaluation.ts'
import type { SkillRef } from './skill.ts'

export type TaskMode = 'standard' | 'agent' | 'decision' | 'adaptive'
export type TaskStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'escalated'
export type TaskId = string
export interface TaskBudget { maxTokens?: number, maxCost?: number, maxSeconds?: number, maxIterations?: number }
export interface TaskConstraints { deniedTools?: string[], requireEvidence?: boolean, readOnly?: boolean }
export interface Step { index: number, kind: 'generate' | 'decide' | 'compute' | 'evaluate', summary: string, startedAt: string, endedAt?: string, ok?: boolean }
export interface Plan { steps: { description: string, mode: TaskMode }[] }
export interface TaskMetrics { tokensIn: number, tokensOut: number, decisions: number, toolCalls: number, seconds: number }
export interface TaskError { at: string, code: string, message: string }
export interface TaskState {
  objective: string
  plan?: Plan
  steps: Step[]
  artifacts: ArtifactRef[]
  evidence: Evidence[]
  errors: TaskError[]
  metrics: TaskMetrics
  status: TaskStatus
}
export interface Task {
  id: TaskId
  objective: string
  persona: SkillRef | { id: string }
  mode: TaskMode
  state: TaskState
  budget: TaskBudget
  constraints: TaskConstraints
}
