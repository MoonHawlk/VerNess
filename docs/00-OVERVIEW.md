# 00 — Overview

## What we are building

> **VerNess: a task-execution operating system for AI, in which an LLM is only one class of
> compute resource — alongside decision models (Jev-like) and deterministic engines (SQL,
> Python, Spark).**

The substrate is the DeepSeek Harness (`dsh`) on Cordis. VerNess adds seven subsystems that
`dsh` deliberately does not own:

1. **Personas** — executable identity = skills + tools + model policy + decision policy + memory + evaluators + security policy.
2. **Skills** — portable *procedural* knowledge (vs. tools, which *do* things).
3. **Decisions** — a `DecisionModel` contract (rules / small model / Jev / LLM) for classify, route, score, retry, stop, escalate.
4. **Routing** — capability-based selection of generative model, decision model and data engine.
5. **Evaluation** — generator ≠ evaluator; independent verification of task success.
6. **Governance** — permissions, budgets, approvals, audit, PII/model/tool policy.
7. **Data plane** — push volume to SQL/DuckDB/Polars/Spark, never through the LLM.

## The five laws of this project

1. **Never modify the substrate when a plugin seam can express the behavior.** Core edits are an
   ADR-level exception, not a technique. (`docs/architecture.md:11-13` upstream: there is no
   privileged core — every subsystem is already a plugin behind a `ctx.*` key.)
2. **Vendor names live only in adapters.** Contracts are `DecisionModel`, `GenerativeModel`,
   `Persona`, `Skill`, `Evaluator`, `Router` — never `JevController` or `ClaudePersona`.
3. **Cheapest reliable computation first.** Reduce the decision space deterministically, then with
   a decision model, and only then invoke expensive generative intelligence.
4. **Generator ≠ evaluator.** A component never certifies its own output.
5. **Auditable by construction.** Every result carries artifacts, evidence, cost and evaluation
   scores; model-visible state is logged as session events (upstream invariant: "model-visible
   means logged").

## Scope of v0.1 (the MVP we actually build)

`Persona` + `Skill` + `DecisionModel` + `ModelRouter` + `Evaluator` + `adaptive` mode, with three
model classes wired: a generative provider already in `dsh`, a `RuleDecisionProvider`, and a
`JevProvider` stub behind the same interface.

## Non-goals (v0.x)

- Re-implementing sessions, sandbox, approvals, MCP, jobs, subagents, web UI — all inherited.
- A new agent loop, a new tool abstraction, or a second source of truth for state.
- Multi-tenant SaaS, billing, or a UI of our own.
