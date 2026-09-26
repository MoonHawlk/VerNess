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
