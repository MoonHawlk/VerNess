export interface Evidence { id: string, kind: 'tool_result' | 'query' | 'file' | 'dataset' | 'human', ref: string, excerpt?: string, at: string }
export interface ArtifactRef { id: string, kind: string, uri: string }
export interface Artifact extends ArtifactRef { title: string, bytes: number, createdAt: string, producedBy: { sessionId: string, persona: string } }
export type Verdict = 'PASS' | 'NEEDS_WORK'
export interface EvaluationResult { verdict: Verdict, score?: number, reasons: string[], evidence: Evidence[], evaluator: string }
export interface Evaluator {
  readonly id: string
  /** Evaluators never share the generator's context (law 4). They receive the objective and the evidence, not the transcript. */
  evaluate(input: { objective: string, evidence: Evidence[], artifacts: ArtifactRef[] }): Promise<EvaluationResult>
}
