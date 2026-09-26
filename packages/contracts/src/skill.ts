/** A reference to a skill by id, optionally pinned to a version. */
export interface SkillRef { id: string, version?: string }

/** A skill's declared metadata (a file-authored contract, validated by `validateSkillMetadata`). */
export interface SkillMetadata {
  name: string
  description: string
  activation?: { triggers?: string[] }
  requirements?: { tools?: string[] }
  evaluators?: string[]
  version?: string
}

export interface SkillContext { personaId: string, objective: string, availableTools: string[] }

export interface SkillActivation {
  promptSections: { title: string, body: string }[]
  tools: string[]
  evaluators: string[]
  references: string[]      // paths the model may open on demand (3-tier disclosure)
}

export interface Skill {
  readonly id: string
  readonly version: string
  readonly metadata: SkillMetadata
  activate(ctx: SkillContext): Promise<SkillActivation>
}
