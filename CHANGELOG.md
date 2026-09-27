# Changelog

Every release of VerNess, newest first. A release is not done until its entry is here (see
`docs/05-CONVENTIONS.md`, *Branches and versions*). Each line names its task ID; the details and the
evidence are in `docs/03-BACKLOG-DONE.md` and `docs/04-PROGRESS.md`.

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
