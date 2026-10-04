# Changelog

Every release of FiNess, newest first. A release is not done until its entry is here (see
`docs/05-CONVENTIONS.md`, *Branches and versions*). Each line names its task ID; the details and the
evidence are in `docs/03-BACKLOG-DONE.md` and `docs/04-PROGRESS.md`.

## Unreleased

**The project is now FiNess; side notes and a project brief in the prompt, one `finess` command,
tool-failure hints for small models, and an animated Ness.**

### Added
- **Thought graph** (`@finess/thoughts`, `/think`): the model records findings, decisions and
  constraints with `think_add`; a capped per-project memory with provenance, contradictions held
  for you to resolve, demotion instead of deletion, constraints injected at session start and kept
  through compaction; a dashboard panel (T-280..T-290, T-295..T-297).
- **`finess dashboard serve`**: a live dashboard on 127.0.0.1:4180 (token for any other address);
  `finess dashboard --watch` (T-273..T-278).
- **Context window reaches the engine**: `model.contextWindow` now sets the local engine's context;
  `model.kvCache` (`q8_0`) saves VRAM for long contexts.
- **Persona tool policy enforced**: a persona's `tools.allow`/`deny` now blocks calls, with a reason
  the model reads; `/permissions` shows it and `/tools` marks each tool (T-042, T-116, T-154, T-155).
- **`/diff`** and **`/undo --yes`**: see and revert what the last task changed (git workspaces) (T-454).
- **Budgets**: `budget.sessionTokens`, `dailyTokens`, `dailyCost`, `taskSeconds`; `/budget` (T-091).
- **`/compact --yes`** shrinks the conversation into a fresh session; automatic compaction now works
  on small context windows (`compact.autoPercent`) (T-151).
- **`/export`** a session as Markdown (T-152) · **`/todos`** the agent's plan (T-150).
- **`/task cancel <id>`** stops a delegated, team or loop run with its whole process tree (T-169, T-433).
- **`model.fallback`**: a usable route when the default is down (T-453).
- **The FiNess mark and name in the web UI** (T-398).
- **Decision layer**: composite rules -> model -> LLM with bands and gate (T-204); advisory capability
  router (T-253); shadow supervisor and guard questions (T-231, T-243); hosted provider by config and
  an opt-in Laya MCP row (T-205, T-240); decision calls and avoided LLM calls in `/cost` (T-232).
- **`/workspace <dir>`** (and `--workspace`): point FiNess at any project; tasks, `!` commands and
  `@` files run there (T-363).
- **`!<cmd>`** runs a shell command locally at no token cost; **`!!<cmd>`** also attaches its output
  to the next task; **`@path`** and **`@https://...`** attach a file, a folder listing or a web page
  (T-181, T-447).
- **`/recipe`**: one-line task templates in `recipes/*.md`, with six starters (code-review,
  write-tests, explain, summarize-docs, commit-message, plan) (T-444).
- **`/delegate <persona> <task>`** and **`/task list`** (T-169).
- **Model per persona**: `"model": { "route", "id" }` in a persona file, e.g. a reviewer on a
  stronger model than the worker (T-361).
- **`/context`**: what the next task carries and how much of the context window it fills (T-151).
- **Finish notifications**: bell and terminal title when a task, loop or team run took over
  `notify.afterSeconds` (30); `notify.desktop: true` adds a desktop notice (T-445).
- **CI**: GitHub Actions on Windows, macOS and Linux with Node 22 and 24 (T-446).
- **Tool-failure hints** (`@finess/tool-hints`): when a tool call fails on bad arguments, a missing
  read or a wrong path, the result gains one line with a corrected call the model can copy. No prompt
  tokens on calls that succeed (T-438).
- **Small-model warning**: `doctor` and `/model` flag models under 4B parameters as too small for
  reliable tool calls (T-438).
- **`stats --watch [--interval <s>]`**: live model telemetry, one line per tick; every probe is kept
  in `.finess/probes.jsonl` and a tok/s drop of 30% below the recent median is flagged (T-123).
- **Dashboard**: per-tool calls, failure rate, p50/p95 and a latency histogram (T-271); a route
  filter (T-272); `/loop-task` runs (T-328).
- **`/models add`** warns when a GGUF will not fit free RAM/VRAM and suggests a smaller quant (T-360).
- **`/api test [provider] --yes`**: a one-token probe of key and model; without `--yes` it only says
  what it would cost (T-358).
- **`pricing`** in `finess.config.json`: per-route prices for `/cost`; unpriced routes show tokens
  only, never a guessed price (T-362).
- **`/loop-task --round-timeout <s>`** (default 600) (T-327).
- **`onFailure: stop | skip | retry-once`** for teams and tasks (T-167).
- **`finess --no-model`** (`--no-start`): the prompt and quick-tools without booting a model (T-381).
- **Ness moves**: at boot and on `/pet` the block-drawn sheep plays a short one-shot animation for
  her mood (a blink and sparkles when all is well, a drifting `z` when no model is loaded, a pulsing
  `!` when something needs attention), then rests; it finishes before the prompt opens.
- **`/btw <note>`** (`/btw`, `/btw clear`, `/btw drop <n>`): side notes sent once with your next
  task as context, not tasks; capped at `notes.maxChars` (2000), warning at 80%; terminal only (T-130).
- **`#<note>`** adds a line to a project brief (`.finess/brief.md`) that every new session receives;
  `#` shows it, `##` sends a line starting with `#` as a task; cap `notes.briefMaxChars` (4000) (T-147).
- **`/usage --by day`**: tokens per route per day across sessions. Days are local dates (the time
  zone is in the header); a session spanning midnight is split by the time of each model call (T-137).
- **`/team status [<id>]`**: per-task status, exit code and seconds of a team's newest run, and a
  machine-readable `summary.json` next to every run's `summary.md` (T-170).
- **Recent-task suggestions**: typing a task suggests your recent matching tasks (3+ characters, up to
  6, newest first), and Up/Down history persists across runs (`.finess/history.jsonl`;
  credential-looking lines are never stored) (T-303).
- **`finess` command**: package.json `bin` → `scripts/cli.mjs`; link it once with `npm link` (T-380).
- A startup warning when a `scripts/lib` module the launcher imports is not tracked by git (T-312).
- **`pet.animate`** (default on) turns off the pet's animation; it also switches off in pipes, with
  `NO_COLOR` or `CI` set, or when the terminal is too narrow for the side-by-side layout (T-335g).
- `scripts/check-clean-clone.mjs` (`npm run check:clean-clone`) proves the committed tree starts from
  a fresh clone; an opt-in `pre-push` hook (`git config core.hooksPath scripts/hooks`) runs it on
  every pushed commit (T-311).
- **`scripts/tools/release-notes.mjs`** drafts the next `CHANGELOG.md` entry from the done tasks since
  the last tag, for you to edit (T-431).

### Changed
- Tools a persona may not use are no longer offered to the model, so requests are smaller (T-234).
- **Renamed to FiNess** everywhere: the `finess` command, `@finess/*` packages,
  `scripts/finess.mjs`, `finess.config.json`, `.finess/`, `profiles/finess`, `FINESS_*` variables.
- `/loop-task` repeat guard follows the substrate's repeat-tool-reminder: reminders at 3 and 5
  identical calls in a row, a stop at 8 (it used to stop on any call seen more than twice) (T-325).
- `/team run`: a task whose dependency failed is `skipped`, never run; the run exits 1 (T-167).
- `setup` reinstalls a local plugin whose files changed (T-432); `sync` stamps the profile patch with
  its checkout and warns when another checkout or a worktree takes it over (T-336, T-433).
- `webBundles` entries may pin a version; `dsh-web-all` is pinned to 0.4.3 (0.4.4 needs dsh 0.2).
- Decision questions are validated before they are sent: a `choice` with more than 8 options (or
  fewer than 2, or a malformed shape) is refused with an error naming the limit (T-385).
- `turn_on.sh/.ps1/.cmd` and the npm scripts start through `scripts/cli.mjs`; `scripts/finess.mjs`
  exports `main()` (T-380, T-383). Node 22.19.0 verified as the minimum (T-382).
- Tests: the pet render test runs in `npm test` (T-338); route resolution, catalog-route patch
  rendering and `.env` parsing are covered (T-365).

### Fixed
- Long tasks no longer hit the Windows command-line limit: they reach dsh through stdin, and
  attachments may be up to 50k per item, 150k in total (T-448).
- `/doctor` and `up` say why the local engine cannot start (e.g. `OLLAMA_MODELS` on a missing drive),
  with a fix line and the engine's own log (T-452).
- Long input wraps across rows with the cursor in the right place and the suggestions below it;
  wide characters and emoji no longer shift the cursor (T-302).
- `npm run model:up|stats|down` no longer hang (an import cycle deadlocked).
- Piped input to the prompt no longer loses lines that arrive while a command runs, and EOF exits
  cleanly (T-439).
- Dashboard tool errors show their name and code instead of "[object Object]".
- A refused decision question reads "invalid question", not "decision service unavailable" (T-435).
- `.env` values no longer keep trailing whitespace (`KEY=sk-... ` used to send the space), and a
  quoted value may be followed by spaces or a `# comment` (T-365).
- Old Node gets "FiNess needs Node 22.19.0+ … or 24+" instead of a module-link error from the `.ts`
  contracts (T-383).

### Upgrade
- **Rename:** run `setup` once (creates `~/.dsh/profiles/finess` and `finess-web`), then `npm link`
  again for the `finess` command. Move the old state directory to `.finess/` and carry config edits over to
  `finess.config.json`; rename environment variables to the `FINESS_*` prefix. The profiles under
  the old name can be deleted. `finess decision up` rebuilds the decision venv under `.finess/py`.
- In the REPL, a line that starts with a single `#` is no longer a task: it goes to the project brief.
  Type `##` to send it as a task.
- New settings `pet.animate`, `notes.maxChars` and `notes.briefMaxChars` have defaults; nothing to set.
- Optional: `npm link` once in the checkout to get the `finess` command.

## v0.4.0 — 2026-09-27

**Your commands in the web UI, a decision gate, and the basics of the prompt.**

### Added
- **Quick-tools in the web UI's message bar** (T-374..T-378, ADR-0011). `/cost`, `/usage`,
  `/persona`, `/agents`, `/dd`, `/routing`, persona commands such as `/testplan` and the rest now run
  from the browser, with the same output as the terminal. The web UI keeps its own `/model`, `/file`,
  `/compact`, `/export`, `/feedback`, `/goal`, `/permission` and `/plan`. Terminal-only commands
  (`/new`, `/resume`, `/web`, `/off`, `/help`, `/exit`) stay off the web.
- **`/exit`** (alias `/quit`) ends the prompt (T-148).
- **Short command names:** `/pers` runs `/persona`, `/mo` runs `/model`; an ambiguous prefix lists
  the choices. A line starting with `//` is sent to the model as text (T-182).
- **`/config`** shows every setting and where it comes from (default, config file, state, persona,
  environment), with secrets hidden (T-180).
- **The calibration gate** (`/dd gate`): whether Laya has earned the right to decide a question.
  Today every question says HOLD (20 of the 50 labels needed) (T-223).
- **`/routing`:** recent decisions, Laya vs the rules, and the agreement rate per question (T-255).
- **`teams/feature-delivery.json`:** product manager → engineer → QA → technical writer (T-397).
- **`@linxin666/dsh-web-all` in the web UI:** task board, Git graph, usage, session archive, skins,
  plugin market (T-399).
- **Repo tools** (`scripts/tools/`) and the `finess-tools` skill: locate code through the Engram
  graph, check the backlog, run tests, audit docs, inspect profiles.

### Changed
- Plugin rows can be limited to one profile (`"surfaces": ["web"]`); each profile gets its own patch.
- From the command line, an unknown `/word` is now an error instead of a task for the model.
- Setup decides pnpm install scripts itself (`settings.allowBuilds`), so installs behave the same on
  macOS and Windows.
- `@finess/contracts` ships `src/` only (T-384); `scripts/lib/util.d.mts` types the launcher helpers
  (T-386).

### Fixed
- Persona validation: `__proto__` keys, non-plain objects, duplicate list entries and an empty `name`
  are now reported (T-387).
- The shadowed inline `data-analyst` persona is gone from the config (T-388).
- `dsh-web-all` never installed: pnpm 11 refused undecided install scripts (T-399).
- Docs audited against the code: the web UI description, the decision layer status, the roadmap.

### Upgrade
Run `./turn_on.sh setup` (Windows: `.\turn_on.cmd setup`) once, on every machine: it installs the
web commands plugin and the web bundle, and writes the install-script decisions. Then restart the web
UI (`off`, then `web`).

## v0.3.0 — 2026-09-27

Decision layer measured and the persona catalog. Shadow records with probabilities, blind labelling
(`/decisions-data label`, `--relabel`), calibration report and refit (T-220..T-222). Ten new
personas with their own commands (T-400..T-429), persona `family` (T-395), the catalog (T-394). The
dashboard backlog with priorities. Windows: no terminal windows flashing at boot. Docs: the persona
guide and the project explained simply.

## v0.2.0 — 2026-09-26

M2: `@finess/contracts`, persona files validated at load (`/persona check`), the `data-analyst` and
`reviewer` personas, persona-scoped commands.

## v0.1.0 — 2026-09-25

M0/M1: launcher, local model lifecycle, web UI, the load-bearing spike plugin.
