# 03 — Backlog (open work only)

Task IDs are stable and never reused. Finished tasks move to **`03-BACKLOG-DONE.md`** as soon as
their exit condition is verified, so this file only ever lists what is left to do.

**Implementation plans** for every group below are in `docs/superpowers/plans/`. Start with
`2026-09-26-00-master-plan.md`: it gives the execution order, the dependencies between
workstreams, and the rules every task inherits. Each group heading names its plan file (WS-A … WS-H).

Keep one commit per task (or per small group), and log it in `04-PROGRESS.md`.

> Audit 2026-09-26: every open line was checked against the code. Lines marked *(remaining part)*
> are partly built; the built part is archived and only the gap is listed here. T-180/T-181 are new
> IDs for Tier L items whose old IDs collided with the command-layer defects (see the archive).

> **Priority (owner, 2026-09-26): WS-E — the Laya decision layer — goes first.** Start with WS-E
> Task 1 in `05-decision-calibration-routing.md` (log probabilities, option-set hash and record id in
> shadow records; **done 2026-09-26**), then T-220 → T-221 → T-222 → T-223. Other workstreams wait unless they block it.

---

## WS-A — Launcher, command layer, REPL (plan `01-launcher-commands.md`)

Foundation
- [ ] T-183 Make `npm test` real: replace the dead `vitest run` / `tsc -b` scripts with `node --test` over `scripts/test/`; convert the two existing test scripts to `node:test`
- [ ] T-135 Registry conformance test: load every command file, assert shape, and assert no duplicate names or aliases
- [ ] T-182 Unique-prefix match (`/mo` → `/model` when unambiguous) and the `//` escape (a line starting `//` is sent to the model as a literal task starting with `/`)
- [ ] T-130 **`/btw <note>`**: append/show/clear/drop operator side notes in `.verness/run/notes-<session>.json`, prefixed onto the next task as a delimited "context, not tasks" block, 2000-character cap with a warning at 80%. Spec in `docs/07-COMMAND-LAYER.md`
- [ ] T-148 `/exit` (alias `/quit`) for symmetry with `/help`

Tier L — local, zero tokens
- [ ] T-180 `/config`: print the resolved configuration, and for each value the file that owns it (built-in default, `verness.config.json`, `.verness/state.json`, persona file) *(was the Tier L T-141)*
- [ ] T-181 `!<cmd>` shell prefix and `@path` file expansion in the REPL *(was the Tier L T-146)*
- [ ] T-147 `#<note>`: append to a persistent project brief (`.verness/brief.md`) that is prefixed like `/btw` but survives sessions
- [ ] T-137 `/usage` *(remaining part)*: add a `--by day` breakdown (tokens per route per day across sessions)

TUI
- [ ] T-302 Wrap long input lines in the editor; today the dropdown is suppressed when input exceeds the terminal width
- [ ] T-303 History-backed task suggestions: recent prompts from the session logs as completions

Repo hygiene
- [ ] T-311 Clean-clone check as a `pre-push` git hook (`scripts/check-clean-clone.mjs`)
- [ ] T-312 At startup, warn when a `./lib/*.mjs` the launcher imports is not tracked by git

Launcher lifecycle
- [ ] T-123 `stats --watch` for continuous telemetry, and record probe results over time for regression tracking
- [ ] T-124 Verify `up`/`down` on macOS and Linux (only Windows has been measured)

## WS-B — Teams and multiple tasks (plan `02-teams.md`)
- [ ] T-171 Measure before promising parallelism: time the same team at concurrency 1 and 2 on the local model and record the numbers in `04-PROGRESS.md`
- [ ] T-167 *(remaining part)* Failure policy per team and per task: `onFailure: stop | skip | retry-once`, default `stop`; dependents of a failed task are marked `skipped`, never run
- [ ] T-170 *(remaining part)* `/team status [<id>]`: read the newest `.verness/runs/<team>/<stamp>/` and print per-task status, exit, seconds; write a machine-readable `summary.json` next to `summary.md`
- [ ] T-169 `/task add|list|cancel` and `/delegate <persona> <task>`: a one-task ad-hoc team run
- [ ] T-230 Team task router: pick the owning persona for a task with no `member` with one Laya `choice` over persona ids (shadow first, see WS-E)
- [ ] T-172 Re-implement team dispatch on `ctx.subagents` + `ctx.jobs`, retiring the launcher loop (after WS-G M7)

## WS-C — Pet (plan `03-pet-animation.md`)
> **In flight (2026-09-26):** two drawings exist. `main`'s working tree (uncommitted) has a circle
> with moods `happy | curious | sad`, `petAnimFrames` and a one-shot boot animation `animatePet`.
> Branch `epic` (5338fd4) has a baby sheep with moods `happy | sleepy | worried` and a matching
> render test. In `main`, `scripts/test/pet.render.mjs` fails until one drawing is chosen (T-338).
> The tasks below are written against frame lists and an exported `PET_MOODS`, not a drawing.
- [ ] T-338 Rewrite `scripts/test/pet.render.mjs` as a mood-agnostic `node:test` suite over `PET_MOODS` (every frame the same size, ASCII only, broken > idle > ok)
- [ ] T-335 Animations. Frames stay ASCII and minimal
  - [ ] T-335a Frame model *(remaining part)*: `petAnimFrames(mood)` exists; add a per-frame timing (`{lines, ms}`) and a `loop` vs `once` flag per mood
  - [ ] T-335b Blink: happy eyes → closed for ~150 ms every few seconds, at a randomised interval
  - [ ] T-335c Idle loop for `curious`: the `?` mark drifts, then restarts
  - [ ] T-335d Talking *(blocked)*: `dsh` streams straight to stdout during a turn, so nothing may draw then. Re-scoped: a one-line status spinner once the REPL reads the `--json` event stream, as `/loop-task` already does
  - [ ] T-335e `sad`: the `!` pulses until the problem it names is fixed
  - [ ] T-335f Safe redraw: repaint only the art's rows in place (cursor save/restore), never while the line editor is drawing its dropdown; one timer, cleared on exit and on ctrl+c
  - [ ] T-335g Off switch: `pet.animate` (default true), forced off when stdout is not a TTY, when `NO_COLOR`/`CI` is set, or when the terminal is narrower than the side-by-side layout
  - [ ] T-335h Simulated-terminal test: fake clock, frames advance, timers stop, nothing written off a TTY
- [ ] T-334 Show running `/loop-task` and `/team` runs as live workers (pid + heartbeat file per run)
- [ ] T-336 A boot from a second checkout overwrites the shared `~/.dsh` profile patch; stamp the patch with the checkout path and warn (or refuse) when another checkout wrote it

## WS-D — Loop, dashboard, observability (plan `04-loop-dashboard-observability.md`)
Autonomous task loop
- [ ] T-327 Per-round wall-clock budget (`--round-timeout <s>`, default 600); a timed-out round is classified `timeout` and stops the loop
- [ ] T-325 Port `packages/guard/repeat-tool-reminder` behaviour from the substrate in place of our identical-call check, escalated to a hard block
- [ ] T-328 Surface loop runs in `/dashboard` (already recorded in `.verness/loops/*.jsonl`)
- [ ] T-326 Let the decision model give the round verdict (continue/retry/complete/escalate) once T-223 clears; shadow it until then

Static dashboard
- [ ] T-271 Per-tool call counts and failure rate; latency histogram rather than p50 alone
- [ ] T-272 Filter by persona and by route
- [ ] T-273 `--watch`: rebuild on change

Standalone dashboard service (deferred by request; do after T-271..T-273)
- [ ] T-279 Decide the read path (in-process `lib/sessions.mjs` vs `@deepseek-ai/dsh-session-query`). Measure first
- [ ] T-274 Own process `verness-dashboard`, independent of any REPL; the harness works with it down
- [ ] T-275 HTTP on loopback by default; a generated token is required before any non-loopback bind
- [ ] T-276 Multi-environment: several `DSH_HOME`s / workspaces from config, environment as a column and filter
- [ ] T-277 Live updates: watch the logs and push via SSE
- [ ] T-278 Keep the static export first-class; it must not regress

Cost control (Engram)
- [ ] T-102 Code-only graph of `deepseek-harness` outside the submodule (`engram clone`); time-boxed; measure tokens-per-question before/after
- [ ] T-103 Re-evaluate committing `.engram/graph.json` once `packages/*` holds real TypeScript
- [ ] T-379 Optional Engram extras not done yet: the description batches, and `engram claude install` (a CLAUDE.md section + a PreToolUse hook). Decide whether the hook earns its per-tool-call cost before installing it
- [ ] T-104 Optional: semantic extraction over `docs/` via the local route; only with a stronger local model

## WS-E — Decision layer: calibration, routing, first uses (plan `05-decision-calibration-routing.md`)
Measurement, which gates everything else
- [ ] T-220 / T-260 Labelling tool: `/decisions label` walks unlabelled shadow records and stores human labels in `.verness/decisions/labels.jsonl` (T-220 and T-260 are the same task, one set for all three questions)
- [ ] T-221 `/decisions report`: accuracy, ECE (10 bins) and AUROC per question for the model and for the rule baseline; publish to `docs/research/decision-calibration.md`
- [ ] T-222 / T-261 Temperature refit per (question, option count) on the labelled set, stored in `.verness/decisions/temperatures.json`, applied in `readAnswer`; re-measure
- [ ] T-223 **Gate**: a decision path ships enabled only when its measured ECE *and* accuracy beat the rule baseline it replaces. Encode the gate as `decisionGate(question)` reading the latest report

Composition and routing
- [ ] T-204 `CompositeDecisionModel` (launcher-level first): rules → decision model → LLM, with confidence bands and cost accounting
- [ ] T-205 `JevProvider` proven by construction: the same client with a different `baseURL` and key env. If it needs code, the abstraction is wrong
- [ ] T-253 Capability router: persona requirements + model capabilities → eligible → cost/latency/policy → model. Tier is an input, never a model id
- [ ] T-254 Pipeline executor for `standard` (the other modes belong to M7)
- [ ] T-255 `/routing`: last N routing decisions and the Laya-vs-rules agreement rate
- [ ] T-262 Gated rollout, one question at a time, high-confidence band only: `pipeline`, then `level`, then `tier`

First real uses
- [ ] T-231 Supervisor decision: continue / retry / complete / escalate as a 4-option choice
- [ ] T-232 Decision accounting in `/cost`: decision calls counted separately; LLM calls avoided reported

Deferred / investigate
- [ ] T-240 MCP path (`laya[mcp]`, stdio only): register as a loader row; complements, never replaces, harness-side control
- [ ] T-241 `laya-ts` in-process provider over the split ONNX export (not on npm; vendor or build)
- [ ] T-242 Fine-tune on our labelled decisions once T-220 has a set
- [ ] T-243 Guardrail/moderation question on inbound tasks (one more question in an existing call)

## WS-G — Substrate plugins M3–M9 (plan `07-substrate-plugins-m3-m9.md`)
M3 Decisions
- [ ] T-030 `packages/decisions/`; `ctx.decisions` Service + `declare module` augmentation
- [ ] T-031 `RuleDecisionProvider` (declarative rules, no network)
- [ ] T-032 `LlmDecisionProvider` (structured output through `ctx.llm`)
- [ ] T-033 `CompositeDecisionModel` in-plugin (ports the T-204 launcher logic)
- [ ] T-034 `SystemOneProvider` (Laya/Jev by base URL; replaces the "JevProvider stub")
- [ ] T-035 `DecisionRouter` + `DecisionPolicy` resolution
- [ ] T-036 Tool `decision_evaluate` (snake_case: the substrate's tool names)
- [ ] T-037 Tests: unit per provider, composite fallthrough, HMR-safety, 100% per-file coverage on `src`

M4 Personas
- [ ] T-234 `ctx.tools.restrict({allow, deny})` companion plugin, the primitive MCP filtering and M4 tool policy both need
- [ ] T-040 `packages/personas/`: loader (reads `personas/*.json`) + registry + validation
- [ ] T-041 `system-prompt/assemble` contribution (identity + persona sections)
- [ ] T-042 Tool policy on `tools/pre-execute` (allow/deny/ask) + `ctx.approval` wiring (also closes T-116)
- [ ] T-116 Enforce persona `tools.allow`/`tools.deny` (closed by T-042; flip the `[recorded]` labels to `[enforced]`)
- [ ] T-043 Persona files used by the plugin: `data-analyst`, `data-scientist`
- [ ] T-044 Tests including one REAL-composition boot test
- [ ] T-154 `/tools` *(remaining part)*: show per-persona allow/deny next to the offered tools
- [ ] T-155 `/permissions`: persona tool policy as enforced on `tools/pre-execute`

M5 Skills
- [ ] T-050 `packages/skills/`; `SKILL.md` front-matter spec doc `docs/11-SKILLS.md` (no YAML dependency: a documented front-matter subset)
- [ ] T-051 Filesystem loader + trigger matching + 3-tier progressive disclosure
- [ ] T-052 `ctx.skills.registerProvider` bridge (`SkillCandidate[]`)
- [ ] T-053 Skills: `statistics`, `sql`, `evidence`
- [ ] T-054 Cross-check: skill required-tools vs persona tool policy

M6 Routing
- [ ] T-060 `packages/routing/`; model capability registry
- [ ] T-061 `ModelRouter` resolution + cost/latency/policy tie-breaks (ports T-253)
- [ ] T-062 Hook on `agent/request`; log the routing decision as an event
- [ ] T-063 Tests: eligibility, pinning, fallback on `agent/request-error`

M7 Evaluation and goal loop
- [ ] T-070 `packages/evaluation/`; `ctx.evaluators` registry
- [ ] T-071 Evaluator subagent (fresh context, read-only tools, `PASS`/`NEEDS_WORK` first line)
- [ ] T-072 Evidence gate (default-fail) on `tools/pre-execute`
- [ ] T-073 `packages/supervisor/`: modes `standard|agent|decision|adaptive` on `agent/pre-step` + `agent/turn-stopping`
- [ ] T-074 Continuation policy over `ctx.goals` (`max_iterations`, `escalation.after`, stopping provider)
- [ ] T-075 Long-running handoff: progress projection + resumability test

M8 Data plane
- [ ] T-080 `packages/data/`; `ctx.dataEngines` + `DataSource`/`QueryEngine`/`ArtifactStore`
- [ ] T-081 DuckDB adapter
- [ ] T-082 Tools `data_inspect|profile|sample|schema|aggregate`
- [ ] T-083 Tools `sql_query|explain|validate` (read-only by default; writes need approval)
- [ ] T-084 Long scans via `ctx.jobs`; summarisation contract (no raw rows in the prompt)
- [ ] T-085 Progressive-reduction demo on a synthetic 10M-row dataset

M9 Governance
- [ ] T-090 `packages/governance/`; policy model (RBAC/ABAC)
- [ ] T-091 Budgets (tokens/cost/time) on `tools/execute` + `llm/stream`
- [ ] T-092 Audit trail as session events + projection
- [ ] T-093 PII policy on `fs/*-intent` and tool arguments
- [ ] T-094 `ctx.invariants` registrations for our subsystems
- [ ] T-233 Tool-risk gate on `tools/pre-execute`, modelled on `packages/experimental/auto-review`. Blocked on T-223

Tier S commands: surface existing substrate capabilities, never rebuild them
- [ ] T-150 `/todos`: render the `ctx.todo` projection
- [ ] T-151 `/compact`, `/context`
- [ ] T-152 `/export`: reuse `dsh-session-log-export`
- [ ] T-153 `/mcp`: MCP servers and their tool filters
- [ ] T-156 `/hooks`: read-only list of mounted Cordis listeners per event
- [ ] T-157 `/goal`: drive `ctx.goals` (with M7)
- [ ] T-158 `/rewind`: session replay/fork. Needs a UX decision before code
- [ ] T-159 `/schedule`, `/jobs`
- [ ] T-160 `/evaluate`: run an evaluator suite against the last result (M7)
- [ ] T-161 Promote `/btw` notes to a durable `SessionEvent` contributed by a plugin

## WS-H — Thought graph (plan `08-thought-graph.md`, design `docs/10-THOUGHT-GRAPH.md`)
- [ ] T-280 `thought/node` session event + `thoughts` projection: log-only, versioned `stateVersion`, folds to empty on task start
- [ ] T-281 Node schema + boundary validation (`claim` ≤ 200 chars, one sentence)
- [ ] T-282 `/think add | list | show | link | promote | forget`
- [ ] T-283 `think_add` / `think_search` / `think_open` tools
- [ ] T-284 Persistent tier in `ctx.storage`, project-scoped, byte-capped, **errors when full**
- [ ] T-285 Frozen session-start injection of `constraint` nodes only, hard-capped
- [ ] T-286 Compaction hook: render the task's findings and decisions into the compacted context
- [ ] T-287 `confidence: verified` requires evidence read in-turn, enforced structurally
- [ ] T-288 Eviction by demotion to a stub with a recovery pointer, never deletion
- [ ] T-289 Subagents receive only explicitly passed nodes
- [ ] T-290 Dashboard panel: the graph and the promoted-node inventory
- [ ] T-295 Decision-model assist, shadowed: "worth persisting?" and "contradicts?"
- [ ] T-296 Contradictions surface for resolution; never a silent overwrite
- [ ] T-297 Poisoning guard: each persistent node records its session and model; revocable

## Models & API routes — ADR-0010, guide in `docs/11-MODELS-AND-API.md`
Goal: installing a new model, or moving the agent onto a hosted API model that can act on the
environment, is one command — no config edit, no guessing quants, no frozen route.
- [ ] T-357 **First run with a real key**: one API turn that forces a tool call (e.g. list `docs/` and write a file under the workspace), recorded in `04-PROGRESS.md`. Nothing above proves a successful hosted turn yet
- [ ] T-358 `/api test [provider]` — a one-token probe that confirms key + model before a long task; must say it costs tokens and ask first (command-layer cost rule)
- [ ] T-359 Setup wizard: `./turn_on.sh setup --api` asks for a provider, writes the key to `.env` with hidden input, and runs `/api use` — first-run to working hosted agent in one step
- [ ] T-360 `/models add` on hardware: warn when the chosen GGUF will not fit free RAM/VRAM (sizes are already read from the repo), and suggest a smaller quant
- [ ] T-361 Model presets per persona: `persona.model = { route, id }` for hosted routes, surfaced in `/agents`, so a reviewer persona can run on a stronger model than the worker
- [ ] T-362 Per-route price table for `/cost` (operator-written, never guessed — challenge #3 in `07-COMMAND-LAYER.md`)
- [ ] T-363 `/workspace <dir>` — point the agent's working directory (and so the `workspace` sandbox root) at another project instead of this repo
- [ ] T-364 Stop reading the adapter's `env-api-keys.js` by file path once the substrate exposes provider key names through a public seam (ADR-0010 consequence)
- [ ] T-366 Windows: sandboxed PowerShell runs in ConstrainedLanguage (restricted token), so .NET type creation fails — including the substrate's own UTF-8 preamble. Measure what an API model can still do under `workspace`, and report upstream if the preamble should degrade gracefully
- [ ] T-365 Tests: `parseRef`, `effectiveRoute` precedence, catalog-route patch rendering, `.env` parsing — plain node scripts under `scripts/test/`

## Launcher & branch integration
- [ ] T-372 Boot the REPL and the web UI from the merged `epic` tree, then run `off` against a real running web UI; also exercise `off` through the Windows PowerShell wrapper. A second checkout must not be booted until T-336 is fixed
- [ ] T-380 Single `verness` command: expose the launcher as a `bin` (package.json `"bin": {"verness": "scripts/verness.mjs"}` + shebang; `pnpm link -g` / install doc) so `verness <subcommand>` replaces calling turn_on.sh/.ps1/.cmd; keep turn_on.* as thin shims (Node-on-PATH check) and update 06-SETUP-AND-LAUNCHER + RUNBOOK
- [ ] T-381 Model-less start: `verness --no-model` (alias `--no-start`) enters the REPL without booting a model/substrate — settings, /persona, /config, /help and other Tier L commands only; model-requiring commands and free-text tasks print a hint to restart without the flag. Default start unchanged (with model)

## M2 follow-ups (deferred from the M2 final review, `@verness/contracts`)
- [ ] T-382 Verify Node 22.19 exactly: `npx -y node@22.19 --test scripts/test/smoke.test.mjs`, and check whether the launcher path prints the type-stripping `ExperimentalWarning`; if it does, suppress that one class in the `turn_on.*` wrappers or document it
- [ ] T-383 Friendly error on old Node: the static `.ts` import chain (`verness.mjs` → `lib/personas.mjs` → contracts) fails at link time before `nodeOk()` runs; make it a lazy `await import()` after the version check (or check the version in `turn_on.*`)
- [ ] T-384 `packages/contracts/package.json` `files` still lists `lib/`, which is never built; drop it or add a build step
- [ ] T-385 Enforce `<= 8` options when a decision validator lands (today only a comment in `decision.ts`)
- [ ] T-386 A `.d.ts` for `scripts/lib/util.mjs` so `packages/contracts/test/persona.test.ts` can drop its `@ts-expect-error` on the `parseJsonc` import
- [ ] T-387 Validator edge minors: `__proto__` keys in `tools.approval` / `decisions.apply` are dropped silently; `isObject` accepts non-plain objects; duplicate array entries are not flagged; `name: ''` is accepted
- [ ] T-388 Owner: delete the inline `data-analyst` definition in `verness.config.json` (~line 83); it is shadowed by `personas/data-analyst.json`

## Web commands bridge — design in `docs/superpowers/specs/2026-09-26-web-commands-bridge-design.md`
Goal: the launcher's quick-tools appear in the web UI's `/` menu (via dsh-commands) and run through
`node scripts/verness.mjs <name>`. Per-persona `tools.allow`/`deny` stay unenforced (M4, T-116) and are out of scope.
- [ ] T-374 Spike: confirm that registering on cordis `ready` leaves `/model` to the substrate, and that headless does not mount the plugin
- [ ] T-375 `node scripts/verness.mjs --list-commands` emits the quick-tools as JSON; a quick-tool can opt out with `web: false`
- [ ] T-376 `@verness/commands` dsh plugin: register each listed quick-tool with dsh-commands, and a handler that runs it through the launcher
- [ ] T-377 Tests: the `--list-commands` shape, `web: false` filtering, plugin registration and disposal (HMR-safety), the handler's exit-code/output path
- [ ] T-378 ADR-0011 for the bridge, and docs (`06-SETUP-AND-LAUNCHER.md`, `07-COMMAND-LAYER.md`)

## Parking lot (not scheduled)
- Memory layer (`ctx.memory`), Hermes-style two-file snapshot; decide after M5
- MCP tool policy integration; Spark/Snowflake/BigQuery/ClickHouse adapters
- CLI `verness run --persona X --mode adaptive "..."` (today: `dsh` + profile) (see T-380)
- Real Jev API credentials; CI (GitHub Actions) now that M2 has landed (`pnpm test`, `pnpm typecheck`)
