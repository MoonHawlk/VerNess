# 03 — Backlog

Task IDs are stable and never reused. Check a box only when its exit condition is verified.
Keep one commit per task (or per small group), and log it in `04-PROGRESS.md`.

## M0 — Foundation
- [x] T-001 Clone reference repos (deepseek-harness, hermes-agent, cwc-long-running-agents) into `.refs/` (gitignored)
- [x] T-002 Write research digests (`docs/research/*.md`)
- [x] T-003 Write plan docs (00–05) and ADRs 0001–0003
- [x] T-004 `.gitignore` (`.refs/`, `node_modules/`, build output, `.env`)
- [x] T-005 Add `upstream/deepseek-harness` as a pinned git submodule (read-only) — pinned at tag `dsh-v0.1.7-rc.2` (`477b4f4`), `shallow = true`
- [x] T-006 Target version decided: `dsh@0.1.7-rc.2` (published on npm, identical to the submodule pin); `@deepseek-ai/cordis@4.0.4` — see `04-PROGRESS.md`
- [x] T-007 Root `package.json` + `pnpm-workspace.yaml` (pnpm 11.7.0, Node >=22.19) — workspace only, no code yet (no install run)
- [x] T-008 `docs/RUNBOOK.md` skeleton written with `VERIFY` markers — M1 turns it into a tested recipe

## M1 — Load-bearing spike
- [x] T-010 `@deepseek-ai/dsh@0.1.7-rc.2` installed globally; `DSH_HOME = C:/Users/totov/.dsh`; pnpm 11.7.0 installed via npm (corepack needs admin)
- [x] T-011 Baseline captured: `docs/research/dump-config.headless.txt` (376 rows; headless is our target surface)
- [x] T-012 `packages/spike/` — plain-ESM plugin (`name`, `inject=['tools']`, `apply`) registering `verness_ping` + mount/dispose markers
- [x] T-013 `profiles/verness/cordis.patch.yml` (`insert:` row `@verness/spike`) + `scripts/profile-sync.mjs` (`npm run profile:sync`)
- [x] T-014 Row appears in `--dump-config`; a boot writes `mounted`/`disposed` markers and registers the tool with no activation warning. Calling it in a live session still needs `DEEPSEEK_API_KEY` (owner-supplied)
- [x] T-015 Peer gate passes with exact pins (`@deepseek-ai/cordis@4.0.4`, `@deepseek-ai/dsh-tools@0.1.7-rc.2`); no `compatibility.json` exemption needed
- [x] T-016 `docs/RUNBOOK.md` rewritten as a verified recipe. **Spike succeeded — ADR-0002 confirmed, no fallback needed.**
- [x] T-017 Local-model baseline (ADR-0004): Ollama `qwen3:0.6b` wired as the hand-declared pi-ai route `ollama-local`; `agent-default-model` repointed at it
- [x] T-018 End-to-end verified on the local model: the agent calls `verness_ping` and renders its output — no API cost, no credentials
- [x] T-019 Fixed the duplicate-substrate-copy fault (`Cannot read properties of undefined (reading 'prepare')`): substrate packages must be `link:`ed to the runtime's own copy, never `add`ed as a second copy

## M2 — Contracts
- [ ] T-020 `packages/contracts/` package skeleton (type-only, `@deepseek-ai/cordis` peer)
- [ ] T-021 `DecisionModel`, `DecisionRequest`, `DecisionResult`, `DecisionCapabilities`, `reason_code` enum
- [ ] T-022 `Persona`, `PersonaIdentity`, `ModelPolicy`, `DecisionPolicy`, `ToolPolicy`, `MemoryPolicy`, `SecurityPolicy`, `EvaluationPolicy`
- [ ] T-023 `Skill`, `SkillContext`, `SkillActivation`, `SkillRef`
- [ ] T-024 `Task`, `TaskState`, `Step`, `Plan`, `TaskBudget`, `TaskConstraints`, `TaskMetrics`
- [ ] T-025 `Evaluator`, `EvaluationResult`, `Artifact`, `ArtifactRef`, `Evidence`
- [ ] T-026 `ModelCapabilities` + capability vocabulary (`code`, `reasoning`, `vision`, `structured_output`, `tool_calling`, `context`)
- [ ] T-027 schemastery schemas + round-trip tests for every YAML-authored contract

## M3 — Decisions
- [ ] T-030 `packages/decisions/` skeleton; `ctx.decisions` Service + `declare module` augmentation
- [ ] T-031 `RuleDecisionProvider` (declarative rules, no network)
- [ ] T-032 `LlmDecisionProvider` (structured output through `ctx.llm`)
- [ ] T-033 `CompositeDecisionModel` (rules → decision → LLM, confidence thresholds, cost accounting)
- [ ] T-034 `JevProvider` stub behind the same interface (no API dependency yet)
- [ ] T-035 `DecisionRouter` + `DecisionPolicy` resolution
- [ ] T-036 Tool `decision.evaluate`
- [ ] T-037 Tests: unit per provider, composite fallthrough, HMR-safety (dispose → clean), 100%-per-file coverage on `src`

## M4 — Personas
- [ ] T-040 `packages/personas/` skeleton; loader (YAML) + registry + validation errors with file/line
- [ ] T-041 `system-prompt/assemble` contribution (identity + persona sections)
- [ ] T-042 Tool policy enforcement on `tools/pre-execute` (allow/deny/ask) + `ctx.approval` wiring
- [ ] T-043 `personas/data-analyst.yaml`, `personas/data-scientist.yaml`
- [ ] T-044 Tests incl. one REAL-composition boot test (per upstream `docs/testing.md:38-40`)

## M5 — Skills
- [ ] T-050 `packages/skills/` skeleton; `SKILL.md` front-matter + `metadata.yaml` spec doc
- [ ] T-051 Filesystem loader + trigger matching + 3-tier progressive disclosure
- [ ] T-052 `ctx.skills.registerProvider` bridge (`SkillCandidate[]`)
- [ ] T-053 Skills: `statistics`, `sql`, `evidence`
- [ ] T-054 Cross-check: skill required-tools vs persona tool policy

## M6 — Routing
- [ ] T-060 `packages/routing/` skeleton; model capability registry
- [ ] T-061 `ModelRouter` resolution algorithm + cost/latency/policy tie-breaks
- [ ] T-062 Hook on `agent/request`; log the routing decision as an event
- [ ] T-063 Tests: eligibility, pinning, fallback on provider error (`agent/request-error`)

## M7 — Evaluation & goal loop
- [ ] T-070 `packages/evaluation/` skeleton; `ctx.evaluators` registry
- [ ] T-071 Evaluator subagent (fresh context, read-only tools, `PASS`/`NEEDS_WORK` first line)
- [ ] T-072 Evidence gate (default-fail) on `tools/pre-execute`
- [ ] T-073 `packages/supervisor/`: modes `standard|agent|decision|adaptive`, `agent/pre-step` + `agent/turn-stopping`
- [ ] T-074 Continuation policy over existing `ctx.goals` (`max_iterations`, `escalation.after`, stopping provider)
- [ ] T-075 Long-running handoff: progress projection + resumability test

## M8 — Data plane
- [ ] T-080 `packages/data/` skeleton; `ctx.dataEngines` + `DataSource`/`QueryEngine`/`ArtifactStore` contracts
- [ ] T-081 DuckDB adapter
- [ ] T-082 Tools `data.inspect|profile|sample|schema|aggregate`
- [ ] T-083 Tools `sql.query|explain|validate` (read-only by default; writes require approval)
- [ ] T-084 Long scans via `ctx.jobs`; result summarization contract (no raw rows in prompt)
- [ ] T-085 Progressive-reduction demo on a synthetic 10M-row dataset

## M9 — Governance
- [ ] T-090 `packages/governance/` skeleton; policy model (RBAC/ABAC)
- [ ] T-091 Budgets (tokens/cost/time) enforced on `tools/execute` + `llm/stream`
- [ ] T-092 Audit trail as session events + projection
- [ ] T-093 PII policy on `fs/*-intent` and tool arguments
- [ ] T-094 `ctx.invariants` registrations for our own subsystems

## Parking lot (not scheduled)
- Memory layer (`ctx.memory`) — Hermes-style two-file snapshot; decide after M5
- MCP tool policy integration; Spark/Snowflake/BigQuery/ClickHouse adapters
- CLI `verness run --persona X --mode adaptive "..."` (currently: `dsh` + profile)
- Real Jev API provider once credentials/SDK exist; CI (GitHub Actions) once M2 lands
