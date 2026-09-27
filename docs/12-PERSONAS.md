# 12 — Personas: creating one, and giving it commands only it can run

> Status: persona files and persona-scoped commands are **built** (M2, ADR-0008). Tool policy,
> skills and evaluators are **declared, not enforced** until M4–M7. The planned catalog of new
> personas is WS-I (`superpowers/plans/2026-09-26-09-persona-catalog.md`). T-394 adds the catalog
> table to this file.

A persona is **one JSON file** (who the agent is and what it may use) plus, optionally, **its own
commands**: small `/commands` that exist only while that persona is active. A data scientist gets
`/hypotheses`; a QA engineer will get `/testplan`. Switch persona and the command bar changes with it.

---

## 1. The persona file

`personas/<id>.json`. The file name must equal `id`, and both match `^[a-z][a-z0-9-]*$`. JSONC is
fine (comments, trailing commas).

```jsonc
{
  "id": "qa-engineer",
  "name": "QA Engineer",
  "description": "Test strategy, test cases, regression suites and reproducible bug reports.",
  "family": "engineering",                 // data | engineering | business | research
  "prompt": {
    "prefix": "You are a QA engineer working inside the VerNess harness.",
    "suffix": "Derive cases from the requirement, not from the code. Run the tests and quote real output."
  },
  "tools": {
    "allow": ["read", "write", "edit", "grep", "glob", "bash"],
    "deny": ["production.write"],
    "approval": { "bash": "ask" }          // allow | ask | deny
  },
  "skills": ["testing", "test-design"],
  "evaluators": ["tests-pass", "evidence-grounding"],
  "tips": ["Never weaken an assertion to make a test pass."],
  "commands": ["testplan"]                  // this persona's own commands (section 2)
}
```

| Field | What it does today |
|---|---|
| `id`, `name`, `description` | identity; shown by `/persona`, `/agents` |
| `family` | **applied**: `data`, `engineering`, `business` or `research`; `/persona` and `/agents` group by it, and two-stage routing (T-396) will use it. Optional; a persona without one is listed under `other` |
| `prompt.prefix` / `prompt.suffix` | **applied**: injected around the system prompt when the persona is active |
| `tools.allow` / `deny` / `approval` | declared, validated (a tool cannot be both allowed and denied); enforced from M4 (T-042) |
| `skills`, `evaluators` | declared free strings; checked from M5/M7 |
| `model`, `models.requirements` | optional model preferences (see T-361 for per-persona presets) |
| `tips` | **applied**: appended to the prompt after the suffix, following the global `tips` from the config |
| `commands` | **applied**: the persona-scoped commands to load (section 2) |

Every file is validated at load against `@verness/contracts` (`validatePersonaFile`). A broken file
is listed as broken; it never crashes the launcher. Run:

```sh
/persona check                         # in the REPL
node scripts/verness.mjs persona check # from a shell; exits non-zero on errors
```

It prints each problem as `personas/x.json:line:column path: message`.

## 2. Persona-scoped commands

A persona-scoped command is a normal command module that lives with its persona instead of in
`scripts/commands/`:

```
personas/
  qa-engineer.json                 "commands": ["testplan"]
  qa-engineer/
    commands/
      testplan.mjs                 -> /testplan, only while qa-engineer is active
```

### How it is loaded
1. The global commands in `scripts/commands/*.mjs` load first.
2. Then, **for the active persona only**, each name in its `commands` list loads
   `personas/<id>/commands/<name>.mjs`.
3. When you switch persona (`/persona <id>`), the REPL reloads the registry in place. The old
   persona's commands disappear, the new one's appear, and tab completion follows.

### Rules the loader enforces
- **Globals always win.** If a persona command's name, *or any of its aliases*, matches a global
  command, the whole persona command is refused with a warning naming the owner. A persona can never
  redefine `/help`.
- **Listed but missing** (`commands` names a file that does not exist): warned about and skipped.
- **Names** must match `^[a-z][a-z0-9-]*$`, with no leading slash. Anything else is refused, so a
  name can never escape `personas/<id>/commands/`.
- A module that exports no `{ name, run }` is warned about and skipped.

### What "only this persona can run it" means
While another persona is active, the command is not in the registry: typing it gives
`no such command`, and it is not in the command bar or tab completion. That scoping is about **what
is offered**. It is not a security boundary, because anyone can still read or import the `.mjs`
file. Security belongs in tool policy (M4).

## 3. Writing the command

Same module shape as a global command. Copy `personas/data-scientist/commands/hypotheses.mjs`:

```js
/**
 * `/testplan <feature>` — a persona-scoped command for `qa-engineer`: a fixed test-plan checklist.
 * Zero tokens: the launcher runs it in-process, with no model call.
 * @module personas/qa-engineer/commands/testplan
 */
import { head, info, line } from '../../../scripts/lib/util.mjs'

export default {
  name: 'testplan',                 // must equal the file name and the entry in "commands"
  group: 'personas',                // where /help and the command bar list it
  summary: 'fixed test-plan checklist for a feature',
  usage: '/testplan <feature>',
  run(ctx, args) {                  // ctx: { cfg, commands, sh, dsh, conversation, ... }
    head(`test plan: ${args.join(' ') || '(feature)'}`)
    for (const l of ['scope', 'happy path', 'boundaries', 'invalid input', 'error paths']) line(`  - ${l}`)
    info('a checklist, not a test run')
    return 0                        // exit code
  },
}
```

Guidelines:
- **Zero tokens by default.** A persona command should work with no model call: a checklist, a
  template, a local computation, a file listing. It runs instantly and costs nothing, which is the
  point of the command layer. If it needs the model, say so in `summary`.
- **Keep the persona's own domain.** A command belongs to a persona only when it is that persona's
  job (`/threats` for security, `/raid` for a project manager). If every persona would want it, it is
  a global command in `scripts/commands/`.
- Import helpers from `scripts/lib/util.mjs` (`head`, `info`, `line`, `warn`, `table`) so the output
  looks like every other command.
- Add a small `node:test` for its output under `scripts/test/`.

## 4. Checklist: adding a persona with a command

1. Create `personas/<id>.json`, with `"commands": ["<name>"]`.
2. Create `personas/<id>/commands/<name>.mjs`.
3. Check that `<name>` is not a global command or alias (`/help` lists them all).
4. Run `/persona check`: it must report the file ok.
5. Run `/persona <id>`: `/<name>` appears in the command bar and runs. Switch back: it is gone.
6. Run `npm test`. Once T-393 lands, it fails on a bad persona file, a missing command file or a
   name clash.
7. Record the task in `docs/03-BACKLOG-DONE.md` and `docs/04-PROGRESS.md`.

## 5. Choosing between personas

Every persona states in one line how it differs from its neighbours, so two personas never do the
same job. The existing pairs to keep apart: `reviewer` checks work and never edits, while
`software-engineer` changes code. The new catalog's boundaries (for example qa-engineer vs reviewer,
csharp-developer vs software-engineer, product-manager vs researcher) are in the WS-I plan, and T-394
turns them into the table in this file.
