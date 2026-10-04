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
> shadow records; **done 2026-09-26**), then T-220 (**done 2026-09-26**) → T-221 and T-222 (**done 2026-09-26**) → T-223. Other workstreams wait unless they block it.

---

## P0 — Safety
- [ ] T-473 **P0** Block irreversible commands: `rm -rf`, recursive deletes, disk formatting, `git reset --hard`/`clean -f`/`push --force`, SQL `DROP`/`TRUNCATE`, remote code piped to a shell, and the like are shown to the user before they run and confirmed twice — for the model's shell tool calls (plugin on `tools/pre-execute`) and for the REPL's own `!cmd`; no terminal and no approval channel means denied, never allowed

## WS-A — Launcher, command layer, REPL (plan `01-launcher-commands.md`)

Tier L — local, zero tokens

TUI

Launcher lifecycle
- [ ] T-124 Verify `up`/`down` on macOS and Linux (only Windows has been measured)
- [ ] T-436 Live REPL check of `/btw` and `#` from the main checkout (only unit-tested so far): pipe the lines `/btw use metric units`, `/btw`, `# amounts in EUR`, `#` into `node scripts/finess.mjs`, then send one real task and confirm both blocks reach the model
- [ ] T-437 Exercise the `pre-push` hook through a real `git push` with `core.hooksPath scripts/hooks`, on Windows (Git for Windows `sh`) and macOS

## WS-B — Teams and multiple tasks (plan `02-teams.md`)
- [ ] T-171 Measure before promising parallelism: time the same team at concurrency 1 and 2 on the local model and record the numbers in `04-PROGRESS.md`
- [ ] T-230 Team task router: pick the owning persona for a task with no `member` with one Laya `choice` over persona ids (shadow first, see WS-E). With more than 8 personas, build it as T-396's two-stage routing
- [ ] T-172 Re-implement team dispatch on `ctx.subagents` + `ctx.jobs`, retiring the launcher loop (after WS-G M7)

## WS-C — Pet (plan `03-pet-animation.md`)
> **State (v0.2.0):** one drawing — Ness is a baby sheep from the block sprite, moods
> `happy | sleepy | worried`, with `petAnimFrames` and a one-shot boot animation `animatePet`
> (`scripts/lib/pet.mjs`). `scripts/test/pet.render.test.mjs` is a mood-agnostic `node:test` suite over
> `PET_MOODS` (T-338); the off switch `animationAllowed` + `pet.animate` exists (T-335g), but nothing
> animates after boot yet. The tasks below are written against frame lists, not a drawing.
- [ ] T-335 Animations *(remaining: animating while the prompt is open; the 2026-10-02 attempt broke the line editor on tab and was reverted. The boot and `/pet` one-shot animation is done)*
  - [ ] T-335d Talking *(blocked)*: `dsh` streams straight to stdout during a turn, so nothing may draw then. Re-scoped: a one-line status spinner once the REPL reads the `--json` event stream, as `/loop-task` already does
- [ ] T-334 Show running `/loop-task` and `/team` runs as live workers (pid + heartbeat file per run)

## WS-D — Loop, dashboard, observability (plan `04-loop-dashboard-observability.md`)
Autonomous task loop
- [ ] T-326 Let the decision model give the round verdict (continue/retry/complete/escalate) once T-223 clears; shadow it until then

Static dashboard
- [ ] T-272 *(remaining part)* Filter by persona: the session logs do not record the persona, so record it first (the route filter is done)
- [ ] T-273 `--watch`: rebuild on change

Standalone dashboard service (deferred by request; do after T-271..T-273)
- [ ] T-279 Decide the read path (in-process `lib/sessions.mjs` vs `@deepseek-ai/dsh-session-query`). Measure first
- [ ] T-274 Own process `finess-dashboard`, independent of any REPL; the harness works with it down
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
- [ ] T-392 **Operator step, not code**: label at least 50 shadow records per question with `/decisions-data label` (about 200 is better). Record the count and date in `04-PROGRESS.md`. T-221..T-223 only mean something after this

Composition and routing
- [ ] T-262 Gated rollout, one question at a time, high-confidence band only: `pipeline`, then `level`, then `tier`

First real uses

Deferred / investigate
- [ ] T-241 `laya-ts` in-process provider over the split ONNX export (not on npm; vendor or build)
- [ ] T-242 Fine-tune on our labelled decisions once T-220 has a set

## WS-I — Persona catalog: ten new personas (plan `09-persona-catalog.md`, full specs there)
Catalog-wide (do T-393 first)
- [ ] T-396 Two-stage persona routing for T-230: family, then persona within the family, as two `choice` questions in one call (each ≤ 8 options; 17 personas would break T-385's limit), shadow first as in WS-E

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
- [ ] T-043 Persona files used by the plugin: `data-analyst`, `data-scientist`
- [ ] T-044 Tests including one REAL-composition boot test

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
- [ ] T-092 Audit trail as session events + projection
- [ ] T-093 PII policy on `fs/*-intent` and tool arguments
- [ ] T-094 `ctx.invariants` registrations for our subsystems
- [ ] T-233 Tool-risk gate on `tools/pre-execute`, modelled on `packages/experimental/auto-review`. Blocked on T-223

Tier S commands: surface existing substrate capabilities, never rebuild them
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
- [ ] T-359 Setup wizard: `./turn_on.sh setup --api` asks for a provider, writes the key to `.env` with hidden input, and runs `/api use` — first-run to working hosted agent in one step
- [ ] T-364 Stop reading the adapter's `env-api-keys.js` by file path once the substrate exposes provider key names through a public seam (ADR-0010 consequence)
- [ ] T-366 Windows: sandboxed PowerShell runs in ConstrainedLanguage (restricted token), so .NET type creation fails — including the substrate's own UTF-8 preamble. Measure what an API model can still do under `workspace`, and report upstream if the preamble should degrade gracefully

## Launcher & branch integration
- [ ] T-372 Boot the REPL and the web UI from the merged `epic` tree, then run `off` against a real running web UI; also exercise `off` through the Windows PowerShell wrapper. A second checkout must not be booted until T-336 is fixed

## Web commands bridge — design in `docs/superpowers/specs/2026-09-26-web-commands-bridge-design.md`
Feasibility checked 2026-09-27: `@deepseek-ai/dsh-commands` (`ctx.commands.register`) ships in dsh 0.1.7-rc.2, so the design holds; `/model` and `/help` stay the substrate's own.
Goal: the launcher's quick-tools appear in the web UI's `/` menu (via dsh-commands) and run through
`node scripts/finess.mjs <name>`. Per-persona `tools.allow`/`deny` stay unenforced (M4, T-116) and are out of scope.

## Web UI branding: FiNess logo and titles in the browser UI
Checked 2026-09-26 against `@deepseek-ai/dsh-*@0.1.7-rc.2`. The sidebar mark and name and the
conversation-hero mark are **slots** that `dsh-client-ui-brand-official` occupies; its README says a
deployment with another identity "leaves this package out and composes another package that
occupies the sidebar slots — and the hero slot". The tab title and favicons are build-time
(`DSH_CLIENT_TITLE`, `dsh-web-frontend/dist`) and not configurable in the prebuilt frontend.
- [ ] T-430 Replace the web UI's current look (the `dsh-web-all` skin center default and the substrate theme) with a FiNess skin: pick the palette and fonts, ship it as a skin/preset the skin center can apply by default (or as theme tokens in T-398's brand package), light and dark. Done: `./turn_on.sh web` opens in the FiNess skin on a fresh profile, on macOS and Windows; the owner approves the look

## Launcher follow-ups from the web bridge (ADR-0011)

## Follow-ups from the 2026-10-02 round
- [ ] T-440 Live check of `@finess/tool-hints` (T-438): run a session on the local 0.6B model and on a 4B+ model, then compare `/dashboard` tool failures before and after; the hints are unit-tested only
- [ ] T-442 Watch the boot animation in a real terminal (Windows Terminal, conhost, Terminal.app): frames overwrite in place, the cursor comes back, typing during it leaves nothing behind
- [ ] T-443 `/stats` in the REPL has no `--watch` (CLI only); decide whether a watching quick-tool fits the prompt

## Follow-ups from the 2026-10-02 third round
- [ ] T-449 Live check with a running model: a `/workspace` turn and its continuation, `@path`/`@url`/`!!` reaching the model, `/recipe` runs, `/delegate`, a persona `model` preset, and the 30 s finish notification (all unit-tested; the engine was down: `OLLAMA_MODELS` points at a missing drive)
- [ ] T-450 Real-terminal check of the wrapped editor (T-302): conhost wrap at the last column, drag-resize with the dropdown open, emoji sequences
- [ ] T-451 First CI run (T-446) after the next push: confirm all six jobs, then require it on `main`

## Follow-ups from the 2026-10-03 waves
- [ ] T-467 `@finess/tool-policy` live check: boot a session per persona and confirm denied calls come back with the policy reason; check whether `ask` should reach an approval channel in the REPL
- [ ] T-468 Enforce budgets inside the substrate (`llm/stream`), so one long task or a `--parallel` team batch cannot overshoot between checks (T-091 checks only before a task)
- [ ] T-469 The one-shot `finess "<task>"` path still calls dsh directly; move it onto the pipeline executor (T-254) for headless profiles
- [ ] T-470 Install `laya[mcp]` in the decision venv and confirm the `decisions.mcp` row exposes the tools in `/tools` (T-240; the entry point `python -m laya.mcp.server` is confirmed in the installed package)
- [ ] T-471 Web UI brand plugin (T-398) seen in a browser: sidebar mark and name, hero mark, tab title; remove the `ui-brand-official` row if the substrate mark still shows
- [ ] T-472 The sync `dsh()` path (spawnSync with `timeoutMs`) kills only its direct child; move it onto the tree kill of T-433

## WS-P — Performance between chats (plan `14-PERFORMANCE-PLAN.md`)
Measured 2026-10-03: ~3 s to boot a new dsh per message, 91% of generated text is reasoning, a 2.3 s title LLM call per new session, ~20 KB request per step, ~1 s awaited decision call. Target: < 1.5 s to first token on the next message.
- [ ] T-455 Per-turn trace: launcher stage timestamps + substrate step timings into `.finess/perf.jsonl`; `/perf` waterfall and p50/p95; dashboard panel
- [ ] T-456 `scripts/tools/bench.mjs`: fixed prompts x N on the active route, p50/p95 per stage; launcher-only part as a CI regression gate
- [ ] T-457 `model.reasoning: off | on | auto` (auto = off under 4B), rendered as the model's no-think switch
- [ ] T-458 No session-title LLM call on local routes (keep the first-prompt fallback title, or use a cheap hosted model)
- [ ] T-459 Keep the model resident while FiNess runs (`model.keepAlive`, default 30m); `/down` and `/off` still unload
- [ ] T-460 Shadow decision call in parallel with the task, never awaited before the spawn
- [ ] T-461 Launcher pre-task diet: config read once per turn, mtime-cached session listing and budget usage, concurrent snapshot/attach/probe, skip the probe after a recent answer; < 100 ms before the spawn
- [ ] T-462 Persistent dsh session for the REPL instead of one process per message (research the substrate's stdio/ACP app, SDK client or web API first, with file:line); cancel aborts the turn; fallback to spawn-per-message
- [ ] T-463 Smaller requests: offer only the persona's permitted tools (T-234 `tools.restrict`), trimmed descriptions for small models
- [ ] T-464 Stable prompt prefix for the engine's prompt cache: system prompt and tools byte-identical across turns, volatile context last; verify with `prompt_eval_count`
- [ ] T-465 Right-size the model per task through the capability router (T-253): small fast model for chat, 4B+ or API for tool work
- [ ] T-466 Stream the first token in the terminal and web UI; judge latency by time-to-first-token

## Parking lot (not scheduled)
- Memory layer (`ctx.memory`), Hermes-style two-file snapshot; decide after M5
- MCP tool policy integration; Spark/Snowflake/BigQuery/ClickHouse adapters
- CLI `finess run --persona X --mode adaptive "..."` (today: `dsh` + profile) (see T-380)
- Real Jev API credentials; CI (GitHub Actions) now that M2 has landed (`pnpm test`, `pnpm typecheck`)
