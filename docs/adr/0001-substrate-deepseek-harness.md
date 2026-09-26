# ADR-0001 — DeepSeek Harness as the execution substrate

- Status: accepted
- Date: 2026-09-25

## Context
We need an execution harness for data-intensive, long-running, auditable AI tasks. Candidate
foundations: build a new runtime, fork Hermes, or build on the DeepSeek Harness (`dsh`)/Cordis.

## Decision
`dsh` is the execution kernel. Hermes is a *capability source* (skills, memory, routing, MCP
ideas), Anthropic's `cwc-long-running-agents` a *control-pattern source* (goal, generator/evaluator,
verification), Jev a *decision substrate* behind our own contract. None of them is a competing
runtime inside VerNess.

## Why
`dsh` already ships every seam we would otherwise build: `ctx.llm`, `ctx.tools`, `ctx.sessions`,
`ctx.agents`, `ctx.subagents`, `ctx.skills`, `ctx.goals`, `ctx.jobs`, `ctx.schedule`, sandbox,
approvals, MCP, session replay/fork, and profiles/bundles/patches for composition — with no
privileged core (`.refs/deepseek-harness/docs/architecture.md:11-13`). Re-implementing that is
months of work with no differentiation.

## Consequences
- Our differentiation must live in the capability layer, not in runtime plumbing.
- We inherit upstream's invariants (notably "model-visible means logged") and its release cadence.
- Law 1 of the project: never modify the substrate when a seam can express the behavior.
