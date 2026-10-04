# 07 — Command layer and quick-tools

> Status (v0.4.0): **largely built.** The registry, `/help`, `/cost`, `/usage`, `/sessions`, `/resume`,
> `/tools`, `/agents`, `/persona`, `/team`, `/loop-task`, `/dashboard` and persona-scoped commands exist in
> `scripts/commands/`. Open items stay in `docs/03-BACKLOG.md` (WS-A/WS-B). Capability survey: `docs/research/claude-code-capability-map.md`.

## Goal

A Claude-Code-like surface of small commands (`/cost`, `/usage`, `/agents`, `/model`, `/btw`, …) that
are **cheap, discoverable and trivial to add**, plus full personas as first-class files, plus a team
concept for running several tasks under different personas.

## The one rule that keeps it simple

> **Adding a command means adding one file. Nothing else.**

`scripts/commands/<name>.mjs` exports a uniform shape; the registry discovers files at startup and
`/help` is generated from them. No central switch to edit, no registration list to forget.

```js
/** @type {import('../command.mjs').Command} */
export default {
  name: 'cost',
  summary: 'tokens and wall time for this session',
  usage: '/cost [--all]',
  group: 'observability',
  async run(ctx, args) { /* ctx: { cfg, paths, state, sync, out, dsh } */ },
}
```

`ctx` carries: resolved config, repo/profile paths, mutable launcher state, a `sync()` that
regenerates the profile patch, an output helper, and a `dsh()` dispatcher for the rare command that
must reach the runtime. A command returns nothing and prints through `ctx.out` so a future web
surface can reuse the same modules.

## Cost discipline

Every command in the L tier runs **entirely in the launcher and costs zero tokens**. A slash command
that quietly calls the model defeats its purpose. If a command needs the model, it says so in its
summary and asks for confirmation. `/api test [provider]` is the example: it says the one-token probe
is billed and sends nothing until re-run with `--yes`. `/cost` prices only routes the operator listed
under `pricing` in `finess.config.json`; any other route shows tokens and "price not configured".

## `/btw` — side notes (T-130, built)

`/btw <note>` is "by the way": a side note that steers the next task without becoming a task.

The headless surface is one-shot per invocation, so whatever continuity exists between REPL turns is
what the launcher chooses to resend. `/btw` makes that explicit and bounded.

| Form | Behaviour |
|---|---|
| `/btw <text>` | append to the note buffer; confirm with the note count and total characters |
| `/btw` | print the current buffer with indices |
| `/btw clear` | empty the buffer |
| `/btw drop <n>` | remove one note |

- Buffer persists at `.finess/run/notes-<sessionId>.json` so a crash does not lose it.
- A note is sent **once**, prefixed onto the next task as a delimited block
  (`Side notes from the operator (context, not tasks):`), then marked `sent` (only when the run exits 0).
  Every REPL turn continues one substrate session, so the model already has it in history; resending
  would duplicate it. `/btw` lists sent notes as `(sent)` until cleared. `/new` carries the kept notes
  to the new session, unsent, so its first task gets them again.
- Notes written before the first turn creates a session (or before a `/resume`) are filed under
  `notes-new.json` and join the session on the next turn.
- Hard cap `notes.maxChars` (default 2000) with a warning at 80%: it bounds the block a session receives.
- Terminal only (`web: false`): only the REPL composes notes into a task. The web UI, one-shot
  `turn_on "<task>"`, `/team` and `/loop-task` do not receive them.
- `/btw` is a **resend**, which is a deliberate compromise. The substrate's invariant is
  "model-visible means logged", so the correct end state is a durable `SessionEvent` contributed by a
  plugin (T-161). Until then the launcher owns it and the docs say so.

### `#` — the project brief (T-147)

| Input | Does |
|---|---|
| `#<note>` | append `- <note>` to `.finess/brief.md` (cap `notes.briefMaxChars`, default 4000, warning at 80%) |
| `#` | show the brief |
| `##…` | escape: send the line as a task with one `#` removed (`##123 is broken` sends `#123 is broken`) |

The brief is standing context that survives sessions. It is prefixed before any `/btw` notes as
`Project brief from the operator (standing context, not tasks):`. A new session's first task gets the
whole brief; a continuing session gets only the lines added since its last task. Edit or empty
`.finess/brief.md` by hand to change or clear it. REPL only: `turn_on "#x"` is a task.

## Personas as files (T-140..T-143, built in M2 as T-162..T-165)

A persona is one file, `personas/<id>.json` (JSONC: comments and trailing commas allowed). Files win
over inline `finess.config.json` definitions with the same id. The shape is `PersonaFile` in
`@finess/contracts` (`packages/contracts/src/persona.ts`), e.g. `personas/data-scientist.json`:

```json
{
  "id": "data-scientist",
  "name": "Data Scientist",
  "description": "Statistical analysis, experiment design, modelling and data investigation.",
  "prompt": { "prefix": "You are a data scientist working inside the FiNess harness. …", "suffix": "…" },
  "tools": {
    "allow": ["read", "grep", "glob", "bash", "python.execute", "sql.query", "data.profile", "artifact.create"],
    "deny": ["production.write", "sql.write"]
  },
  "skills": ["statistics", "sql", "python", "experiment-design"],
  "evaluators": ["numerical-correctness", "statistical-validity", "evidence-grounding"],
  "tips": ["Report the query, the row count and the date range behind every number."],
  "commands": ["hypotheses"]
}
```

Optional fields: `model`, `models.requirements` (capability levels, see `capabilities.ts`) and
`tools.approval` (tool → approver).

- **Validated at load** by `validatePersonaFile`. A broken file is listed as broken and never crashes
  the launcher. `/persona check` (or `node scripts/finess.mjs persona check`) prints one line per
  issue as `personas/x.json:L:C path: message` and exits non-zero on errors.
- **Persona commands**: each name in `commands` loads `personas/<id>/commands/<name>.mjs` (same
  module shape as a global command) after the globals. Globals win; a collision is refused with a
  warning that names the owner. Ids and command names must match `^[a-z][a-z0-9-]*$`. How to write
  one, and what "only this persona" means: `docs/12-PERSONAS.md`.

`tools` are **enforced** by `@finess/tool-policy` (T-042, T-234): denied tools are not offered and
a call is refused with a reason. `models.requirements` feed the advisory capability router (T-253).
`skills` and `evaluators` are **declared, not enforced** until M5–M7; any command that displays them
must label them as declared, or the surface lies.

## Teams and multiple tasks (T-150..T-154)

A team is a named set of personas plus a task list: `teams/<id>.json`. v1 runs tasks **sequentially**
by default (`--parallel N` overlaps independent tasks since T-144),
each in its own `dsh` session under its own persona, collecting per-task status, artifacts and usage
into `.finess/runs/<timestamp>/`. That is a launcher loop, and it will be labelled as one — the real
implementation belongs on `ctx.subagents` and `ctx.jobs` (T-154), which already exist upstream.

`/team status [<id>]` (T-170) prints the newest run of team `<id>`, or of any team: one row per task
with persona, status (`ok` / `failed` / `not-run`), exit and seconds, then an `n/m ok` line with the
source and the run folder. "Newest" is the last folder name in alphabetical order (ISO stamps), not
the modification time. It does not need `teams/<id>.json`, so old runs stay readable after a team is
removed. It reads `summary.json` when present, otherwise the `- persona / - exit / - seconds` headers
of each `<task>.md`, and marks the run `(incomplete)` when there is no `summary.md`. Exit 0 when a run
is shown (even if tasks failed), 1 when there is none. `/team run` writes `summary.json` next to
`summary.md`: `{ v: 1, team, name, stamp, finishedAt, concurrency, ok, tasks: [{ id, member, persona,
dependsOn, status, exit, seconds, file }] }`, tasks in definition order, `file` a file name only.

Before any parallelism: measure. One local model serving two concurrent sessions contends for the
same weights, so "parallel" can be slower than sequential on a single machine.

## `/dashboard` — the task board (T-389)

`/dashboard` (alias `/dash`; `node scripts/dashboard.mjs` from a shell) writes a static
`.finess/dashboard.html` and opens it. No server, no network, zero tokens.

- **Backlog** first: every `- [ ] T-NNN` line of `docs/03-BACKLOG.md`, grouped by workstream, with
  subtasks under their parent. Each gets a P0–P3 picker saved in the browser's localStorage
  (`finess.backlog.priority`), so priorities survive regenerating the page; filter by workstream or
  priority, sort, and *copy as markdown* to paste the ranked list back into a doc or a prompt. The
  backlog file itself is rendered below (`scripts/lib/backlog.mjs`, no dependency).
- Then sessions (turns, tool calls, tokens, wall time, click-through timeline), shadow decisions and
  team runs.

Priorities are a per-browser view, not a source of truth: to make one stick, reorder the backlog file.

## Decision data: `/decide` and `/decisions-data` (WS-E)

`/decide <task>` asks the decision model and the rules the three routing questions side by side, and
logs the result. `/decisions-data` (alias `/dd`) turns those logs into evidence:

| Command | Does |
|---|---|
| `/dd` | labels per question, against the 50 the gate needs |
| `/dd label [--question q] [--limit N]` | blind labelling: the rules' and the model's answers shuffled and unmarked |
| `/dd label --relabel <id or task words>` | fix a label; the newest one wins |
| `/dd report [--write]` | accuracy, ECE and AUROC per question, model vs rules; `--write` publishes `docs/research/decision-calibration.md` |
| `/dd refit` | keeps a temperature refit only with 50+ labels and a held-out improvement |
| `/dd gate` | the calibration gate (T-223), one line per question: `PASS` or `HOLD — <why>`; reports only, applies nothing |

`/routing [--limit N]` (T-255) reads the same log, zero tokens: the last N shadow records (default
10) as `rules / model (confidence)` per question, then how often the model agrees with the rules per
question over the whole log, with each question's gate line. Agreement is not accuracy; only labels
say who was right.

Why and how: `docs/08-DECISION-LAYER-LAYA.md`.

## REPL basics

| Input | Does |
|---|---|
| `/exit` (alias `/quit`) | ends the prompt, like an empty line (T-148) |
| `/pers`, `/mo` | a unique prefix (or one every candidate extends: `/mo` is `/model`, not `/models`) of a name or alias runs that command; an exact name always wins; an ambiguous prefix (`/d`: `/dashboard`, `/decide`, …) lists the candidates and runs nothing (T-182) |
| `/config [<filter>]` | the resolved configuration and, for each value, its owner: built-in default, `finess.config.json`, `.finess/state.json`, a persona file or the environment; read-only, credentials masked (T-180) |
| `//etc/hosts is odd` | a leading `//` sends the line to the model with one slash removed, never to the registry (T-182) |
| `/btw <note>` | a side note for the next task (see `/btw` above) (T-130) |
| `#<note>`, `#`, `##…` | append to / show the project brief; `##` escapes a leading `#` (T-147) |
| `!<cmd>` | runs `<cmd>` locally in the agent's working directory (the repo root) and prints stdout+stderr; nothing goes to the model, zero tokens. The shell is `cmd.exe /d /s /c` on Windows and `/bin/sh -c` elsewhere (so `!ls` is Unix-only; `!git status` works on both), stdin closed, 120 s timeout. Refused under `/access read-only`. Bare `!` prints usage; `!` has no escape (T-181) |
| `!!<cmd>` | the same, and the output (capped at 50,000 characters, `attach.maxChars`) rides on the next task as an attachment `$ <cmd> (exit N)`; kept until a run succeeds, like `/btw` notes; pending `!!` output counts against the same 150,000 total (`attach.maxTotal`) as `@` references (T-181, T-448) |
| `@path` in a task | attaches the file (text only; a NUL byte means binary and is refused) or a directory's sorted listing (`name/` for folders, max 200 entries), resolved from the repo root. `@"a b.txt"` quotes spaces; trailing `.,;:!?)` is dropped. `@` counts only at the start or after whitespace or `( [ { ' " \``, so `me@example.com` never expands; a path that does not exist stays plain text with a note (T-181) |
| `@https://…` in a task | fetches the page (Node `fetch`, 10 s timeout, redirects followed, no cookies, auth or referrer; a URL with `user:pass@` is refused), HTML stripped to text, non-text types refused; the REPL says what it fetched (T-447) |
| plain text, 3+ characters | the dropdown suggests up to 6 earlier tasks that start with it (case-insensitive), newest first, labelled `recent`, from the persisted input history `.finess/history.jsonl` (cap 500; credential-looking lines are never written); lines starting with `/` or `#` are never suggested; Up/Down reaches earlier runs (T-303) |
| `/usage --by day` | tokens per local day and route across counted sessions (with `--all` / `--limit N`): day, route, model, sessions, calls, input and output tokens, newest day first. Each call is dated by its `assistant/message` event time (fallback: session `createdAt`, then log mtime) and bucketed by the local calendar date, never UTC; the header prints the offset. Any other `--by` value exits 1 (T-137) |

Attachments follow the task after `Attached by the operator (context for the task above):`, each fenced
`----- attached: <label> -----` … `----- end of <label> -----`, with `(truncated)` on the opening line when
clipped. Caps: 50,000 characters per item and 150,000 in total, each overflow warned; `attach.maxChars` and
`attach.maxTotal` in `finess.config.json` override them. No command-line limit applies: a composed task
(brief, notes, task and attachments) over 8,000 characters is written to a temp file under `.finess/run/`,
fed to headless dsh as stdin with the task argument `-`, and deleted after the run (the same for the REPL,
`finess run`, recipes, teams/delegate and loop-task rounds; `scripts/lib/taskarg.mjs`, T-448). Parsing and
expansion live in `scripts/lib/attach.mjs` (fs, fetch and spawn injected; `scripts/test/attach.test.mjs`).

## On the web: the commands bridge (ADR-0011)

The same command files answer in the web UI's message bar, with no second implementation. The
`@finess/commands` plugin (`packages/commands`, web profile only) registers each command with the
web UI's own slash-command registry and runs it as `node scripts/finess.mjs /<name> <args>`:
exit 0 is a success reply, anything else an error reply, the text is what the REPL prints (ANSI
stripped). User guide: `docs/06-SETUP-AND-LAUNCHER.md` (*Quick-tools in the message bar*).

What a command file controls:

- **`web: false`** keeps it off the web: it only makes sense in the terminal (`/new`, `/resume`,
  `/btw`, `/web`, `/off`, `/help`, `/exit` today). Everything else, persona commands included, is on the web by default.
- `summary` becomes the menu description and the part of `usage` after the name the input hint, so
  write both. Aliases are registered too.
- A command that prompts gets no terminal there: stdin is closed. Refuse cleanly, as
  `/dd label` does ("labelling needs a terminal"), rather than waiting.

The list comes from `node scripts/finess.mjs --list-commands` (JSON: `name`, `summary`, `usage`,
`aliases`, `web`; the active persona's commands included). A name the web UI already owns
(`/model`, `/file`, `/compact`, `/export`, `/feedback`, `/goal`, `/permission`, `/plan`) is never
registered, so the substrate's version keeps working. From the command line, an unknown `/word` is now
an error rather than a task, so a stale web entry can never start a model run.

## Challenges, recorded before coding

1. **Registry discipline** — if a command ever needs a second edit somewhere else, the design has
   failed. Enforce with a test that loads every file in `scripts/commands/` and asserts the shape.
2. **Session logs are `session.v4.jsonl.zstd`, concatenated zstd frames.** `zstdDecompressSync`
   decodes only the first frame, which is why a 15 KB log appeared to hold a single event. `/cost`
   and `/usage` depend on reading these, so prefer the supported path
   (`@deepseek-ai/dsh-session-query` and its tool) over parsing the format ourselves — a
   self-parsed format breaks on the next version bump. **Unresolved; blocks T-133/T-134.**
3. **Never invent a cost.** Report tokens and duration. Cost is `0` on a local route; a paid route
   needs a price table the operator writes. No estimated dollars from a guessed rate.
4. **Config is commented JSONC.** Commands that mutate settings must not destroy those comments.
   Decision (T-131): mutable state goes to a separate `finess.state.json` and the commented file
   stays operator-owned. Simpler and lossless; the alternative is a surgical JSONC rewriter.
5. **Persona switching must be atomic** — write state, regenerate patch, sync, confirm. A
   half-applied switch silently answers as the wrong identity.
6. **Declared vs enforced** must be visible everywhere policy is displayed (see personas above).
7. **`/` collision** — a task that legitimately begins with `/` (a POSIX path) needs an escape:
   `//` sends the line literally.
8. **Discoverability without autocomplete** — grouped `/help`, unique-prefix matching (`/mo` →
   `/model`), and "did you mean" on an unknown command.
9. **Windows first** — `.ps1` is blocked by execution policy, so everything must work through
   `turn_on.cmd` and in a plain pipe (no ANSI, no TTY assumptions).
10. **Team failure semantics** — decide up front what happens when task 3 of 5 fails: stop, skip, or
    retry once. Silence here produces half-finished runs nobody can interpret.
11. **Surfacing, not rebuilding** — `/compact`, `/export`, `/todos`, `/mcp`, `/rewind` all exist
    upstream. Reimplementing any of them is the most likely way to waste a week.
