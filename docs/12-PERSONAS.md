# 12 — Personas: creating one, and giving it commands only it can run

> Status: persona files and persona-scoped commands are **built** (M2, ADR-0008). Tool policy,
> skills and evaluators are **declared, not enforced** until M4–M7. The planned catalog of new
> personas is WS-I (`superpowers/plans/2026-09-26-09-persona-catalog.md`); the catalog is section 5.

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
    "prefix": "You are a QA engineer working inside the FiNess harness.",
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
| `tools.allow` / `deny` / `approval` | **enforced** by `@finess/tool-policy` on `tools/pre-execute` (T-042): deny wins, a non-empty `allow` blocks everything else, `approval: ask` asks once (refused without an approval channel), empty = unrestricted; `bash` and `pwsh` count as one shell. A refused call returns `tool <name> is not allowed for persona <id> (...)`. `/permissions` prints the active policy, `/tools` marks each offered tool |
| `skills`, `evaluators` | declared free strings; checked from M5/M7 |
| `model`, `models.requirements` | optional model preferences (see T-361 for per-persona presets) |
| `tips` | **applied**: appended to the prompt after the suffix, following the global `tips` from the config |
| `commands` | **applied**: the persona-scoped commands to load (section 2) |

Every file is validated at load against `@finess/contracts` (`validatePersonaFile`). A broken file
is listed as broken; it never crashes the launcher. Run:

```sh
/persona check                         # in the REPL
node scripts/finess.mjs persona check # from a shell; exits non-zero on errors
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

## 5. The catalog, and choosing between personas

Sixteen persona files, plus `generalist`, which is defined inline in `finess.config.json`. Tool
lists are **declared** until M4 enforces them (T-042). "asks" means the tool needs your approval.

| Family | Persona | Job | Tools (allow / deny, ask) | Own command |
|---|---|---|---|---|
| data | `data-analyst` | Descriptive analysis and reporting over structured data; reduces questions to queries. | - / shell.execute | - |
| data | `data-engineer` | Pipelines, schemas, ingestion and the plumbing that moves data. | read, grep, glob, bash, sql.query, sql.write, spark.submit / pipeline.deploy | - |
| data | `data-scientist` | Statistical analysis, experiment design, modelling and data investigation. | read, grep, glob, bash, python.execute, sql.query, data.profile, artifact.create / production.write, sql.write | `/hypotheses` |
| engineering | `csharp-developer` | C#/.NET changes that build, pass `dotnet test` and follow the solution's conventions. | read, write, edit, grep, glob, bash / - | `/dotnet-check` |
| engineering | `devops-engineer` | CI/CD pipelines, containers, infrastructure-as-code and releases. | read, write, edit, grep, glob, bash / pipeline.deploy, production.write; asks: bash | `/release-check` |
| engineering | `frontend-developer` | Web UI in HTML/CSS/TypeScript: components, layout and accessibility. | read, write, edit, grep, glob, bash, web.fetch / - | `/a11y` |
| engineering | `qa-engineer` | Test strategy, test cases, regression suites and reproducible bug reports. | read, write, edit, grep, glob, bash / production.write | `/testplan` |
| engineering | `security-engineer` | Threat modelling, secure code review, and dependency/secret hygiene. | read, grep, glob, bash, web.fetch / write, edit | `/threats` |
| engineering | `software-engineer` | Reads the codebase, makes the smallest correct change, and verifies it. | read, write, edit, grep, glob, bash / - | - |
| business | `customer-support` | Ticket triage, reply drafts and known-issue summaries; drafts only, a human sends. | read, grep, glob, write / bash, edit, sql.write, production.write, web.fetch | `/triage` |
| business | `hr-specialist` | Job descriptions, interview plans, HR policy drafts and onboarding checklists; never decides about real people. | read, grep, glob, write, edit / bash, shell.execute, web.fetch, sql.query, sql.write, production.write; asks: write | `/jd-check` |
| business | `product-manager` | Requirements, PRDs, user stories and prioritisation; turns problems into testable scope. | read, grep, glob, write, edit, web.search / bash, sql.write, production.write | `/prd` |
| business | `project-manager` | Plans, milestones, status reports and risk registers; tracks what is done against what was promised. | read, grep, glob, write, edit / bash, sql.write, production.write, pipeline.deploy | `/raid` |
| business | `technical-writer` | Docs, READMEs, release notes and API reference, written from the code and verified against it. | read, grep, glob, write, edit, bash / sql.write, production.write, web.fetch; asks: bash | `/release-notes` |
| research | `researcher` | Investigates open questions and reports findings with their sources. | read, grep, glob, web.search, web.fetch / write, edit, bash | - |
| research | `reviewer` | Checks work it did not do; verifies claims; never edits. | read, grep, glob, bash / write, edit | - |

### Which persona do I pick?

Where two personas look alike, this is the line between them:

| If you want to… | Pick | Not |
|---|---|---|
| change product code | `software-engineer` | `reviewer` (never edits) |
| change C#/.NET code with `dotnet build`/`test` as proof | `csharp-developer` | `software-engineer` (same tools, no .NET focus) |
| build or fix web UI, with accessibility checked | `frontend-developer` | `software-engineer` |
| write tests and reproducible bug reports | `qa-engineer` | `reviewer` (checks, but never writes tests) |
| check whether finished work is correct | `reviewer` | `qa-engineer` (writes new tests) |
| check whether something is exploitable | `security-engineer` (read-only) | `reviewer` (correctness, not threats) |
| find out what is true, with sources | `researcher` | `product-manager` |
| decide what to build and write testable scope | `product-manager` | `researcher` |
| track who delivers what by when, and the risks | `project-manager` | `product-manager` (scope, not delivery) |
| write or fix docs and release notes | `technical-writer` | `reviewer` |
| pipelines, containers, releases | `devops-engineer` | `data-engineer` (data pipelines) |
| draft a customer reply | `customer-support` (drafts only) | — |
| draft a job description or HR policy | `hr-specialist` (never judges real people) | — |

The full spec of each new persona, including its prompt, is in
`superpowers/plans/2026-09-26-09-persona-catalog.md`. A new persona adds its row here and, if it
overlaps an existing one, a line in the table above.
