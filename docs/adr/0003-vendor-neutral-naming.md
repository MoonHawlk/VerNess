# ADR-0003 — Vendor-neutral contracts, vendors only in adapters

- Status: accepted
- Date: 2026-09-25

## Context
The design draws on DeepSeek, Hermes, Claude/Anthropic patterns and Jev. Naming components after
vendors would hardcode today's market into our type system.

## Decision
Core vocabulary is capability-based: `GenerativeModel`, `DecisionModel`, `DeterministicEngine`,
`Persona`, `Skill`, `Evaluator`, `Router`, `Runtime`, `Task`, `Artifact`, `Evidence`.
Vendor names appear only under `providers/` (`providers/deepseek`, `anthropic`, `openai`, `qwen`,
`jev`, `local`) and in adapter filenames.

## Consequences
- A new decision model (Jev 2, an open-source equivalent, a classifier) is a new provider file and
  nothing else.
- Forbidden: `JevController`, `ClaudePersona`, `DeepSeekAgent`, `HermesSkill`.
- Modes are named by behavior, not by vendor: `standard | agent | decision | adaptive`.
