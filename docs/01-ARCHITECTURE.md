# 01 — Architecture

## Layer model

```
        VerNess capability layer  (our code, all Cordis plugins)
   personas · skills · decisions · routing · supervisor · evaluation · governance · data
        ───────────────────────────────────────────────────────────────────────────
        DeepSeek Harness (dsh)  — agent loop, tools, sessions, sandbox, approvals,
                                  goals, jobs, schedule, MCP, subagents, web/SDK/ACP
        ───────────────────────────────────────────────────────────────────────────
        Cordis  — plugin container, typed services (`ctx.*`), typed events, fibers/HMR
```

Capability sources: **Hermes** → skills/memory/routing/MCP ideas (adapters, not code);
**Anthropic cwc-long-running-agents** → goal/evaluator/verification control patterns;
**Jev / TypeSafe** → decision substrate behind our own `DecisionModel` contract.

## Contract → substrate seam map

Every VerNess subsystem attaches through a documented seam. No agent-loop edits.

| VerNess subsystem | `ctx` surface | Attaches via | Upstream anchor |
|---|---|---|---|
| Personas | `ctx.personas` (new Service) | `system-prompt/assemble` (waterfall), agent presets | `packages/core/system-prompt/src/index.ts:31`; `packages/preset/agent-preset-registry` |
| Tool policy (persona allow/deny/approval) | — | `tools/pre-execute` (waterfall, return without `next()` = deny/ask) + `ctx.tools.guard()` + `ctx.approval` | `packages/core/tools/src/index.ts:153`; `docs/tool-execution-pipeline.md` |
| Skills | `ctx.skills.registerProvider(create)` (**existing**) | provider returning `SkillCandidate[]` | `packages/skill/skill/src/index.ts:390,247-259` |
| Decisions | `ctx.decisions` (new Service) | called by our own plugins; exposed as tool `decision.evaluate` | `docs/cookbook/adding-a-tool.md` |
| Model routing | `ctx.modelRouter` (new Service) | `agent/request` (waterfall — route/capability negotiation before prompt commit) | `packages/core/agent/src/runtime-types.ts:337` |
| Generative providers | `ctx.llm.registerAdapter([...])` (**existing**) | `LlmAdapter` subclass per provider | `packages/llm/llm-deepseek`, `docs/cookbook/adding-an-llm-adapter.md` |
| Supervisor / modes | `ctx.supervisor` (new Service) | `agent/pre-step` (waterfall) + `agent/turn-stopping` (serial, no `next()`) | `runtime-types.ts:320,381` |
| Evaluation | `ctx.evaluators` (new Service) | listens `goal/changed`, `session/event`; runs an evaluator **subagent** via `ctx.subagents` | `packages/goal/goal/src/index.ts:258`; `packages/subagent/subagent/src/index.ts:512` |
| Goal runtime | `ctx.goals` (**existing**) | do not reinvent; add continuation policy plugin beside `goal-round-driver` | `packages/goal/goal` |
| Artifacts / evidence | `ctx.artifacts` (new Service) | new `SessionEvent` + `ctx.sessionProjections.register(...)` | `docs/architecture.md:125` ("model-visible means logged") |
| Governance | `ctx.governance` (new Service) | `tools/pre-execute`, `fs/write-intent`, `fs/edit-intent`, `approval/request`, `ctx.invariants.register` | `packages/fs/fs/src/index.ts:59,67`; `packages/interaction/user-approval/src/types.ts:87` |
| Data plane | `ctx.dataEngines` (new Service) | tools (`sql.query`, `data.profile`, …) + `ctx.jobs.start()` for long scans | `packages/jobs/jobs/src/index.ts:49` |
| Budgets / cost | part of `ctx.governance` | `tools/execute` (around-dispatch), `llm/stream` (waterfall) | `packages/llm/llm/src/index.ts:75` |

## Core contracts (types first, runtime later)

```ts
interface DecisionModel { readonly id: string; readonly capabilities: DecisionCapabilities
  decide<T>(req: DecisionRequest<T>): Promise<DecisionResult<T>> }         // continue|retry|complete|escalate + confidence + reason_code

interface GenerativeModel { readonly id: string; readonly capabilities: ModelCapabilities
  generate(req: ModelRequest, cx: ModelContext): Promise<ModelResponse> }  // implemented by dsh LlmAdapter, adapted

interface Skill { readonly id: string; readonly version: string
  activate(cx: SkillContext): Promise<SkillActivation> }                   // contributes prompt sections, tools, evaluators, examples

interface Persona { readonly id: string; readonly version: string; identity: PersonaIdentity
  modelPolicy: ModelPolicy; decisionPolicy: DecisionPolicy; skills: SkillRef[]
  tools: ToolPolicy; memory: MemoryPolicy; evaluation: EvaluationPolicy; security: SecurityPolicy }

interface Task { id: TaskId; objective: string; persona: PersonaRef
  mode: 'standard' | 'agent' | 'decision' | 'adaptive'
  state: TaskState; budget: TaskBudget; constraints: TaskConstraints }
```

**Tool is NOT redefined.** We use `ctx.tools` / `defineTool` from `dsh` as-is.
**Task state is NOT a second source of truth** — it projects from the session log.

## The adaptive pipeline (law 3 made concrete)

```
objective → planner → deterministic reduction (SQL/Polars/Spark)
          → decision model (rank/filter/route)  → generative model (investigate/synthesize)
          → evaluator (independent) → decision model (complete | retry | escalate)
          → artifacts + evidence + audit
```

Example budget shape for 500M rows: `500M → SQL → 100M → stats → 100k → decision model → 5k
→ LLM → 50 investigations → evaluator → report`.

## Repository topology (see ADR-0002)

```
VerNess/
├── upstream/deepseek-harness/     # git submodule, pinned, READ-ONLY (never edited)
├── packages/                      # our plugins, npm scope @verness/*
│   ├── contracts/  decisions/  personas/  skills/  routing/
│   ├── supervisor/ evaluation/ governance/ data/
├── profiles/verness/              # cordis.patch.yml + package.json (the composed profile)
├── personas/                      # persona JSON/JSONC definitions (+ <id>/commands/*.mjs)
├── skills/                        # SKILL.md trees
└── docs/                          # this plan
```

Our packages depend on `@deepseek-ai/cordis` (published, 4.0.x) and declare
`peerDependencies` on the `@deepseek-ai/dsh-*` packages (published, 0.1.x-rc) — the runtime
refuses a plugin whose peer range does not match the running `dsh` version, so the pinned
submodule tag and the npm range must be kept in lockstep (see `docs/research/deepseek-harness-digest.md` §4.3).
