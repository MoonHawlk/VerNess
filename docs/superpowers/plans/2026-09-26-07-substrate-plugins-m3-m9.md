# WS-G — Substrate plugins M3–M9 and Tier S commands: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Read
> `2026-09-26-00-master-plan.md`, `docs/01-ARCHITECTURE.md` and
> `docs/research/deepseek-harness-digest.md` in full before G0. Requires WS-F merged.

**Goal:** Move the capability layer from the launcher into the agent loop's own seams: decisions
(M3), personas with enforced tool policy (M4), skills (M5), model routing (M6), independent
evaluation and the supervisor modes (M7), the data plane (M8) and governance (M9). Each milestone
ends with the literal exit criteria in `docs/02-ROADMAP.md`.

**Architecture:** Each milestone is one TypeScript package under `packages/<name>/`, a Cordis plugin
that is built to `lib/`, installed into the dsh profile, and mounted by an `insert:` row that the
launcher generates from `settings.plugins`. Every package:
- registers exactly one service (`ctx.<name>`) with a `declare module '@deepseek-ai/cordis'` augmentation, or only listeners;
- attaches only through the seams in the architecture table (never edits `upstream/`);
- imports types and validators from `@verness/contracts`;
- ships unit tests, an HMR-safety test (dispose → registry clean), and **one REAL-composition boot
  test** that boots the profile with a scripted fake model (G0) and asserts the product-visible effect.

**This plan is interface-level for M3–M9 on purpose.** The substrate's exact TypeScript signatures
(`ctx.tools.register`, the `tools/pre-execute` listener's argument shape, `ctx.subagents`,
`ctx.sessionProjections`, …) live in the pinned submodule, which the plan author could not read in
this session (`upstream/deepseek-harness` was not checked out). **Task G0 Step 1 therefore
records the real signatures into `docs/research/seam-signatures.md`, and every later task's code must
be written against that file, not against memory.** Where this plan shows code, it shows *our*
side (types we own, algorithms, tests), and marks substrate calls `/* per seam-signatures.md §x */`.

**Tech stack:** TypeScript (erasable-only, as WS-F), `tsc` to emit `lib/`, `@deepseek-ai/cordis@4.0.4`,
`@deepseek-ai/dsh-*@0.1.7-rc.2` (peer, exact pins), `node:test`, the dsh CLI for boot tests,
DuckDB (M8, via its Node binding; the first real runtime dependency, justified in an ADR).

**Spec:** `docs/02-ROADMAP.md` M3–M9 exits; `docs/01-ARCHITECTURE.md` seam map; ADR-0002, 0003,
0008, 0009; `docs/research/dsh-state-and-memory-seams.md`, `dsh-mcp-and-http-seams.md`,
`capability-sources-digest.md`, `task-loop-machinery.md`.

## Global Constraints
Inherit the master plan. Also:
- **Substrate packages are linked to the runtime copy, never added as a second copy** (RUNBOOK,
  T-019). A plugin that needs `@deepseek-ai/dsh-tools` at run time gets it through
  `settings.linkedSubstratePackages`.
- Peer dependencies on `@deepseek-ai/dsh*` use the **exact** pinned version (`0.1.7-rc.2`), or the
  runtime silently skips the plugin (`skippedBundles`).
- Tool names: the substrate's schema rejects dots in some paths, and our spike uses `snake_case`
  (`verness_ping`). Use `snake_case` tool names (`decision_evaluate`, `sql_query`). The dotted names
  in `BRAINSTORM.md` are concepts, not identifiers.
- Optional tool parameters **omit** `required` (`required: false` is rejected; see PROGRESS M1).
- Every registration is a disposable effect. Nothing global survives `dispose`.
- "Model-visible means logged": any new state the model sees is a `SessionEvent` + projection,
  never a module variable.
- `docs/05-CONVENTIONS.md`: 100% per-file coverage on `src` is the upstream bar. Adopt it per
  package with `node --test --experimental-test-coverage`, and fail CI below 100% lines for `src/`.

## Review Focus
1. **Plugin silently not mounted.** `--dump-config` shows composition, not mount. Every boot test
   asserts an effect (a tool listed in `request/header`, a prompt section in `system/message`),
   never just the row.
2. **Dispose leaks.** A listener or timer left after HMR doubles on reload. Each package's HMR test
   mounts, disposes, remounts, and asserts exactly one effect.
3. **Policy ordering.** Two `tools/pre-execute` listeners (persona policy M4, evidence gate M7,
   governance M9, risk gate T-233) must compose: a deny from any wins, and `ask` asks once. One
   integration test with all four mounted (added in M9).
4. **Fail-open vs fail-closed.** If the decisions service or the governance store is unavailable:
   tool policy fails **closed** (deny with a reason), routing fails **open** (keep the default
   model). Each package states which and tests it.
5. **Windows.** The boot test runs through the shell-free `dsh()` path and passes on Windows
   (`turn_on.cmd`) as well as macOS/Linux.

---

## G0 — Foundation: seam signatures, build, install, boot test (do first)

### Task G0-1: Record the real seam signatures

- [ ] `git submodule update --init --depth 1 upstream/deepseek-harness`. Confirm the pin: `git -C upstream/deepseek-harness describe --tags` → `dsh-v0.1.7-rc.2`.
- [ ] Create `docs/research/seam-signatures.md`. For **each** item below, copy the exact TypeScript
  signature (types included) and the file:line, and add a 2-line usage note from an in-tree example.
  §1 `Service` subclass + `declare module` (cordis) · §2 `ctx.tools.register` / `defineTool` /
  `ToolDefinition` · §3 `tools/pre-execute` listener signature, its `next()`, and how deny/ask is
  expressed · §4 `ctx.tools.guard()` · §5 `ctx.approval` request · §6 `system-prompt/assemble`
  listener and section shape · §7 `agent/request` and `agent/request-error` payloads (where
  provider/model are chosen) · §8 `agent/pre-step`, `agent/turn-stopping` · §9 `ctx.llm` structured
  output call · §10 `ctx.skills.registerProvider`, `SkillProvider`, `SkillCandidate` · §11
  `ctx.subagents` start + `SubagentProvider` · §12 `ctx.goals` API + `goal/changed` · §13
  `ctx.jobs.start` · §14 `ctx.sessionProjections.register` + defining a `SessionEvent` type (and the
  generated catalog step) · §15 `ctx.storage` · §16 `ctx.invariants.register` · §17
  `fs/write-intent`, `fs/edit-intent` · §18 `llm/stream`, `tools/execute` (around-dispatch)
  · §19 `ctx.agentPresets` · §20 the in-tree `packages/experimental/auto-review` flow (for T-233)
  · §21 `packages/core/tools/src/index.ts:701-711` (for T-234) · §22 upstream `docs/testing.md`
  and any `test-support` package that boots a composition in-process.
- [ ] Commit: `docs(research): exact seam signatures at dsh-v0.1.7-rc.2`

### Task G0-2: TypeScript plugin build and install pipeline

**Files:** `packages/tsconfig.base.json`; `scripts/verness.mjs` (`cmdSetup` builds each TS plugin before `pnpm add file:`); `docs/RUNBOOK.md`

- [ ] `packages/tsconfig.base.json`: the WS-F compiler options, plus `"rootDir": "src"`,
  `"outDir": "lib"`, `"declarationDir": "lib/types"`, `"declaration": true`,
  `"rewriteRelativeImportExtensions": true`, `"noEmit": false`. Each package `extends` it.
- [ ] Each plugin package has `"build": "tsc -p tsconfig.json"` and a `package.json` shaped like
  `packages/spike/package.json` plus `main/types/exports` for `lib/`.
- [ ] In `cmdSetup`, for every entry of `settings.plugins` with a `path` whose `package.json` has a
  `build` script: run `pnpm --dir <path> run build` (verify that `lib/index.js` exists afterwards; do
  not trust the exit code, per T-115), then `pnpm add file:<abs>` as today. Because pnpm hardlinks
  file dependencies, **new** files under `lib/` need the `add` repeated. `sync` does not rebuild;
  document `./turn_on.sh setup` as the command after changing a plugin.
- [ ] `@verness/contracts` is a runtime dependency of the plugins (validators). Add it as
  `"dependencies": { "@verness/contracts": "workspace:*" }` and verify that the profile install
  resolves it. If `file:` installs do not follow workspace protocol, build contracts first and add
  it to the profile explicitly with `pnpm add file:<repo>/packages/contracts` in `cmdSetup`, before
  the plugins.

### Task G0-3: A scripted fake model and the boot-test harness

**Why:** boot tests must be deterministic and free. A local 0.6B model is neither.

**Files:** `packages/test-llm/` (plain JS is fine; it is test-only), `scripts/test/lib/boot.mjs`

- [ ] `@verness/test-llm`: a plugin that registers an LLM adapter for route `verness-script`
  (`ctx.llm.registerAdapter`, per seam-signatures §9). It replays a **script** from
  `VERNESS_TEST_SCRIPT` (a JSON file): an array of turns, each either
  `{text: "..."}` or `{toolCall: {name, arguments}}`, then `{text}`. The adapter must follow the
  stream protocol in the digest §3: `usage` before `finish`, `argumentsDelta` as raw JSON, and
  honour `options.signal`.
- [ ] `scripts/test/lib/boot.mjs` exports
  `bootOnce({plugins: string[], script: object[], task: string, extraPatch?: string}): Promise<{code, out, events}>`.
  It creates a temp `DSH_HOME`, a profile `verness-test` from the `headless` template, installs
  `@verness/test-llm` + the given plugins (built), writes a patch that routes `agent-default-model` to
  `verness-script`, runs `dsh --profile verness-test --json <task>` with the shell-free runner, and
  returns the parsed `--json` events plus the session events (via `lib/sessions.mjs` with the temp
  `DSH_HOME`). This is slow (an install per call), so cache the profile per plugin set within one
  test run.
- [ ] First boot test: `@verness/spike` with the script `[{toolCall: {name: 'verness_ping', arguments: {note: 'hi'}}}, {text: 'done'}]`.
  Assert a `tool/result` for `verness_ping` containing `mounted: hi`. **This proves the harness.**
- [ ] Mark boot tests with `test('...', { skip: process.env.VERNESS_BOOT_TESTS !== '1' && 'set VERNESS_BOOT_TESTS=1' }, ...)`
  so `npm test` stays fast; add `"test:boot": "VERNESS_BOOT_TESTS=1 node --test ..."` (use
  `cross-env`-free syntax: a tiny `scripts/run-boot-tests.mjs` that sets the env and spawns
  `node --test`, so it works on Windows).
- [ ] Commit: `test: scripted fake model and a real-composition boot harness`

---

## M3 — `@verness/decisions` (T-030..T-037)

**Service:** `ctx.decisions: DecisionService`

```ts
// packages/decisions/src/service.ts (our side; Service base per seam-signatures §1)
import type { DecisionModel, DecisionRequest, DecisionResult } from '@verness/contracts'

export interface DecisionPolicyEntry {
  key: string                         // question key, e.g. 'pipeline'
  chain: string[]                     // provider ids in order, e.g. ['rules', 'systemone', 'llm']
  bands: { high: number, low: number }
  apply: boolean                      // operator consent (and the gate must pass)
}

export interface DecisionService {
  register(model: DecisionModel): () => void            // returns disposer; used via ctx.effect
  providers(): string[]
  decide<O extends string>(req: DecisionRequest<O>): Promise<DecisionResult<O>>   // resolves the policy for req.key and runs the composite
}
```

Tasks (each: failing test → implement → commit):
- [ ] **T-030** Package skeleton + `DecisionService` + augmentation `interface Context { decisions: DecisionService }`. HMR test: register a provider, dispose the registering fiber, `providers()` no longer lists it.
- [ ] **T-031** `RuleDecisionProvider`: declarative rules from config: `[{key, when: {contains?: string[], maxWords?: number, minWords?: number}, then: string}]`, first match wins, `reason_code: 'rule_match'`, `confidence: 1`. No match → `decision: undefined`, `reason_code: 'fallback_rules'`. Port `ruleRoute()` from `scripts/lib/decisions.mjs` as the default rule set and **test that both give identical answers on 30 sample tasks** (put the samples in a shared fixture JSON that both test suites read).
- [ ] **T-034** `SystemOneProvider` (replaces the "JevProvider stub"): the same wire as `askDecision` (bearer auth, 503 backpressure, ≤ 4 in flight via a semaphore), `readAnswer` rules including invalid-answer handling and temperatures from `.verness/decisions/temperatures.json` (path via config). Laya and Jev are two config entries, not two classes (T-205).
- [ ] **T-032** `LlmDecisionProvider`: asks `ctx.llm` for structured output (seam-signatures §9) with a JSON schema `{decision: enum(options), confidence: number}`. Its confidence is **not calibrated**: mark `capabilities.calibrated = false`, and the composite caps it at the `low` band so it can never apply a decision on its own confidence.
- [ ] **T-033** `CompositeDecisionModel`: walks `chain`. Rules decide when they match; otherwise the next provider, whose answer applies only in the `high` band **and** when `apply && gatePassed(key)`. Below `low`, escalate to the next provider. Records `ms` and provider per hop. Port WS-E Task 5's tests one to one.
- [ ] **T-035** `DecisionRouter`: resolves a `DecisionPolicyEntry` for a key from plugin config, with defaults `chain: ['rules']`, `apply: false`. The gate is read from a file WS-E writes (`.verness/decisions/gate.json`: `{key: {pass, why, hash}}`). The plugin never computes metrics itself.
- [ ] **T-036** Tool `decision_evaluate` (seam-signatures §2): parameters `question` (key), `options` (string array, 2–8), `state` (string). Returns `{decision, confidence, reason_code, provider}`. Boot test: a script that calls the tool with rules-only config gets a `rule_match` result.
- [ ] **T-037** Coverage 100% on `src`; composite fall-through tests; HMR test; boot test.
- [ ] **Exit (roadmap M3):** rules-only decisions need no network (test with `fetch` stubbed to throw); the composite falls through on low confidence; the HMR test passes; every result carries `{decision, confidence, reason_code, provider}`. Then retire the launcher's copy: `shadowRoute` calls the tool through the substrate **only** if that is simpler. Otherwise keep the launcher copy and delete nothing. Record the decision in PROGRESS.

## M4 — `@verness/personas` (T-040..T-044, T-116, T-154, T-155, T-234)

- [ ] **T-234 first** (`packages/tools-restrict`): the `ctx.tools.restrict({allow, deny})` primitive the architecture says both MCP filtering and persona policy need. Read seam-signatures §21. It is either a thin wrapper over the existing registry filter or a `tools/pre-execute` listener plus a filter on the tool list offered in `agent/request`. Test: a denied tool is not offered **and** is refused if called anyway.
- [ ] **T-040** Loader: reads `personas/*.json` from a configured directory with `validatePersonaFile` (contracts). The registry is `ctx.personas` with `active(): Persona`, `get(id)`, `list()`. The active id comes from plugin config, which the launcher's `writePatch` writes from `.verness/state.json`, so `/persona` keeps working unchanged.
- [ ] **T-041** `system-prompt/assemble` listener (§6): adds a `persona` section (identity + prefix) and a `persona-guidance` section (suffix + tips). Then remove the launcher's `personaPrefix`/`personaSuffix` injection from `writePatch`, **in the same commit**, so the text is never injected twice. Boot test: the `system/message` contains the persona's prefix exactly once.
- [ ] **T-042** Tool policy on `tools/pre-execute` (§3) + `ctx.approval` (§5): `deny` → refuse with `persona <id> denies <tool>`; `approval[tool] === 'ask'` → one approval prompt; `allow` non-empty → anything not in it is denied. **Fail closed** if the persona failed to load (deny everything except read-only tools, with a reason naming the broken file). Uses T-234 for the offered-tool filter.
- [ ] **T-116** Flip `describePersona`'s labels for tools from `[recorded — enforced from M4]` to `[enforced]` once T-042 is merged and its boot test passes.
- [ ] **T-043** `personas/data-analyst.json` and `data-scientist.json` exist (WS-F T-164). Here: a boot test per persona that a denied tool is refused with the persona-attributed reason.
- [ ] **T-044** Tests: unit (policy matrix: allow/deny/ask × empty/non-empty allow), HMR, REAL-composition boot tests for "denied tool refused", "ask prompts once" (script the approval answer via `approval/request` in the test profile), "switching persona changes the prompt and the tool set".
- [ ] **T-154** `/tools` shows `allowed | denied | ask` per offered tool for the active persona (read the policy from the persona file with the same contracts validator the plugin uses, so both agree).
- [ ] **T-155** `/permissions`: the active persona's effective policy as a table, with `[enforced]` and the plugin version.
- [ ] **Exit (roadmap M4):** denied tool refused with a persona-attributed reason; `approval: ask` triggers exactly one prompt; switching persona changes the assembled prompt and the tool set, all proven by boot tests.

## M5 — `@verness/skills` (T-050..T-054)

- [ ] **T-050** Spec doc `docs/11-SKILLS.md`: directory layout `skills/<area>/<id>/SKILL.md` (front-matter = `SkillMetadata` from contracts) + optional `metadata.yaml`… **decision: no YAML**, so front-matter only, parsed as a small `key: value` / list subset. Document the subset and reject anything else with a `line:col` diagnostic.
- [ ] **T-051** Loader + trigger matching (case-insensitive phrase match over the objective) + 3-tier disclosure: tier 1 = name + description always listed; tier 2 = `SKILL.md` body when a trigger matches; tier 3 = files under the skill directory opened on demand through the substrate's skill tool.
- [ ] **T-052** Bridge: `ctx.skills.registerProvider(create)` (§10) returning `SkillCandidate[]`. Reuse the substrate's `tool-skill`; do not write our own skill tool.
- [ ] **T-053** Author `skills/data/statistics`, `skills/data/sql`, `skills/research/evidence`: each ≤ 150 lines, one focused procedure, with a worked example, `requirements.tools`, `evaluators`.
- [ ] **T-054** A skill whose required tool the active persona denies is **not offered**. Unit test and boot test.
- [ ] **Exit (roadmap M5):** a matching trigger injects only the summary until the skill is viewed; a skill whose required tool is denied is not offered.

## M6 — `@verness/routing` (T-060..T-063)

- [ ] **T-060** Capability registry: route capabilities come from the plugin config (the launcher writes them from `verness.config.json` routes, which gained `capabilities` in WS-E Task 6).
- [ ] **T-061** `ModelRouter.resolve({requirements, tier?, pin?, deny?})`: port `routeModel` from `scripts/lib/routing.mjs` **with its tests**, using `capabilityGaps`/`mergeRequirements` from contracts.
- [ ] **T-062** Listener on `agent/request` (§7) sets provider/model before the prompt commits, and appends a `routing/decision` session event (§14) `{requirements, tier, eligible, chosen, reason}`. **Fail open:** on any error keep the request's default and log `reason: 'router error: …'`.
- [ ] **T-063** Tests: eligibility, pinning, and fallback on `agent/request-error` (§7): when the chosen route errors, retry once on the next eligible route and log it. Boot test with two scripted routes, one that errors.
- [ ] **Exit (roadmap M6):** no `if task === 'coding'` anywhere (a test greps `packages/routing/src` for string comparisons on task types); the routing decision is logged with its inputs; a pin is obeyed.

## M7 — `@verness/evaluation`, `@verness/supervisor` (T-070..T-075, T-157, T-160)

Read `docs/research/task-loop-machinery.md` first: `/loop-task` already implements the launcher
version of most of this, and its lessons (parse `--json` events, not prose; no-tool stall; fresh-
context verification) apply unchanged.
- [ ] **T-070** `ctx.evaluators` registry of `Evaluator` (contracts).
- [ ] **T-071** Evaluator **subagent** (§11): fresh context, read-only tools, first line `PASS` or `NEEDS_WORK`, then reasons. It receives objective + evidence + artifacts, **never** the transcript. Test: the subagent's start request contains no generator messages.
- [ ] **T-072** Evidence gate on `tools/pre-execute`: a completion-claiming tool (e.g. the goal-complete tool, per §12) is refused unless ≥ 1 `Evidence` was recorded in this turn (default-fail, cwc pattern).
- [ ] **T-073** Supervisor modes on `agent/pre-step` + `agent/turn-stopping` (§8): `standard` (no-op), `agent` (inject a plan-first instruction on step 1), `decision` (ask `ctx.decisions` for continue/retry/complete/escalate on turn-stopping and act only if the policy applies it), `adaptive` (a `decision` that also asks the M8 planner for a deterministic reduction first). Port WS-E Task 8's verdict mapping.
- [ ] **T-074** Continuation policy beside `goal-round-driver`, **not** replacing it: `max_iterations`, `escalation.after` N consecutive `NEEDS_WORK`, stopping provider = `ctx.decisions` key `verdict`.
- [ ] **T-075** Progress projection (a `task/progress` event + projection folding steps/evidence/verdicts) and a resumability boot test: kill the process after round 2, resume with `--session-id`, and assert the projection continues from round 2.
- [ ] **T-157** `/goal` surfaces `ctx.goals` (via a tool call in a one-shot run, or by reading the goal projection from the session log, whichever the seam allows; see §12).
- [ ] **T-160** `/evaluate [evaluator]` runs an evaluator against the last session's final answer and evidence.
- [ ] **Exit (roadmap M7):** the evaluator never shares the generator's context; `max_iterations`/`escalation.after` are respected; a failed evaluation produces a retry with a `reason_code`, never a silent success. Then WS-B T-172 is unblocked.

## M8 — `@verness/data` (T-080..T-085)

- [ ] **ADR-0010 first:** "DuckDB is the first runtime dependency." Record why (in-process, no server, reads Parquet/CSV, a 10M-row aggregate in seconds), the package (`@duckdb/node-api`), its native-binary footprint per OS, and the fallback (a `QueryEngine` over `node:sqlite` for tests).
- [ ] **T-080** `ctx.dataEngines` + `DataSource {id, kind, uri, sizeHint?}`, `QueryEngine {id, canRun(source, op): boolean, run(op, source, opts): Promise<ResultSummary>}`, `ArtifactStore {put(bytes, meta): ArtifactRef}`. `ResultSummary` = `{rows: number, columns: {name, type}[], sample: object[] (≤ 20 rows), stats?: …, artifact?: ArtifactRef}`. **Raw result rows never go to the model beyond `sample`.**
- [ ] **T-081** DuckDB adapter. Test with a generated Parquet file of 100k rows in a temp dir.
- [ ] **T-082** Tools `data_inspect | data_profile | data_sample | data_schema | data_aggregate`: parameters name a source id and an operation; the engine is chosen by `canRun` and `sizeHint`, never by the model (roadmap exit).
- [ ] **T-083** Tools `sql_query | sql_explain | sql_validate`: read-only by default. Any statement that is not `SELECT`/`WITH`/`EXPLAIN` (parsed with DuckDB's own `EXPLAIN`, not a regex) requires approval through the M4 policy (`approval: {sql_query_write: ask}`).
- [ ] **T-084** Scans estimated above N seconds run via `ctx.jobs.start` (§13), and the tool returns a job id immediately. The summarisation contract is tested: a 1M-row result → `ResultSummary` ≤ 8 KB serialised.
- [ ] **T-085** Demo `scripts/demo/progressive-reduction.mjs`: generate a synthetic 10M-row transactions Parquet (seeded), run `aggregate → filter → sample → (decision rank) → LLM on ≤ 50 rows`, and record in PROGRESS the rows and tokens at each stage.
- [ ] **Exit (roadmap M8):** a 10M-row local dataset is profiled and aggregated with no raw rows in the prompt (assert on the session's `request/header` payload size); the engine choice comes from the planner.

## M9 — `@verness/governance` (T-090..T-094, T-233)

- [ ] **T-090** Policy model: RBAC (role → allowed personas/tools) + ABAC conditions (`{attr, op, value}` over `{user, persona, tool, args, time}`), loaded from `governance.json`, validated by a contracts validator (add it to WS-F's package in this task).
- [ ] **T-091** Budgets: tokens (from `usage` on `llm/stream`, §18), cost (the operator's `pricing` table only, never guessed), wall time (`tools/execute` around-dispatch). Exceeding a budget ends the task with status `escalated` and a `budget_exceeded` reason, **not a crash** (roadmap exit).
- [ ] **T-092** Audit trail: an `audit/entry` session event per policy decision, approval and budget event, plus an `audit` projection. Test: from the session log alone, reconstruct who/what/why for a completed task (roadmap exit).
- [ ] **T-093** PII policy on `fs/write-intent`, `fs/edit-intent` (§17) and on tool arguments: detectors for e-mail, phone, IBAN, card numbers (Luhn), and national IDs from config; action `redact | ask | deny`. Test each detector and its false-positive guard.
- [ ] **T-094** `ctx.invariants.register` (§16) for our subsystems: persona loaded ⇒ policy listener mounted; routing decision event ⇒ the request used the chosen route; audit entry for every deny.
- [ ] **T-233** Tool-risk gate modelled on `packages/experimental/auto-review` (§20): a decision question `risk: {allow, ask, deny}` about the tool call. **Blocked on the WS-E gate for `risk`**; until it passes, shadow-log only.
- [ ] **Policy-composition integration test** (Review Focus 3): mount M4 policy, M7 evidence gate, M9 governance and the T-233 gate together; assert that a deny from any wins, an ask prompts exactly once, and the audit trail names which layer decided.
- [ ] **Exit (roadmap M9):** a budget breach ends in `escalated`, not a crash; the audit log alone reconstructs who/what/why.

---

## Tier S commands: surface, never rebuild (T-150..T-153, T-156, T-158, T-159, T-161)

Each is one launcher command file. Before writing one, find the upstream capability (seam-signatures
or `--dump-config`) and prefer invoking what exists: a substrate CLI flag, an existing tool, or
reading its projection from the session log.

- [ ] **T-150 `/todos`**: read the `ctx.todo` projection's events from the latest session log and print the list. Test with a fixture log containing todo events (take real event names from a session where the model used the todo tool).
- [ ] **T-151 `/compact`, `/context`**: `/context` prints the size of the assembled prompt (from the last `request/header`: system chars, message count, tool count, and tokens if reported). `/compact` triggers the substrate's compaction for the current session if the CLI exposes it; if not, record that and leave `/compact` unbuilt.
- [ ] **T-152 `/export`**: run the substrate's session-log export (`dsh-session-log-export`) for the current session to `exports/<session>.md`.
- [ ] **T-153 `/mcp`**: MCP servers from the composed config (`--dump-config` rows for MCP) and their tool filters. Read-only.
- [ ] **T-156 `/hooks`**: mounted listeners per event. Needs a small debug plugin exposing `ctx` event listener counts through a tool `verness_hooks`; one-shot run → print. Only if the seam allows introspection; otherwise document why not.
- [ ] **T-158 `/rewind`**: **UX decision first.** Write the options in `docs/07-COMMAND-LAYER.md` (fork at turn N into a new session, vs truncate) and ask the owner. No code before the answer.
- [ ] **T-159 `/schedule`, `/jobs`**: list from the schedule/jobs projections in the session log; creation goes through the substrate's own `schedule_create` tool in a one-shot run.
- [ ] **T-161** Promote `/btw` notes to a plugin-contributed `operator/note` `SessionEvent` + projection (§14), so notes are logged and model-visible by the substrate's rules. The launcher's send-once prefix (WS-A Task 5) is removed in the same commit. Boot test: a note is present in the session log and in the assembled prompt exactly once.
