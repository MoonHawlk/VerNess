# 07 — Command layer and quick-tools (planned, not yet built)

> Status: **design only.** Nothing in this document is implemented. Tasks T-130..T-166 in
> `docs/03-BACKLOG.md` track the work. Capability survey: `docs/research/claude-code-capability-map.md`.

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
summary and asks for confirmation.

## `/btw` — the first command to build (T-130)

`/btw <note>` is "by the way": a side note that steers the next task without becoming a task.

The headless surface is one-shot per invocation, so whatever continuity exists between REPL turns is
what the launcher chooses to resend. `/btw` makes that explicit and bounded.

| Form | Behaviour |
|---|---|
| `/btw <text>` | append to the note buffer; confirm with the note count and total characters |
| `/btw` | print the current buffer with indices |
| `/btw clear` | empty the buffer |
| `/btw drop <n>` | remove one note |

- Buffer persists at `.verness/run/notes-<sessionId>.json` so a crash does not lose it.
- The next dispatched task is prefixed with a clearly delimited block:
  `Side notes from the operator (context, not tasks):` followed by the notes.
- Hard cap (default 2000 characters, configurable) with a warning at 80%: notes ride on *every*
  subsequent turn, so an unbounded buffer is a silent, growing token bill.
- `/btw` is a **resend**, which is a deliberate compromise. The substrate's invariant is
  "model-visible means logged", so the correct end state is a durable `SessionEvent` contributed by a
  plugin (T-161). Until then the launcher owns it and the docs say so.

## Personas as files (T-140..T-143, built in M2 as T-162..T-165)

A persona is one file, `personas/<id>.json` (JSONC: comments and trailing commas allowed). Files win
over inline `verness.config.json` definitions with the same id. The shape is `PersonaFile` in
`@verness/contracts` (`packages/contracts/src/persona.ts`), e.g. `personas/data-scientist.json`:

```json
{
  "id": "data-scientist",
  "name": "Data Scientist",
  "description": "Statistical analysis, experiment design, modelling and data investigation.",
  "prompt": { "prefix": "You are a data scientist working inside the VerNess harness. …", "suffix": "…" },
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
  the launcher. `/persona check` (or `node scripts/verness.mjs persona check`) prints one line per
  issue as `personas/x.json:L:C path: message` and exits non-zero on errors.
- **Persona commands**: each name in `commands` loads `personas/<id>/commands/<name>.mjs` (same
  module shape as a global command) after the globals. Globals win; a collision is refused with a
  warning that names the owner. Ids and command names must match `^[a-z][a-z0-9-]*$`.

`tools`, `skills`, `evaluators` and `models.requirements` are **declared, not enforced** until
M4–M7 land. Any command that displays them must label them as declared, or the surface lies.

## Teams and multiple tasks (T-150..T-154)

A team is a named set of personas plus a task list: `teams/<id>.json`. v1 runs tasks **sequentially**
by default (`--parallel N` overlaps independent tasks since T-144),
each in its own `dsh` session under its own persona, collecting per-task status, artifacts and usage
into `.verness/runs/<timestamp>/`. That is a launcher loop, and it will be labelled as one — the real
implementation belongs on `ctx.subagents` and `ctx.jobs` (T-154), which already exist upstream.

Before any parallelism: measure. One local model serving two concurrent sessions contends for the
same weights, so "parallel" can be slower than sequential on a single machine.

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
   Decision (T-131): mutable state goes to a separate `verness.state.json` and the commented file
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
