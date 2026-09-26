# 04 — Progress log (append-only, newest last)

## 2026-09-25 — M0 started
- Reference repos cloned into `.refs/` (gitignored, shallow):
  ```sh
  git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git .refs/deepseek-harness
  git clone --depth 1 https://github.com/NousResearch/hermes-agent.git .refs/hermes-agent
  git clone --depth 1 https://github.com/anthropics/cwc-long-running-agents.git .refs/cwc-long-running-agents
  ```
- Research digests written: `docs/research/deepseek-harness-digest.md`,
  `docs/research/capability-sources-digest.md`. (T-001, T-002)
- Version reality check (relevant to T-006): upstream source tree is `0.1.7-rc.2`; npm
  `@deepseek-ai/dsh` is `0.1.5-rc.3`; `@deepseek-ai/cordis` is `4.0.4` on npm while `dsh` depends
  on `4.0.2`. The `@deepseek-ai/dsh-*` packages ARE published despite `private: true` in-tree, so
  an out-of-tree plugin can resolve them from npm.
- Plan docs 00–05 + ADRs 0001–0003 written. Integration strategy chosen by the repo owner:
  submodule + own package layer (ADR-0002). Docs language: English. (T-003, T-004)
- Toolchain on this machine: Node v24.14.0, npm 11.9.0, git 2.51.1 (Windows), Python 3.12.3.
  **pnpm is not installed** — needed for the upstream toolchain (pnpm 11.7.0 via corepack). Tracked in T-007.
- Submodule added and pinned: `upstream/deepseek-harness` @ `477b4f4` = tag `dsh-v0.1.7-rc.2`
  (`shallow = true` in `.gitmodules`, so a fresh `git submodule update --init` stays cheap). (T-005)
- **T-006 resolved — target version is `0.1.7-rc.2`.** `npm view @deepseek-ai/dsh versions` shows
  `0.1.7-rc.2` IS published (the `latest` dist-tag merely still points at `0.1.5-rc.3`). So the
  submodule pin and our npm dependency ranges can be identical: pin `@deepseek-ai/dsh*` to
  `0.1.7-rc.2` exactly, and install with an explicit version/tag rather than `latest`.
  `@deepseek-ai/cordis`: `4.0.4` — that is the version vendored in the pinned tag
  (`upstream/deepseek-harness/vendor/cordis/package.json`), and it matches npm-latest.
- Workspace scaffold only (no `pnpm install` executed, no dependencies added yet): root
  `package.json` (private, `packageManager: pnpm@11.7.0`) + `pnpm-workspace.yaml`
  (`packages/*`, `profiles/*`; the submodule is intentionally outside the workspace). (T-007)
- `docs/RUNBOOK.md` skeleton written; all unproven steps carry a `VERIFY` marker for M1. (T-008)
- **M0 complete. Next: M1 / T-010** — install `@deepseek-ai/dsh@0.1.7-rc.2`, capture
  `--dump-config` baseline, then the out-of-tree plugin spike. M1 is the go/no-go for ADR-0002.

## 2026-09-25 — M1 done: the out-of-tree plugin strategy works
- Toolchain: `corepack enable` fails on this machine (EPERM writing the Node install dir), so
  **pnpm 11.7.0 was installed with `npm i -g pnpm@11.7.0`**. pnpm is needed only because
  `dsh plugin` shells out to it. `@deepseek-ai/dsh@0.1.7-rc.2` installed globally.
  `DSH_HOME = C:/Users/totov/.dsh`. (T-010)
- Baseline composition captured (376 rows): `docs/research/dump-config.headless.txt`. (T-011)
- Spike: `packages/spike/` (plain ESM, no build step) registers `verness_ping` and appends
  `mounted`/`disposed` lines to `verness-spike.log`. Mounted through
  `profiles/verness/cordis.patch.yml` -> `insert: [{ id: verness-spike, name: '@verness/spike' }]`,
  installed with `dsh plugin --profile verness add "file:<repo>/packages/spike"`. (T-012..T-014)
- Findings worth remembering:
  - `--dump-config` proves *composition*, not *mount*. Only a real boot mounts; a failure prints
    `dsh: warning: N entry did not activate` followed by the error.
  - Tool schemas reject `required: false` — optional parameters omit `required` entirely.
  - pnpm installs a local directory dependency as **hardlinks**, so edits to existing files are
    live but new/renamed files need the `add` command re-run.
  - `@deepseek-ai/dsh-tools` must be installed into the profile for `defineTool` to resolve.
  - Peer-version gate passed with exact pins; no `compatibility.json` exemption. (T-015)
- `docs/RUNBOOK.md` is now a verified recipe. **ADR-0002 is confirmed by execution.** (T-016)
- Only blocker for a live end-to-end run: `DEEPSEEK_API_KEY` (owner-supplied). Everything up to the
  model request already succeeds.
- **Next: M2 / T-020** — `packages/contracts` (types + schemas only).

## 2026-09-25 — local-model baseline (ADR-0004) and a real integration bug
- Ollama was already installed (client 0.32.13) with its server up on `:11434` and **no models**;
  pulled `qwen3:0.6b` (522 MB). (T-017)
- No adapter of ours was needed: `@deepseek-ai/dsh-llm-pi-ai` already serves OpenAI-compatible
  self-hosted gateways, so Ollama is a hand-declared route in
  `profiles/verness/cordis.patch.yml` (`api: openai-completions`, `baseURL: http://localhost:11434/v1`,
  explicit `models` list) plus an `agent-default-model` override. A keyless route is refused
  (`PI_AI_ERROR: No API key`), so it declares `apiKeyEnv: OLLAMA_API_KEY` with any non-empty value.
- **End-to-end verified** (T-018): `dsh --profile verness "Call verness_ping with note=hello..."`
  returns `VerNess layer verness-spike is mounted: hello`. Local model -> agent loop -> our
  out-of-tree tool -> rendered result, at zero API cost.
- **Bug found and fixed (T-019) — worth remembering, it would have cost days later.** Installing
  `@deepseek-ai/dsh-tools` into the profile (needed for `defineTool`) made every tool call fail with
  `dsh: UNKNOWN: Cannot read properties of undefined (reading 'prepare')`, including built-in tools.
  Cause: `TOOL_RUNTIME_SCHEDULER` is a module-local `Symbol(...)`
  (`packages/core/tools/src/index.ts:480`). The profile copy and the runtime's own copy are two ESM
  module instances, so `ctx.tools[TOOL_RUNTIME_SCHEDULER]` read by `dsh-agent-loop` was `undefined`.
  Fix: `pnpm remove` the copy and `pnpm add "link:<global dsh>/node_modules/@deepseek-ai/dsh-tools"`
  so both resolve to one realpath. **Rule: substrate packages are linked, never added; only our own
  packages are added.** Documented in `docs/RUNBOOK.md`.
- Also noted: `pnpm` may abort with `ERR_PNPM_IGNORED_BUILDS` (`@google/genai`, `protobufjs`) while
  still recording and installing the dependency.

## 2026-09-25 — Engram installed as the cost-control layer (ADR-0005)
- `graphifyy` is a **deprecated forwarding shim**: `graphifyy@0.10.0` -> `@sentropic/graphify@0.19.0`
  -> `@sentropic/engram@0.19.0` (MIT, github.com/rhanka/engram, published 2026-09-24). Installed
  engram directly rather than a shim. (T-100)
- `engram install` writes **user-level** files only — `~/.claude/skills/engram/SKILL.md` and
  `~/.claude/CLAUDE.md`. It modified nothing in this repo.
- `engram update .` built the project graph with **zero LLM calls** (AST only): 14 nodes, 20 edges,
  3 communities, `Token cost: 0 input · 0 output`. (T-101)
- **Honest verdict:** engram's own report says `Corpus is ~15.673 words - fits in a single context
  window. You may not need a graph.` So the graph buys us nothing on this repo *today*. It is kept
  because it is free to maintain, and because the real target is the 13,850-file upstream substrate
  we currently navigate by grep — that graph must be built outside the submodule (ADR-0002), tracked
  as T-102.
- `.engram/` is gitignored for now (T-103 revisits committing `graph.json` once we have real code).

## 2026-09-25 — one setup file, one cross-platform launcher (ADR-0006)
- `verness.config.json` is now the only file to edit for day-to-day work: substrate pins, profile,
  model routes, active route, personas, tips, plugins, tools mode. JSON with `//` comments.
- `scripts/verness.mjs` (plain Node, no dependencies) does setup/start/run/sync/doctor/graph;
  `turn_on.sh`, `turn_on.ps1` and `turn_on.cmd` are thin wrappers, so Windows/macOS/Linux share one
  implementation. `profiles/<name>/cordis.patch.yml` is now GENERATED from the config and still
  committed for reviewability. `scripts/profile-sync.mjs` removed. (T-110..T-113)
- Verified on this machine: `doctor` (all green), `sync` (block-scalar persona text), `setup` (clean
  and idempotent on re-run), and a one-shot task that called `verness_ping` through the launcher.
- Two platform lessons now encoded in the launcher:
  - **Windows `.cmd` shims**: Node refuses to spawn `pnpm`/`dsh`/`engram` without a shell (EINVAL
    since 20.12). The launcher opts into the shell on Windows and quotes every argument itself,
    assembling the command line to avoid DEP0190. (T-114)
  - **pnpm exit codes lie**: `ERR_PNPM_IGNORED_BUILDS` (@google/genai, protobufjs) and peer warnings
    make `pnpm add` exit 1 after a successful install, which produced false "could not add" errors.
    Setup now verifies the outcome by reading the profile's `package.json`. (T-115)
- Personas are honest about scope: the identity text is really injected (via `system-prompt`), while
  `tools`/`skills` in the config are recorded and NOT yet enforced — that is M4 (T-116).

## 2026-09-25 — model lifecycle: up / stats / down, weights from Hugging Face (ADR-0007)
- `scripts/model.mjs` owns the local model on all platforms; the launcher exposes it as
  `./turn_on.sh up | stats | down` (also `npm run model:up|model:stats|model:down`). The duplicated
  Ollama helper inside `verness.mjs` was removed — one engine code path. (T-120, T-122)
- Weights now come **from Hugging Face**: `model.source = "hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0"`. Ollama
  is used purely as the cross-platform runner (native builds for Windows/macOS/Linux, OpenAI-compatible
  endpoint, pulls GGUF straight from a HF repo), which avoids a Python/PyTorch toolchain. (T-121)
- Verified on this machine, all three commands:
  - `up`: engine detected, server adopted, weights present, **warm in 7.5 s**, resident 10 min.
  - `stats`: resident 5.2 GiB on GPU, 596M params, family qwen3; catalogue of 2; probe **60.2 tok/s**,
    prompt eval 5732 ms, load 210 ms.
  - `down`: **5.2 GiB released, 0 models resident**; server left running because VerNess had only
    adopted it (`--force` overrides, untested here on purpose — it would kill the owner's process).
  - A harness task through the launcher then called `verness_ping` successfully on the HF model.
- Traps recorded in ADR-0007: only quants actually published in the HF repo are valid tags
  (`Q4_K_M` on that repo fails with `400 ... tag is not available`, while `Q8_0` works), and
  `ollama pull` can print `Error:` while **exiting 0** — so `up` verifies through `/api/tags`.
- `/api/ps` counts the context allocation, so a 610 MiB GGUF shows as 5.2 GiB resident. That is real
  memory held — the reason a `down` command exists at all.

## 2026-09-26 — Windows execution policy
- First real launch attempt failed on `.\turn_on.ps1`: PowerShell refuses unsigned scripts by default
  (`PSSecurityException / UnauthorizedAccess`). Nothing to do with the launcher itself.
- Documented three exits in `docs/06-SETUP-AND-LAUNCHER.md`, least-commitment first: `.\turn_on.cmd`
  (works from PowerShell too), `npm start`, or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
  `turn_on.cmd` is therefore the recommended Windows entry point, not the `.ps1`.

## 2026-09-26 — command layer planned (design only, nothing implemented)
- Wrote `docs/research/claude-code-capability-map.md`: every user-facing Claude Code capability that
  could be enumerated — slash commands, CLI flags, input prefixes, memory, settings, hooks, tools,
  subagents, skills, MCP, plan/permission modes, context management, sessions, cost/usage, IDE, SDK,
  scheduling — each mapped to launcher-local (**L**), substrate seam (**S**), persona/team (**P**) or
  not-applicable (**N**). Compiled from the assistant's own knowledge plus this session's surfaced
  listings, and flagged as intent rather than contract: re-check each name against `claude --help`
  when it is implemented.
- Wrote `docs/07-COMMAND-LAYER.md` (design) and ADR-0008 (the decision): commands are one file each
  under `scripts/commands/`, auto-discovered, zero-token by default; personas become files under
  `personas/`; teams get `teams/<id>.yaml` plus a sequential v1 runner.
- Backlog gained T-130..T-172 in five ordered groups (foundation, tier L, tier S, personas-as-files,
  teams). **T-130 is `/btw`** — the operator side-note command — specified in full.
- Three findings that shape the plan:
  - `/agents`, `/permissions`, `/output-style` and `/review` all collapse into the **persona**
    concept, which argues for finishing M4 before widening the command surface.
  - Most substrate-backed commands (`/compact`, `/export`, `/todos`, `/mcp`, `/rewind`) already exist
    upstream and need *surfacing*, not building — rebuilding one is the cheapest way to waste a week.
  - **Open blocker for `/cost` and `/usage` (T-133):** session logs are `session.v4.jsonl.zstd`,
    concatenated zstd frames. `zstdDecompressSync` decodes only the first frame (a 15 KB log read as
    a single event) and a stream attempt aborted. Prefer `@deepseek-ai/dsh-session-query` over
    hand-parsing that format.
- Process note: the task asked for a subagent to compile the capability list; the fork executing it
  cannot spawn subagents, so the list was compiled inline. It is a single-source survey and deserves a
  second pass before T-134 onward.

## 2026-09-26 — the decision layer finds its provider (planning only)
- Investigated `convaiinnovations/laya` (Hugging Face, Apache-2.0, published 2026-09-18; the Hub API reports 3,689 likes and 0 downloads eight days in — recorded as data, not as evidence of quality).
  It is **not** another generative model: it is a non-autoregressive System-1 decision model — typed
  questions in, typed answers with calibrated probabilities out, every question in a call answered in
  one forward pass, ~33-40 ms on a T4. It never generates text.
- **The finding that shaped the design**: `laya-serve` implements the *same* `POST /v1/systemone`
  request/response shape as TypeSafe Jev. So we do not integrate a model, we integrate the
  **SystemOne wire protocol**, and Laya / Jev / a fine-tuned Laya become swappable providers behind
  the existing `DecisionModel` contract. ADR-0003 (vendors only in adapters) pays for itself here.
- **The finding that constrained it**: the model card's *Honest Limits* are candid and disqualifying
  for zero-shot policy use — base checkpoints score 0.362 on typed decisions against a 0.461
  majority-class baseline (the quoted 0.766 is a checkpoint fine-tuned on that benchmark's own
  training split); it ships over-confident (mean ECE 0.466, falling to 0.081 only after refitting
  temperatures on your own data); `noul` can follow its option labels instead of the input (#156);
  and `action.act_probability` carries no usable signal (#185). Two of these are now adapter-level
  workarounds (T-202) so the contract stays clean.
- Written: `docs/08-DECISION-LAYER-LAYA.md` (design, three integration paths, nine proposed features),
  ADR-0009 (the protocol is the substrate; Python lives in a sidecar, never in our runtime), and
  backlog **T-200..T-243** in four gated groups — protocol/provider, lifecycle, calibration, first uses.
- **Explicit gate recorded (T-223)**: no decision path ships enabled by default until its measured ECE
  beats the rule baseline it replaces. Structural unblocking of M3 is not behavioural unblocking, and
  conflating them is how a system ends up routing real work on a coin flip.
- Two subagents were dispatched for the details we should not guess at: the exact `laya-serve` /
  `laya[mcp]` interfaces, and the substrate's MCP and HTTP seams.

## 2026-09-26 — handoff written for decision-driven routing
- Goal for the next session: Laya answers three typed questions per task — **task level**, **model
  tier**, **pipeline** — so cheap computation narrows the problem before an LLM turn is spent.
- Written: `docs/09-HANDOFF-DECISION-ROUTING.md` (the three question schemas, shadow-mode rollout,
  confidence bands, first-session commands) and backlog **T-250..T-262**.
- One design decision recorded up front: **Laya is never asked for a model id.** It answers a
  three-option *tier*; the capability router maps tier -> model. High-cardinality choice is its
  documented weak spot (0.425 vs Jev 0.870 on 77 labels) and model ids churn anyway.
- Rollout is **shadow mode first**: rules keep deciding, Laya decides in parallel, both are logged
  with the outcome. That is the only way to get the labelled set the calibration gate (T-223) needs,
  and it costs one ~200 ms call per task. Nothing Laya says steers anything until its measured ECE
  beats the rule baseline it would replace.

## 2026-09-26 (overnight) — the decision layer is running, and it is not trustworthy yet
- **Sidecar is live.** `laya[serve]` 0.3.20 installed into `.verness/py` (torch 2.14, transformers
  5.17, fastapi 0.141), started on `127.0.0.1:8000` with a generated `LAYA_API_KEY`, all three
  checkpoints loaded (english, multilingual, typed-decisions). `/decision up|stats|down` manages it
  exactly like the model engine. (T-210..T-214)
- **Wire contract confirmed against the live server**, not the model card: a `choice` answer carries
  `choice`, a full `probabilities` map, `confidence` (entropy-based) and `answer_confidence`. On this
  build `answer_confidence` equals the winning probability. (T-200..T-203, T-206)
- **Measured latency: p50 950 ms** for all three routing questions in one call (min 890, max 966,
  n=5). That is 2-5x the documented 193-464 ms CPU range and ~29x the 32.8 ms T4 figure. A decision
  is cheap compared with an LLM turn, but on this machine it is not free, and a per-task decision
  adds about a second. (T-224)
- **Zero-shot quality, measured on five hand-written tasks**: the model matched the expected task
  level 2/5 (simple, research) and missed three (trivial->standard, standard->simple,
  complex->standard), with confidences of 0.32-0.51. The rule baseline did better. On a clear
  multi-step refactor the model said standard/local_small/standard where the rules said
  complex/frontier/agent. This is exactly the card's own warning (0.362 zero-shot against a 0.461
  majority-class baseline), now confirmed on our own decisions.
- **Consequence**: shadow mode is not a formality, it is the correct default. `decisions.enabled` is
  `false` in the committed config, and even when enabled it only logs. Nothing the model says steers
  anything until calibration beats the rule baseline (T-223).

## 2026-09-26 (overnight, continued) — visibility, dashboard, thought-graph design
- **Command surface is visible** (T-140/T-146 follow-up): the REPL opens with all 17 quick-tools
  grouped by area, tab completes command names and then their arguments (persona ids, team ids,
  session ids, local models), carries a `persona · model · session` status line, and suggests near
  matches on a typo.
- **`/dashboard`** (T-270): a self-contained static HTML page built from the session logs, the shadow
  decision log and team-run transcripts. Sessions with turns/tools/tokens/wall time, click-through to
  a per-session timeline, decisions with agreement and latency, team runs with per-task outcomes.
  53 KiB, no server, no dependencies, no external assets.
- **Thought graph designed** (`docs/10-THOUGHT-GRAPH.md`, T-280..T-297) on two research digests. The
  decisive substrate finding: **log-only session events are immune to compaction's surface-replace
  shadowing**, so ephemeral nodes survive compaction for free simply by never being surface events.
  Persistent nodes live in `ctx.storage` instead — outside the session log, no replay, capped, and
  promoted only by an explicit verified act.
- The design's centre of gravity is the failure mode, not the feature: an unbounded self-written
  memory poisons itself, so persistence is explicit, evidence-gated, attributed to the session and
  model that produced it, revocable, and contradictions surface rather than overwrite.

## 2026-09-26 — standalone dashboard requested, deferred
- The current `/dashboard` is a generator inside the launcher: one workspace, static file, built on
  demand. The request is to decouple it into a service that is available whenever the harness is
  active and can show several environments at once.
- Recorded as **T-274..T-279**, not started. The constraints worth keeping when it is built: loopback
  by default with a token before any wider bind (a dashboard renders session transcripts, so it is
  as sensitive as the logs themselves); environment as a first-class dimension rather than a second
  copy of the tool; live updates by watching the existing files; and the static export kept as a
  first-class mode, because that is how a run gets archived or shared offline.

## 2026-09-26 — a near-miss worth remembering: the repo could not be cloned
- `.gitignore` carried a bare `lib/` for build output. It also matched `scripts/lib/`, where every
  launcher module lives - util, sessions, personas, teams, commands, decisions, prompt, loop.
  **None of the eight was ever tracked.** `git add` skips ignored paths without an error, so eight
  commits reported success while adding nothing, and `git status` stayed clean throughout.
- Nothing local ever failed, which is exactly why it went unnoticed: the files were on disk here. A
  clone would have crashed on the first import.
- Fixed by scoping the rule to `/lib/` and `packages/*/lib/`, then **verified by actually cloning the
  repo into a temp directory and running the launcher there** (8 modules present, `help` works).
- Convention added to `docs/05-CONVENTIONS.md`: verify from a clean clone before claiming a feature
  ships, and check `git ls-files` when a new source directory appears - an ignored file is invisible
  to both `git add` and `git status`.

## 2026-09-26 — /loop-task: the small model finishes a task on its own
- `/loop-task <objective>` runs bounded rounds until DONE, BLOCKED, repetition, stall or the limit.
  Each round is a **separate substrate invocation on one session**, so accumulated state lives in the
  durable log instead of inside the small model's context.
- **Measured on a real objective** ("count the .json files in personas/"): round 1 ran the tool,
  round 2 claimed DONE and verification rejected it, round 3 claimed DONE and verification passed.
  Final answer 4, which is correct. 22,055 input / 983 output tokens across three rounds.
- Two bugs the first run exposed, both fixed by reading the substrate's **`--json` event stream**
  instead of the printed transcript:
  - classification was reading the last printed line, which is usually reasoning, so a round that
    merely *mentioned* "DONE:" while thinking out loud was misread. `final` carries only the
    committed answer.
  - the stall rule also required no new text, so four rounds of pure rambling never tripped it. In a
    task loop prose is not progress: **two consecutive rounds with no tool call now stop the run**.
- The stream also reports the session identity directly (no more directory diffing) and per-step
  token usage, so every round reports its own cost.
- Verification runs with no `--session-id`, so the checker has never seen the work and cannot be
  convinced by its own earlier reasoning. When the checker ignores the reply format the driver now
  says exactly that, instead of reporting an empty rejection.

## 2026-09-26 — the pet: versions and workers at a glance (T-330..T-333)
- The REPL now boots with a small ASCII companion (default name **Ness**) beside a status panel:
  VerNess version and commit, node, **dsh installed vs the pinned substrate** (the most useful single
  versions signal, since ADR-0002 pins it), the engine version, whether the model engine is up and
  which model is warm with its memory, the decision sidecar, the last `/loop-task` and `/team` run,
  the roster and the conversation. `/pet` redraws it with fresh probes.
- Its mood is derived, not decorative: **worried** when something is wrong (substrate drift, engine
  down, decisions enabled with the sidecar down) with the one line that says what to run,
  **sleepy** when the engine is up but nothing is warm, **happy** otherwise.
- Boot cost is bounded: HTTP probes (600 ms cap) and two shell-free `git` calls (1.2 s cap) all run
  in parallel; the dsh version is the one the launcher already read. `git status` skips submodules -
  a worktree without `upstream/` initialised would otherwise hide what walking the substrate costs
  in the real checkout. Measured: `/pet` end to end in ~0.4 s including its own `dsh --version`.
- Found while testing from a worktree: booting any second checkout syncs ITS persona into the shared
  `~/.dsh/profiles/<name>/cordis.patch.yml`, silently switching the live profile (T-336).
- It draws only on a real terminal, so piped output is unchanged; `pet.enabled: false` or
  `VERNESS_NO_PET=1` restores the one-line banner. That banner also printed a literal `undefined`
  before persona and model on a TTY (the launcher's colour table had no `bold`), fixed in passing.
- Redesigned on request, twice. The triangle with a detailed face read as scary; Ness is now a
  **cube - a little TV** with a deliberately small face on its screen (`o   o` over `u`; `-   -`
  over `.` with a `z` when sleepy; `~` and a `!` when worried). The design effort went into the
  cube: oblique projection, a 13x6 front face that reads square because a terminal cell is about
  twice as tall as it is wide, and a 3-row depth stepping one column per row so every receding edge
  is a single `/`. It is generated from those three numbers, the face pieces are odd-width on an
  odd-width screen so they centre exactly, and the test checks every corner and edge (T-337).
  Animations are planned, not built (T-335a..h).

## 2026-09-26 — models in one command, and the agent on a hosted API (T-350..T-356)
- **Why**: adding a model meant editing the config and guessing which quant a Hugging Face repo
  publishes; `/model <id>` failed with `UNKNOWN_MODEL` because the patch declared one model per
  route; a hosted model needed a hand-written route plus an edit to `activeRoute`, and the REPL froze
  its route at boot anyway. Five places computed "the active route", and disagreed.
- **What**: `scripts/lib/routes.mjs` is now the single resolver. `/api use <provider> <model>` puts
  the agent on any provider the installed route adapter ships a catalog for — the patch declares only
  the key *variable*; endpoint, protocol and models come from the adapter, so our code names no
  vendor (ADR-0010). `/models add` validates the quant against the repo's actual GGUF files, pulls,
  warms and registers; the local route now declares every registered model. `/access` chooses the
  substrate sandbox mode. Keys live in the gitignored `.env`. Guide: `docs/11-MODELS-AND-API.md`.
- **Verified**: `dsh --dump-config` composes the catalog route; a task with the key unset is refused
  with the exact `.env` line; with a deliberately invalid key the request reached the provider and
  returned `401 authentication_error`. `/models add` refused a missing quant (listing the real
  ones), resolved a Hugging Face URL, and a turn then ran on a newly registered model. The session
  log records `sandbox/mode` per `/access`; under `read-only` it shows `Set-Content` refused by the
  OS (`PermissionDenied`). A permitted write under `workspace` is unproven: the 0.6B model never
  produced a valid call.
- **Not verified**: a successful hosted turn — no provider key exists on this machine (T-357). The
  0.6B local model emitted a `pwsh` call but omitted a required argument; that is the capability gap
  hosted models are meant to close, not a wiring fault.
- **Found on the way**: headless has no approval answerer, so any sandbox escalation fails closed —
  the chosen mode is the whole policy. On Windows the sandbox restricts writes only, and sandboxed
  PowerShell runs in ConstrainedLanguage, so .NET type creation fails (T-366).
- **Fixed after review**: `/model reset` on an API route left it with no model and exited the REPL;
  `/api use` now records the model on the route, so reset falls back to it.
- Task IDs start at T-350: another checkout took T-330..T-336 concurrently.

## 2026-09-26 — `--parallel` stops lying (T-144); shadow decision logging switched on
- The team runner advertised `--parallel N` and scheduled with `Promise.race`, but every task ran
  through `spawnSync`, which blocks the event loop: the race only ever saw one task. Measured with
  the old runner: two 400 ms tasks at `--parallel 2` took 914 ms.
- Fixed by giving the command context an async sibling, `dshAsync` (same shell-free entry, same shim
  fallback, built on `spawnAsync`/`shAsync` in `lib/util.mjs`). The synchronous `dsh` is untouched
  for its other callers. A second bug only real concurrency would expose was closed at the same
  time: persona overlays were one shared file per persona, rewritten per task; each task now writes
  its own beside its transcript. Proof lives in `scripts/test/teams.parallel.mjs` (no tokens spent).
- `decisions.enabled` is now `true`: every REPL task is shadow-routed and logged to
  `.verness/decisions/` beside what the rules chose. Nothing is applied. Calibration (T-223) needs a
  labelled set more than it needs code, so the set accumulates from normal use first. Each REPL turn
  now waits on one decision call (~1 s at the measured CPU p50) when the sidecar is up, and prints a
  one-line "unavailable" note and carries on when it is not.

## 2026-09-26 — `off`: one command turns everything off (T-370)
- **Why**: to stop the web UI the user tried `./turn_on.sh web down`, which booted it again (`web`
  ignores trailing words), and `down` only handles the model. Nothing stopped all three servers.
- **What**: `./turn_on.sh off` (alias `stop`, `/off` in the REPL) stops the web UI — whatever
  listens on port 6173, plus any process matching `pgrep -f "profile <web profile>"`, so a UI
  started with `--port` is found too — then the decision sidecar, then the local model. `--force`
  also stops servers VerNess did not start. Commit 6bc91a6, follow-ups in merge 74cb2de.
- **Verified**: `off` released 5.3 GiB (Qwen3-0.6B) and exited 0, leaving Ollama running because
  VerNess had not started it. A decoy process `--profile verness-web --port 7000` was killed while
  `--profile verness-website` was left alone.
- **Not verified**: stopping a real running web UI server; the Windows PowerShell path (T-372).
- **Found on the way**: on `main`, `/off` was not reachable in the REPL — the handler existed in
  `ctx.builtins` but no quick-tool exposed it. Fixed in 74cb2de.

## 2026-09-26 — the `epic` integration branch, and four branches merged into it (T-371)
- **Why**: several worktrees had finished work in parallel, and `main` had started to diverge from
  them (two independent `web` implementations). Integration now has one place to happen.
- **What**: merged with `--no-ff` into `epic`: 0b86b6c (fix-prompt-redraw, clean), 74cb2de
  (web-composer), 3fb2ea7 (models-and-api-routes), 6f18b51 (t144-parallel-team); then 3aeba67
  wrote the workflow into `05-CONVENTIONS.md` "Branches and versions": feature branches merge
  `--no-ff` into `epic`; `epic` reaches `main` only as a release with a version bump and a
  `vX.Y.Z` tag. No release has been cut yet; `package.json` is still `0.0.1`.
  - `main` and web-composer each implemented `web`. The branch's version was kept (`ensureProfile`,
    `prepareBoot`, `webProfileName`, the `web`/`ui` quick-tool); main's `cmdRunWeb`, the inline
    web-profile block in setup and the `web` switch case were removed.
  - `prepareBoot` now calls `prepareRoute` (the models branch's resolver), so `web` gets the same
    key/model/sandbox checks as the REPL.
  - t144 turned on `decisions.enabled: true`: every REPL turn waits on one shadow decision call
    (~1 s) when the sidecar is up.
- **Verified**: all three `scripts/test/*.mjs` pass, `doctor` runs, and the clean-clone check from
  `05-CONVENTIONS.md` passes on `epic`.
- **Not verified**: a real REPL or web boot from the merged tree — skipped on purpose, because
  booting from a second checkout overwrites the shared `~/.dsh` profile patch (T-336, T-372).
- **Found on the way**: 74cb2de dropped `dshVersion` from `cmdRun` while the pet banner still read
  it, which would crash the REPL at boot with the pet enabled; restored in 3fb2ea7. Separately,
  `README.md` had been committed as UTF-16LE (11eeed4), so grep and GitHub treated it as binary;
  converted to UTF-8 in this change (T-373).

## 2026-09-26 — Engram graph rebuilt; web commands bridge designed, not built (T-100, T-101, T-374..T-379)
- **What**: `@sentropic/engram@0.19.0` installed globally; `engram install` put the `/engram`
  Claude Code skill in `~/.claude/skills/engram/`. `engram update .` (= `./turn_on.sh graph`)
  built 315 nodes / 974 edges / 13 communities in ~4 s, into the gitignored `.engram/` (the first
  build, T-101, had 14 nodes).
- **Found on the way**: npm skipped the tree-sitter install scripts (warning only); the build
  succeeded regardless.
- **Not done**: the optional description batches and `engram claude install` (CLAUDE.md section +
  PreToolUse hook) — T-379.
- **Planned, not built**: a "web commands bridge" — a `@verness/commands` dsh plugin that registers
  the launcher's quick-tools in the web UI's `/` menu (via dsh-commands) and runs them through
  `node scripts/verness.mjs <name>`. The design spec lives on the separate branch `web-commands`
  (`docs/superpowers/specs/2026-09-26-web-commands-bridge-design.md`), not yet in `epic`, and
  awaits an implementation plan. Tasks T-374..T-378. Per-persona `tools.allow`/`deny` remain
  unenforced (M4) and are out of that scope.

## 2026-09-26 — M2 done: contracts as types, zero dependencies (T-020..T-027, T-162..T-165)
- **Exit criteria verified**: `pnpm typecheck` (`tsc -p packages/contracts`) clean; `pnpm test`
  125/125 pass; `packages/contracts/package.json` has no `dependencies`. `@verness/contracts` is
  erasable-only TypeScript run directly by Node's type stripping; `exports` points at `./src/index.ts`.
- **Tooling**: root dev tooling via pnpm (the declared `packageManager`), `pnpm-lock.yaml` committed.
  Node floor is `^22.19.0 || >=24`; `nodeOk()` rejects 23.x. Only Node 26 was used for the run —
  22.19 itself is **not yet verified** (T-382), nor is whether it prints an `ExperimentalWarning`.
- **Persona files are JSON/JSONC**, not YAML: `id, name, description, prompt.prefix/suffix, model,
  models.requirements, tools.allow/deny/approval, skills, evaluators, tips, commands`. ADR-0008's
  YAML wording is superseded (amendment added there).
- **Validation at load**: `validatePersonaFile` checks every `personas/*.json`; a broken file is listed,
  never a crash. `/persona check` prints `personas/x.json:L:C path: message` via `locate()`.
- **Persona-scoped commands**: `personas/<id>/commands/<name>.mjs`, loaded after the globals; globals
  win and the collision warning names the owner. Example: `/hypotheses` (data-scientist), zero tokens.
- **Personas**: `data-analyst`, `data-engineer`, `data-scientist`, `researcher`, `reviewer`,
  `software-engineer` as files, plus the inline `generalist` — 7 in all, all valid. The inline
  `data-analyst` block in `verness.config.json` is now shadowed by the file; the owner may delete it
  (T-388). Inline config definitions are not validated.
- **Final-review fixes** (`fd09901`): a persona file whose JSON is `null` no longer crashes
  `loadPersonas`; `loadCommands` guards persona command names against path escape; `nodeOk` rejects
  23.x; contracts `exports` → `src`; contracts README uses pnpm; `parseJsonc` shared from
  `scripts/lib/util.mjs`; tests for the collision warn count and a JSONC comment/trailing-comma case.
- **Deferred**: T-382..T-388 in the backlog (Node 22.19 check, lazy `.ts` import for a friendly
  old-Node error, stale `files: lib/`, `<= 8` decision options, a `.d.ts` for util.mjs, validator edge
  minors, removing the shadowed inline persona).
- **Engram graph** rebuilt after M2: 513 nodes / 1592 edges / 19 communities (was 315 / 974 / 13);
  it now covers `packages/contracts/src/*`.
- **Next**: M3 / T-030 — the decisions plugin.

## 2026-09-26 — v0.2.0 released; dashboard backlog; terse skill (T-389..T-391)
- **Release**: `epic` merged into `main` (`13c94d4`), tagged `v0.2.0` and pushed; `epic` re-created
  from it for further work.
- **Dashboard backlog** (T-389): `/dashboard` now opens on a Backlog section built from
  `docs/03-BACKLOG.md` — each open task gets a P0–P3 picker (kept in the browser's localStorage under
  `verness.backlog.priority`), with filters by workstream/priority, sort, and copy-as-markdown; the
  file itself is rendered below. Parser and renderer: `scripts/lib/backlog.mjs`, no dependency.
- **Wall-time fix** (T-390): session wall time starts at the first timed event, not at an untimed
  header, so it is no longer inflated.
- **Terse skill** (T-391): `.claude/skills/terse/SKILL.md` — agents drop filler and hedging, use
  plain short phrasing, and keep code, paths, commands and errors exact, to cut token cost.
- **Docs**: README (dashboard, features, releases, development, structure), docs index, 07, 06.
- **Tests**: `pnpm test` 130/130; `pnpm typecheck` clean.

