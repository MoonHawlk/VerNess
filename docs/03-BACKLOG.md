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

## Developer experience — ADR-0006
- [x] T-110 `verness.config.json` setup file (JSONC): substrate pins, profile, model routes, personas, tips, plugins, settings
- [x] T-111 `scripts/verness.mjs` launcher: `setup | start | run | sync | doctor | graph`, all platform differences isolated
- [x] T-112 `turn_on.sh` / `turn_on.ps1` / `turn_on.cmd` wrappers + npm script aliases
- [x] T-113 Profile patch generated from the config (committed for reviewability); `scripts/profile-sync.mjs` removed
- [x] T-114 Windows `.cmd` shim handling (Node refuses `.cmd` without a shell) with own argument quoting
- [x] T-115 pnpm exit codes are not trusted — setup verifies outcomes by reading the profile `package.json`
- [x] T-120 Model lifecycle script (`scripts/model.mjs`): `up` (engine install + serve + HF pull + warm), `stats` (telemetry), `down` (evict weights, stop only our own server, clear run state)
- [x] T-121 Weights sourced from Hugging Face on every platform: `hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0` (ADR-0007)
- [x] T-122 Launcher subcommands + npm aliases for the three lifecycle actions; run state in `.verness/run/` (gitignored)
- [ ] T-123 `stats --watch` for continuous telemetry, and record probe results over time for regression tracking
- [ ] T-124 Verify `up`/`down` on macOS and Linux (logic is platform-agnostic but only Windows is measured so far)
- [ ] T-116 Enforce persona `tools.allow`/`tools.deny` from the same config keys once M4 lands (today they are recorded only)

## Command layer & quick-tools — ADR-0008, design in `docs/07-COMMAND-LAYER.md`
Survey behind the choices: `docs/research/claude-code-capability-map.md`. Tiers: **L** = launcher-local
(zero tokens), **S** = needs a substrate seam, **P** = persona/team concept.

### Foundation (do these first, in order)
- [ ] T-130 **`/btw <note>`** — the first command: append/show/clear/drop operator side notes, persisted to `.verness/run/notes-<session>.json`, prefixed onto the next task as a delimited "context, not tasks" block, hard character cap with a warning at 80% (L). Spec in `docs/07-COMMAND-LAYER.md`
- [ ] T-131 Split mutable state into `verness.state.json` so commands never rewrite the commented `verness.config.json` (challenge #4 — decide before any config-writing command)
- [ ] T-132 Command registry: `scripts/command.mjs` + auto-discovered `scripts/commands/*.mjs`, uniform `{name, summary, usage, group, run(ctx,args)}`, `ctx = {cfg, paths, state, sync, out, dsh}`; REPL dispatch for `/x`, `//` literal escape, unique-prefix match, "did you mean"
- [ ] T-133 Session-log reader: resolve the concatenated-zstd problem (challenge #2) — prefer `@deepseek-ai/dsh-session-query` over parsing `session.v4.jsonl.zstd` ourselves. **Blocks T-136/T-137**
- [ ] T-134 `/help` generated from the registry, grouped, with usage lines (L)
- [ ] T-135 Registry conformance test: load every command file, assert shape, assert no duplicate names/prefixes

### Tier L — local commands, zero token cost
- [ ] T-136 `/cost` — tokens in/out and wall time for the session; `0` cost on a local route, never an estimated price (challenge #3)
- [ ] T-137 `/usage` — tokens per route per day, aggregated across sessions
- [ ] T-138 `/model [route|id]` — show or switch the active route, regenerate the patch, re-sync atomically
- [ ] T-139 `/persona [id]` — show or switch persona, atomically (challenge #5)
- [ ] T-140 `/agents` — list personas and teams with their declared tools/skills, labelled **declared, not enforced**
- [ ] T-141 `/config` — print the resolved configuration and the file path that owns each value
- [ ] T-142 `/doctor`, `/status` — wrap the existing launcher verbs; `/status` merges doctor + engine stats
- [ ] T-143 `/stats`, `/up`, `/down` — expose the model lifecycle verbs as commands
- [ ] T-144 `/sessions`, `/resume <id>`, `/clear` — list from `$DSH_HOME/sessions`, reuse `dsh --session-id`
- [ ] T-145 `/graph` — rebuild or query the Engram graph without leaving the REPL
- [ ] T-146 `!<cmd>` shell prefix and `@path` file expansion in the REPL (Claude Code parity, still zero tokens)
- [ ] T-147 `#<note>` — append to the persistent project/persona brief (the durable sibling of `/btw`)
- [ ] T-148 `/exit` for symmetry with `/help`

### Tier S — surface an existing substrate capability (do NOT reimplement)
- [ ] T-150 `/todos` — render the `ctx.todo` projection
- [ ] T-151 `/compact`, `/context` — expose `packages/compaction` and the assembled-prompt view
- [ ] T-152 `/export` — reuse `dsh-session-log-export` (it already ships an `/export`)
- [ ] T-153 `/mcp` — list MCP servers and their tool filters from `packages/mcp`
- [ ] T-154 `/tools` — registered tools with per-persona allow/deny once M4 enforces it
- [ ] T-155 `/permissions` — persona tool policy on `tools/pre-execute` (M4 work, surfaced here)
- [ ] T-156 `/hooks` — read-only list of mounted Cordis listeners per event
- [ ] T-157 `/goal` — drive the existing `ctx.goals` (aligns with M7)
- [ ] T-158 `/rewind` — session replay/fork; needs a UX decision before any code
- [ ] T-159 `/schedule`, `/jobs` — surface `ctx.schedule` and `ctx.jobs`
- [ ] T-160 `/evaluate` — run an evaluator suite against the last result (M7)
- [ ] T-161 Promote `/btw` notes to a durable `SessionEvent` contributed by a plugin, retiring the resend compromise

### Personas as files (supersedes the inline config block)
- [ ] T-162 `personas/<id>.yaml` schema: identity, prompt prefix/suffix, `models.requirements`, tools allow/deny/approval, skills, evaluators, exposed commands
- [ ] T-163 Loader + validation with file/line diagnostics; `personas.active` resolves to a file
- [ ] T-164 Author the real personas: `data-scientist`, `data-analyst`, `software-engineer`, `researcher`, `reviewer`
- [ ] T-165 Persona-scoped commands: a persona may add its own commands (e.g. `/profile-data`), loaded from `personas/<id>/commands/*.mjs`
- [ ] T-166 Every surface that prints policy marks it **declared** until M4/M5/M7 enforce it (challenge #6)

### Teams & multiple tasks
- [ ] T-167 `teams/<id>.yaml`: member personas + ordered task list + failure policy (stop | skip | retry-once — challenge #10)
- [ ] T-168 `/team list|run|status` — v1 runs tasks sequentially, one `dsh` session per task per persona
- [ ] T-169 `/task add|list|cancel` and `/delegate <persona> <task>`
- [ ] T-170 Run artifacts: `.verness/runs/<timestamp>/` with per-task status, usage and outputs; `/team status` reads it
- [ ] T-171 Measure before promising parallelism: two concurrent sessions contend for one local model
- [ ] T-172 Re-implement team dispatch on `ctx.subagents` + `ctx.jobs`, retiring the launcher loop

## Cost control (Engram) — ADR-0005
- [x] T-100 Install the knowledge-graph layer: `@sentropic/engram@0.19.0` global CLI (`graphifyy` and `@sentropic/graphify` are deprecated forwarding shims to it)
- [x] T-101 Build the project graph code-only (`engram update .`, no LLM calls): 14 nodes / 20 edges / 3 communities. Engram itself reports the corpus is too small to benefit yet
- [ ] T-102 **Where the payoff is**: build a code-only graph of `deepseek-harness` OUTSIDE the submodule (`engram clone`), so upstream navigation becomes graph queries instead of greps. Time-box it; measure tokens-per-question before/after
- [ ] T-103 Re-evaluate committing `.engram/graph.json` + `GRAPH_REPORT.md` once `packages/*` holds real TypeScript
- [ ] T-104 Optional: semantic extraction over `docs/` via the local route (`engram extract --backend ollama`) — only worth it with a stronger local model

## Decision layer — Laya / SystemOne protocol (ADR-0009, design in `docs/08-DECISION-LAYER-LAYA.md`)

Protocol and provider
- [ ] T-200 Type the SystemOne wire contract (request `state` + `questions`, response `answers` with per-question payload + `confidence`) from the live server, not from the card
- [ ] T-201 `LayaDecisionProvider`: `decide()` -> one `POST /v1/systemone`, bearer auth when `LAYA_API_KEY` is set
- [ ] T-202 Adapter rules that hide two known model bugs: emit yes/no as a two-option `choice` (never `noul`, issue #156); map confidence from `confidence` (never `act_probability`, issue #185)
- [ ] T-203 `RuleDecisionProvider` (declarative, no network) — the baseline every model provider must beat
- [ ] T-204 `CompositeDecisionModel`: rules -> decision model -> LLM, with confidence thresholds and cost accounting
- [ ] T-205 `JevProvider` proven by construction: same adapter, different base URL (no new code — if it needs code, the abstraction is wrong)
- [ ] T-206 `/decide` quick-tool: ask a typed question from the REPL, print answer + confidence + provider, zero LLM tokens

Lifecycle (mirrors the model engine, ADR-0007)
- [ ] T-210 Detect Python 3.10+; `doctor` reports the decision engine separately and the harness stays fully usable without it
- [ ] T-211 `decision up`: create a venv, `pip install "laya[serve]"`, start `laya-serve`, wait for readiness, record run state
- [ ] T-212 `decision stats`: checkpoint loaded, resident memory, measured p50/p95 latency for a real typed question
- [ ] T-213 `decision down`: stop the sidecar we started, free its memory, clear run state (never kill one we merely adopted)
- [ ] T-214 Config block `decisions: { engine, baseURL, apiKeyEnv, checkpoint, autoInstall, autoServe }` in `verness.config.json`

Calibration and evaluation — the gate before any policy use
- [ ] T-220 Collect a held-out set of OUR decisions (task routing, retry/stop) with human labels
- [ ] T-221 Measure zero-shot accuracy, ECE and AUROC on that set; publish the numbers in `docs/research/`
- [ ] T-222 Refit one temperature per (question type, option count) and re-measure (the card reports mean ECE 0.466 -> 0.081 from exactly this)
- [ ] T-223 **Gate**: a decision path ships enabled only when its measured ECE beats the rule baseline it replaces. Until then every provider is opt-in
- [ ] T-224 Measure CPU-only latency on a developer laptop — every published figure is a T4 GPU, and the cheap-decision premise depends on this

First real uses
- [ ] T-230 Team task router: pick the owning persona with one `choice` over persona ids
- [ ] T-231 Supervisor decision: continue / retry / complete / escalate as a 4-option choice (a small option space is Laya's strong regime)
- [ ] T-232 Decision accounting in `/cost`: count decision calls separately and report LLM calls avoided
- [ ] T-233 Tool-risk gate on `tools/pre-execute`, modelled on the in-tree precedent `packages/experimental/auto-review` (classifier -> allow/deny/ask, integrates with permission presets); swap its LLM call for one `POST /v1/systemone`. Blocked on T-223
- [ ] T-234 `ctx.tools.restrict({allow, deny})` companion plugin — the primitive both MCP tool filtering and the M4 persona tool policy need (`packages/core/tools/src/index.ts:701-711`)

Deferred / investigate
- [ ] T-240 MCP path (`laya[mcp]`): expose Laya to the MODEL as a tool — complementary to, not a replacement for, harness-side control flow
- [ ] T-241 ONNX path (`laya[onnx]`): if the decision head survives export, a Node runtime removes the sidecar entirely
- [ ] T-242 Fine-tune on our own decisions once T-220 has a labelled set (the card's own advice: 0.362 -> 0.766 on its benchmark)
- [ ] T-243 Guardrail/moderation question on inbound tasks — one extra question in an existing call is nearly free

## Parking lot (not scheduled)
- Memory layer (`ctx.memory`) — Hermes-style two-file snapshot; decide after M5
- MCP tool policy integration; Spark/Snowflake/BigQuery/ClickHouse adapters
- CLI `verness run --persona X --mode adaptive "..."` (currently: `dsh` + profile)
- Real Jev API provider once credentials/SDK exist; CI (GitHub Actions) once M2 lands
