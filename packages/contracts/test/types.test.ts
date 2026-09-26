import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { ChoiceQuestion, DecisionCapabilities, DecisionModel, DecisionRequest, DecisionResult } from '../src/decision.ts'
import type { Skill, SkillActivation, SkillContext, SkillMetadata, SkillRef } from '../src/skill.ts'
import type { Plan, Step, Task, TaskBudget, TaskConstraints, TaskError, TaskMetrics, TaskState } from '../src/task.ts'
import type { Artifact, ArtifactRef, EvaluationResult, Evaluator, Evidence } from '../src/evaluation.ts'
import { REASON_CODES } from '../src/decision.ts'

test('REASON_CODES has the 13 codes from the brief', () => {
  assert.deepEqual([...REASON_CODES], [
    'rule_match', 'model_high_confidence', 'model_low_confidence', 'fallback_rules', 'escalated',
    'tool_timeout', 'tool_error', 'budget_exceeded', 'evidence_missing', 'objective_met', 'no_progress',
    'provider_unavailable', 'invalid_answer',
  ])
  assert.equal(REASON_CODES.length, 13)
})

test('ChoiceQuestion', () => {
  const q: ChoiceQuestion<'yes' | 'no'> = { type: 'choice', instructions: 'pick one', criteria: { yes: 'do it', no: 'skip it' } }
  assert.equal(q.type, 'choice')
})

test('DecisionRequest', () => {
  const req: DecisionRequest<'yes' | 'no'> = {
    state: 'state digest',
    question: { type: 'choice', instructions: 'pick one', criteria: { yes: 'do it', no: 'skip it' } },
    key: 'pipeline',
    timeoutMs: 1000,
  }
  assert.equal(req.key, 'pipeline')
})

test('DecisionResult', () => {
  const res: DecisionResult<'yes' | 'no'> = {
    decision: 'yes',
    confidence: 0.9,
    probabilities: { yes: 0.9, no: 0.1 },
    reason_code: 'rule_match',
    provider: 'local',
    ms: 12,
  }
  assert.equal(res.decision, 'yes')
})

test('DecisionCapabilities', () => {
  const caps: DecisionCapabilities = { maxOptions: 8, batch: false, calibrated: true, local: true }
  assert.equal(caps.maxOptions, 8)
})

test('DecisionModel', () => {
  const model: DecisionModel = {
    id: 'test-model',
    capabilities: { maxOptions: 8, batch: false, calibrated: true, local: true },
    async decide<O extends string>(req: DecisionRequest<O>): Promise<DecisionResult<O>> {
      return { decision: undefined, confidence: 0, reason_code: 'no_progress', provider: this.id, ms: 0 }
    },
  }
  assert.equal(model.id, 'test-model')
})

test('SkillRef', () => {
  const ref: SkillRef = { id: 'sql', version: '1.0.0' }
  assert.equal(ref.id, 'sql')
})

test('SkillMetadata', () => {
  const meta: SkillMetadata = {
    name: 'sql',
    description: 'Writes SQL.',
    activation: { triggers: ['sql'] },
    requirements: { tools: ['bash'] },
    evaluators: ['idempotence'],
    version: '1',
  }
  assert.equal(meta.name, 'sql')
})

test('SkillContext', () => {
  const ctx: SkillContext = { personaId: 'data-eng', objective: 'profile data', availableTools: ['bash', 'read'] }
  assert.equal(ctx.personaId, 'data-eng')
})

test('SkillActivation', () => {
  const activation: SkillActivation = {
    promptSections: [{ title: 'Overview', body: 'Do the thing.' }],
    tools: ['bash'],
    evaluators: ['idempotence'],
    references: ['sql/reference.md'],
  }
  assert.equal(activation.promptSections.length, 1)
})

test('Skill', () => {
  const skill: Skill = {
    id: 'sql',
    version: '1.0.0',
    metadata: { name: 'sql', description: 'Writes SQL.' },
    async activate(_ctx: SkillContext): Promise<SkillActivation> {
      return { promptSections: [], tools: [], evaluators: [], references: [] }
    },
  }
  assert.equal(skill.id, 'sql')
})

test('Task, TaskState, Step, Plan, TaskBudget, TaskConstraints, TaskMetrics, TaskError', () => {
  const step: Step = { index: 0, kind: 'generate', summary: 'draft', startedAt: '2026-01-01T00:00:00Z' }
  const plan: Plan = { steps: [{ description: 'draft', mode: 'standard' }] }
  const budget: TaskBudget = { maxTokens: 1000, maxCost: 1, maxSeconds: 60, maxIterations: 5 }
  const constraints: TaskConstraints = { deniedTools: ['net'], requireEvidence: true, readOnly: false }
  const metrics: TaskMetrics = { tokensIn: 1, tokensOut: 2, decisions: 0, toolCalls: 0, seconds: 1 }
  const taskError: TaskError = { at: '2026-01-01T00:00:00Z', code: 'E_TIMEOUT', message: 'timed out' }
  const state: TaskState = {
    objective: 'do the thing',
    plan,
    steps: [step],
    artifacts: [],
    evidence: [],
    errors: [taskError],
    metrics,
    status: 'running',
  }
  const task: Task = {
    id: 'task-1',
    objective: 'do the thing',
    persona: { id: 'data-eng' },
    mode: 'standard',
    state,
    budget,
    constraints,
  }
  assert.equal(task.id, 'task-1')
})

test('Evidence, ArtifactRef, Artifact, EvaluationResult, Evaluator', () => {
  const evidence: Evidence = { id: 'e1', kind: 'tool_result', ref: 'bash:1', excerpt: 'ok', at: '2026-01-01T00:00:00Z' }
  const artifactRef: ArtifactRef = { id: 'a1', kind: 'file', uri: 'file:///tmp/out.csv' }
  const artifact: Artifact = {
    ...artifactRef,
    title: 'Output',
    bytes: 123,
    createdAt: '2026-01-01T00:00:00Z',
    producedBy: { sessionId: 's1', persona: 'data-eng' },
  }
  const result: EvaluationResult = { verdict: 'PASS', score: 1, reasons: ['looks right'], evidence: [evidence], evaluator: 'idempotence' }
  const evaluator: Evaluator = {
    id: 'idempotence',
    async evaluate(input: { objective: string, evidence: Evidence[], artifacts: ArtifactRef[] }): Promise<EvaluationResult> {
      return { verdict: 'PASS', reasons: [], evidence: input.evidence, evaluator: this.id }
    },
  }
  assert.equal(evidence.id, 'e1')
  assert.equal(artifactRef.id, 'a1')
  assert.equal(artifact.title, 'Output')
  assert.equal(result.verdict, 'PASS')
  assert.equal(evaluator.id, 'idempotence')
})
