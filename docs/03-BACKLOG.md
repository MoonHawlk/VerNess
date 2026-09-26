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
- [x] T-133 Session-log reader: **the concatenated-zstd problem is solved, not open** — `scripts/lib/sessions.mjs` splits on the zstd magic and decodes frame by frame (measured: 10 frames -> 24 events on a log that `zstdDecompressSync` read as 1 event). `@deepseek-ai/dsh-session-query` remains the supported alternative if the format changes. Caveat in T-143
- [ ] T-134 `/help` generated from the registry, grouped, with usage lines (L)
- [ ] T-135 Registry conformance test: load every command file, assert shape, assert no duplicate names/prefixes

Known defects in the WIP command layer (commit 1515661) — fix before wiring anything else
- [x] T-140 REPL and CLI dispatch `/` input to the registry. REPL: a leading slash is the only command marker, so no phrasing of a real task is swallowed. CLI: a bare word that names a command runs it, a quoted sentence never does — every quick-tool is unreachable until they do
- [x] T-141 `/persona` works: `writePatch` now resolves through `lib/personas.mjs` (state override -> file persona -> config). **Verified by boot**: the persona prefix and its tips appear in the session's `system/message`. Was: `writePatch` in `scripts/verness.mjs` still uses its own inline persona resolution and ignores the `state.json` override written by the command. Make it use `lib/personas.mjs` (`activePersonaId`, file-based personas, `persona.model.id`)
- [x] T-142 `/usage` attributes usage to the route of the current `request/header`, tracked as the session is folded, instead of the last-inserted key. Was: `summarizeSession` charges usage to the last *inserted* route key rather than the route of the current `request/header`. Track a `currentRoute` updated by each header event
- [x] T-143 Frame decoding no longer drops data: a slice that fails to decode is merged with the next boundary and retried (the magic bytes can occur inside compressed data), and any frame still undecodable is counted in `lastReadSkippedFrames` rather than swallowed. Measured across 28 logs / 599 events: **0 skipped**. Was: if the magic bytes occur inside compressed data a slice fails to decode and is swallowed, so `/usage` undercounts without warning. On failure, merge the slice with the next boundary and retry, then report any frames still skipped
- [x] T-144 `--parallel` is real: the runner awaits `ctx.dshAsync` (an async `spawn` of the same shell-free dsh entry, stdin closed, spawn errors resolve as exit 1), and each task writes its persona overlay beside its own transcript so concurrent tasks never share the file. **Verified** by `node scripts/test/teams.parallel.mjs`: two independent tasks start 1 ms apart and a two-level team takes ~2 task-lengths instead of 3; the old synchronous runner took 914 ms for two 400 ms tasks at `--parallel 2`. Default concurrency stays 1; ADR-0008 amended. Was: `execute()` calls `sh()` which is `spawnSync`, so it blocks the event loop and `Promise.race` never overlaps
- [x] T-145 Windows argument passing fixed: a `dsh()` runner resolves `<npm root -g>/@deepseek-ai/dsh` -> `bin.dsh` and spawns `process.execPath` with it and **no shell**, so newlines, long prompts and `%` survive on every platform (verified: a two-line prompt round-tripped intact). Was (everything goes through `cmd.exe`): a newline in an argument ends the command, so the team runner's upstream-context block is truncated; the 8191-character command-line limit is easy to exceed; and the `%` -> `%^` escape is wrong (inside double quotes `^` is literal, so "grew 10%" arrives as "grew 10%^"). Fix all three by resolving `<npm root -g>/@deepseek-ai/dsh/package.json` -> `bin.dsh` and spawning `process.execPath` with that JS file and **no shell**
- [x] T-146 `/model` implemented (show resolved model, `/model <id>`, `/model reset`); precedence is override -> persona preference -> route default. `describePersona`'s `[enforced]` label on the model line is now true. Was; `describePersona` labels the model line `[enforced]`, which only becomes true once T-141 lands

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
- [x] T-200 SystemOne wire contract confirmed against the LIVE server (not the card): a choice answer carries `choice`, a `probabilities` map, `confidence` (entropy) and `answer_confidence`. Was: type the contract (request `state` + `questions`, response `answers` with per-question payload + `confidence`) from the live server, not from the card
- [x] T-201 `scripts/lib/decisions.mjs`: SystemOne client with bearer auth, `GET /health`, and 503 treated as backpressure with retry. Was: `decide()` -> one `POST /v1/systemone`, bearer auth when `LAYA_API_KEY` is set, readiness via `GET /health`, 503 handled as backpressure with retry
- [x] T-202 Adapter gates on `answer_confidence` and ignores `act_probability`; yes/no would go out as a two-option choice (no `noul` is used). Was: emit yes/no as a two-option `choice` (never `noul`, issue #156); map `DecisionResult.confidence` from **`answer_confidence`** — the temperature-calibrated field ECE is fitted against — never from `confidence` (raw entropy) and never from `act_probability` (issue #185)
- [x] T-203 `ruleRoute()` rule baseline (keyword/length heuristics) with a stated reason per decision. Was (declarative, no network) — the baseline every model provider must beat
- [ ] T-204 `CompositeDecisionModel`: rules -> decision model -> LLM, with confidence thresholds and cost accounting
- [ ] T-205 `JevProvider` proven by construction: same adapter, different base URL (no new code — if it needs code, the abstraction is wrong)
- [x] T-206 `/decide <task>` prints the model and the rules side by side with confidences and the level distribution, and logs the pair. Was: ask a typed question from the REPL, print answer + confidence + provider, zero LLM tokens. Depends on T-201 and T-140 (REPL dispatch)

Lifecycle (mirrors the model engine, ADR-0007)
- [x] T-210 `doctor` reports the decision engine separately and says `off (optional)` when disabled; the harness stays usable without Python. Was: detect Python 3.10+; `doctor` reports the decision engine separately and the harness stays fully usable without it
- [x] T-211 `/decision up` creates the venv, installs `laya[serve]`, starts the sidecar with `LAYA_HOST` on loopback and a generated `LAYA_API_KEY`, waits for health, records run state. Was create a venv, `pip install "laya[serve]"`, start `laya-serve`, wait for readiness, record run state. **Security: `laya-serve` binds `0.0.0.0` with no authentication unless `LAYA_API_KEY` is set** (model card) — set `LAYA_HOST=127.0.0.1` (and `LAYA_PORT`), and set a generated `LAYA_API_KEY` as well. Never start it open on a LAN
- [x] T-212 `/decision stats` reports checkpoints loaded, run-state ownership, measured p50/min/max over 5 calls, and a sample typed answer. Was checkpoint loaded, resident memory, measured p50/p95 latency for a real typed question, and the `LAYA_MAX_CONCURRENT` headroom (default 16; excess requests get `503 server busy`, so every fan-out path must bound concurrency and treat 503 as backpressure)
- [x] T-213 `/decision down` stops only a sidecar VerNess started (`--force` overrides) and clears run state. Was stop the sidecar we started, free its memory, clear run state (never kill one we merely adopted)
- [x] T-214 `decisions` config block added (`enabled`, `shadow`, `baseURL`, `apiKeyEnv`, `timeoutMs`, `venv`, `checkpoint`); `enabled` only turns on shadow logging. Was: config block `decisions: { engine, baseURL, apiKeyEnv, checkpoint, autoInstall, autoServe }` in `verness.config.json`

Calibration and evaluation — the gate before any policy use
- [ ] T-220 Collect a held-out set of OUR decisions (task routing, retry/stop) with human labels
- [ ] T-221 Measure zero-shot accuracy, ECE and AUROC on that set; publish the numbers in `docs/research/`
- [ ] T-222 Refit one temperature per (question type, option count) and re-measure (the card reports mean ECE 0.466 -> 0.081 from exactly this)
- [ ] T-223 **Gate**: a decision path ships enabled only when its measured ECE beats the rule baseline it replaces. Until then every provider is opt-in
- [x] T-224 **Measured on this laptop: p50 950 ms** for all three questions in one call (min 890, max 966, n=5) - two to five times the documented 193-464 ms CPU range and ~29x the 32.8 ms T4 figure. Was against the documented **193–464 ms CPU vs 32.8 ms T4** — the widely quoted ~33 ms is a GPU figure, and the cheap-decision premise for local development rests on the CPU number

First real uses
- [ ] T-230 Team task router: pick the owning persona with one `choice` over persona ids. Depends on T-145 (the runner's prompts are truncated on Windows today) and T-144
- [ ] T-231 Supervisor decision: continue / retry / complete / escalate as a 4-option choice (a small option space is Laya's strong regime)
- [ ] T-232 Decision accounting in `/cost`: count decision calls separately and report LLM calls avoided
- [ ] T-233 Tool-risk gate on `tools/pre-execute`, modelled on the in-tree precedent `packages/experimental/auto-review` (classifier -> allow/deny/ask, integrates with permission presets); swap its LLM call for one `POST /v1/systemone`. Blocked on T-223
- [ ] T-234 `ctx.tools.restrict({allow, deny})` companion plugin — the primitive both MCP tool filtering and the M4 persona tool policy need (`packages/core/tools/src/index.ts:701-711`)

Decision-driven routing — task level, model tier, pipeline (handoff: `docs/09-HANDOFF-DECISION-ROUTING.md`)
- [x] T-250 Shadow logging wired into the REPL and `/decide`: every task records model answer + `answer_confidence` + rule answer + agreement to `.verness/decisions/*.jsonl`, changing nothing. Was ask the three routing questions per task and log answer + `answer_confidence` + rule answer + outcome to `.verness/decisions/*.jsonl`. **No behaviour change** — this is how the labelled set for T-260 gets built
- [x] T-251 Rule baseline implemented for all three questions. Was (keyword/length/path heuristics): the thing Laya must beat, and the fallback whenever confidence is low
- [ ] T-252 `/decide` extended: run the three routing questions on the current input, printing Laya and rules side by side with confidences
- [ ] T-253 Capability router: persona requirements + model capabilities -> eligible -> cost/latency/policy -> model. **Tier is an input, never a model id** (high-cardinality choice is Laya's documented weak spot)
- [ ] T-254 Pipeline executor for `standard`; the other three modes belong to M7
- [ ] T-255 `/routing` quick-tool: last N routing decisions and the Laya-vs-rules agreement rate
- [ ] T-260 Label the shadow set; publish accuracy, ECE and AUROC per question against the rule baseline
- [ ] T-261 Refit one temperature per (question type, option count) and re-measure
- [ ] T-262 Gated rollout, one question at a time, high-confidence band only: `pipeline` first (cheapest to get wrong), then `level`, then `tier`

Deferred / investigate
- [ ] T-240 MCP path (`laya[mcp]`): `laya-mcp-server` is **stdio-only** (no HTTP/SSE) and exposes 5 tools (`laya_status`, `laya_route`, `laya_predict`, `laya_shortlist`, `laya_preset`). The substrate registers stdio MCP servers as a loader row, so this is near-zero code — but it exposes Laya to the MODEL as a callable tool, which is complementary to, not a replacement for, harness-side control flow
- [ ] T-241 **`laya-ts` path — the intended end state**: the upstream repo ships a TypeScript reimplementation over a split ONNX export (`encoder.onnx` + `head.onnx`, export verified to 1e-4), so a decision provider can run inside a Cordis plugin with no sidecar and no Python at run time. Blockers: `laya-ts` is not on npm (404 — must be vendored or built from the monorepo) and the export needs a one-time Python run
- [ ] T-242 Fine-tune on our own decisions once T-220 has a labelled set (the card's own advice: 0.362 -> 0.766 on its benchmark)
- [ ] T-243 Guardrail/moderation question on inbound tasks — one extra question in an existing call is nearly free

Observability
- [x] T-270 `/dashboard`: a self-contained static HTML page built from the session logs, the shadow decision log and team-run transcripts. Sessions with turns/tools/tokens/wall time, click-through to a full per-session timeline, decisions with model-vs-rules agreement and latency, team runs with per-task outcome. No server, no network, no dependencies
- [ ] T-271 Dashboard: per-tool call counts and failure rate, and a latency histogram rather than p50 alone
- [ ] T-272 Dashboard: filter by persona and by route; today it shows everything in the workspace
- [ ] T-273 Dashboard: `--watch` to rebuild on change, for a second screen during long runs

**Standalone dashboard service** (requested 2026-09-26; deliberately deferred). Today `/dashboard`
is a generator inside the launcher: it builds a static file on demand from one workspace. The ask is
to decouple it, so a dashboard is available whenever the harness is active and can show more than
one environment.
- [ ] T-274 Run the dashboard as its own process (`verness-dashboard`), independent of any REPL or task run — the harness must work with it down, and it must work with no REPL open
- [ ] T-275 Serve over HTTP on **loopback by default**, with a generated token required before any non-loopback bind. Same rule as the decision sidecar (ADR-0009): a page exposing session transcripts is not something to leave open on a LAN
- [ ] T-276 Multi-environment: read several sources at once (different `DSH_HOME`s, profiles and workspaces), declared in config, with the environment as a first-class column and filter
- [ ] T-277 Live updates: watch the session-log directory, the decisions JSONL and the run transcripts, and push changes (SSE or a poll interval) rather than requiring a rebuild
- [ ] T-278 Keep the static export as a first-class mode — it is how a run gets shared or archived offline, and it must not regress when the service exists
- [ ] T-279 Decide the read path: reuse `scripts/lib/sessions.mjs` in-process, or move to `@deepseek-ai/dsh-session-query` if watching many workspaces makes repeated full reads too costly. Measure before choosing

Thought graph — ephemeral and persistent working memory (design: `docs/10-THOUGHT-GRAPH.md`)
- [ ] T-280 `thought/node` session event + `thoughts` projection: log-only (so compaction cannot shadow it), versioned `stateVersion`, folds to empty on task start
- [ ] T-281 Node schema + boundary validation: `scope`, `kind`, one-sentence capped `claim`, `evidence[]`, `confidence`, `derivedFrom[]`
- [ ] T-282 `/think add | list | show | link | promote | forget`
- [ ] T-283 `think_add` / `think_search` / `think_open` tools so the model records and retrieves its own nodes
- [ ] T-284 Persistent tier in `ctx.storage`, project-scoped, byte-capped, **errors when full** instead of dropping
- [ ] T-285 Frozen session-start injection of `constraint` nodes only, hard-capped — mid-session rewrites would invalidate the prompt-cache prefix
- [ ] T-286 Compaction hook: render the task's findings and decisions into the compacted context, replacing prose summary with structure
- [ ] T-287 `confidence: verified` requires evidence read in-turn, enforced structurally (cwc default-FAIL gate)
- [ ] T-288 Eviction by demotion to a stub with a recovery pointer, never deletion
- [ ] T-289 Subagents receive only explicitly passed nodes — never the graph by inheritance
- [ ] T-290 Dashboard panel: the graph with its edges, plus the promoted-node inventory
- [ ] T-295 Decision-model assist, shadowed: "is this worth persisting?" and "does this contradict an existing node?"
- [ ] T-296 Contradiction surfaces for resolution; a new finding never silently overwrites a persistent one
- [ ] T-297 Poisoning guard: every persistent node records the session and model that produced it, so a bad run is traceable and revocable

TUI
- [x] T-300 Inline suggestions while typing: `scripts/lib/prompt.mjs` is a raw-mode line editor with ghost completion, a live dropdown with per-command hints, arrow selection, Tab/Right accept, history on Up/Down, and a plain-readline fallback when stdin is not a TTY
- [x] T-301 Simulated-terminal test (`scripts/test/prompt.simulated-tty.mjs`): fake TTY, captured stdout, synthetic keypresses; asserts rendering, filtering, selection and acceptance
- [ ] T-302 Wrap long input lines in the editor — the dropdown is suppressed rather than mis-positioned when the input exceeds the terminal width
- [ ] T-303 Suggest task text too, not only commands: recent prompts from the session log as history-backed completions

Repo hygiene
- [x] T-310 `.gitignore` no longer swallows `scripts/lib/`; all eight launcher modules are tracked and a fresh clone starts (verified by cloning and running `help`)
- [ ] T-311 Add the clean-clone check to a pre-push hook or CI so an untracked source directory fails loudly instead of silently
- [ ] T-312 Assert at startup that every `./lib/*.mjs` the launcher imports is tracked by git, and warn if not

## Parking lot (not scheduled)
- Memory layer (`ctx.memory`) — Hermes-style two-file snapshot; decide after M5
- MCP tool policy integration; Spark/Snowflake/BigQuery/ClickHouse adapters
- CLI `verness run --persona X --mode adaptive "..."` (currently: `dsh` + profile)
- Real Jev API provider once credentials/SDK exist; CI (GitHub Actions) once M2 lands
