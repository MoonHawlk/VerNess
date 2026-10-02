# Changelog

Every release of VerNess, newest first. A release is not done until its entry is here (see
`docs/05-CONVENTIONS.md`, *Branches and versions*). Each line names its task ID; the details and the
evidence are in `docs/03-BACKLOG-DONE.md` and `docs/04-PROGRESS.md`.

## Unreleased

**Side notes and a project brief in the prompt, one `verness` command, and `/team status`.**

### Added
- **`/btw <note>`** (`/btw`, `/btw clear`, `/btw drop <n>`): side notes sent once with your next
  task as context, not tasks; capped at `notes.maxChars` (2000), warning at 80%; terminal only (T-130).
- **`#<note>`** adds a line to a project brief (`.verness/brief.md`) that every new session receives;
  `#` shows it, `##` sends a line starting with `#` as a task; cap `notes.briefMaxChars` (4000) (T-147).
- **`/usage --by day`**: tokens per route per day across sessions. Days are local dates (the time
  zone is in the header); a session spanning midnight is split by the time of each model call (T-137).
- **`/team status [<id>]`**: per-task status, exit code and seconds of a team's newest run, and a
  machine-readable `summary.json` next to every run's `summary.md` (T-170).
- **Recent-task suggestions**: typing a task suggests your recent matching tasks (3+ characters, up to
  6, newest first), and Up/Down history persists across runs (`.verness/history.jsonl`;
  credential-looking lines are never stored) (T-303).
- **`verness` command**: package.json `bin` → `scripts/cli.mjs`; link it once with `npm link` (T-380).
- A startup warning when a `scripts/lib` module the launcher imports is not tracked by git (T-312).
- **`pet.animate`** (default on) turns off the pet's animation; it also switches off in pipes, with
  `NO_COLOR` or `CI` set, or when the terminal is too narrow for the side-by-side layout (T-335g).
- `scripts/check-clean-clone.mjs` (`npm run check:clean-clone`) proves the committed tree starts from
  a fresh clone; an opt-in `pre-push` hook (`git config core.hooksPath scripts/hooks`) runs it on
  every pushed commit (T-311).
- **`scripts/tools/release-notes.mjs`** drafts the next `CHANGELOG.md` entry from the done tasks since
  the last tag, for you to edit (T-431).

### Changed
- Decision questions are validated before they are sent: a `choice` with more than 8 options (or
  fewer than 2, or a malformed shape) is refused with an error naming the limit (T-385).
- `turn_on.sh/.ps1/.cmd` and the npm scripts start through `scripts/cli.mjs`; `scripts/verness.mjs`
  exports `main()` (T-380, T-383). Node 22.19.0 verified as the minimum (T-382).
- Tests: the pet render test runs in `npm test` (T-338); route resolution, catalog-route patch
  rendering and `.env` parsing are covered (T-365).

### Fixed
- `.env` values no longer keep trailing whitespace (`KEY=sk-... ` used to send the space), and a
  quoted value may be followed by spaces or a `# comment` (T-365).
- Old Node gets "VerNess needs Node 22.19.0+ … or 24+" instead of a module-link error from the `.ts`
  contracts (T-383).

### Upgrade
- In the REPL, a line that starts with a single `#` is no longer a task: it goes to the project brief.
  Type `##` to send it as a task.
- New settings `pet.animate`, `notes.maxChars` and `notes.briefMaxChars` have defaults; nothing to set.
- Optional: `npm link` once in the checkout to get the `verness` command.

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
- **Repo tools** (`scripts/tools/`) and the `verness-tools` skill: locate code through the Engram
  graph, check the backlog, run tests, audit docs, inspect profiles.

### Changed
- Plugin rows can be limited to one profile (`"surfaces": ["web"]`); each profile gets its own patch.
- From the command line, an unknown `/word` is now an error instead of a task for the model.
- Setup decides pnpm install scripts itself (`settings.allowBuilds`), so installs behave the same on
  macOS and Windows.
- `@verness/contracts` ships `src/` only (T-384); `scripts/lib/util.d.mts` types the launcher helpers
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

M2: `@verness/contracts`, persona files validated at load (`/persona check`), the `data-analyst` and
`reviewer` personas, persona-scoped commands.

## v0.1.0 — 2026-09-25

M0/M1: launcher, local model lifecycle, web UI, the load-bearing spike plugin.
