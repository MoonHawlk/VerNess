# ADR-0008 — Quick-tools as one-file launcher commands; personas as files

- Status: accepted (design); implementation tracked as T-130..T-172
- Date: 2026-09-26

## Context
We want a Claude-Code-like surface — `/cost`, `/usage`, `/agents`, `/model`, `/btw` and more — plus
real personas (Data Scientist, Analyst, Engineer…) and the ability to run several tasks across a team
of them. The requirement is explicitly about *simplicity*: adding a command must stay trivial, and the
surface must stay organised as it grows.

A survey of Claude Code's capabilities (`docs/research/claude-code-capability-map.md`) shows three
distinct classes, and conflating them is how such a surface rots:
1. things that need no model at all (`/cost`, `/model`, `/help`, `/sessions`),
2. things the substrate already implements and only need exposing (`/compact`, `/export`, `/todos`,
   `/mcp`, `/rewind`),
3. things that are really *identity* rather than commands (`/agents`, `/permissions`,
   `/output-style`, `/review`) — all of which collapse into the persona concept.

## Decision
- **Commands are one file each**: `scripts/commands/<name>.mjs`, auto-discovered by a registry, each
  exporting `{ name, summary, usage, group, run(ctx, args) }`. `/help` is generated from the registry.
  Adding a command means adding one file — enforced by a conformance test (T-135).
- **Commands are zero-token by default.** They run in the launcher. One that needs the model must say
  so in its summary.
- **Personas become files** under `personas/<id>.yaml` — identity, prompt, model requirements, tool
  policy, skills, evaluators, and commands the persona adds — superseding the inline block in
  `verness.config.json`. Class 3 above is implemented once, as a persona, not as N commands.
- **Teams** are `teams/<id>.yaml`: member personas, an ordered task list, and a failure policy. v1 is
  a sequential launcher loop, explicitly labelled as such, to be re-based on `ctx.subagents` and
  `ctx.jobs` (T-172).
  *Amended 2026-09-26 (T-144):* the launcher loop now runs independent tasks concurrently when asked
  (`--parallel N` or a team's `concurrency`); the default is still 1, i.e. sequential. The re-base on
  `ctx.subagents`/`ctx.jobs` is unchanged.
- **Mutable state leaves the config file**: commands write `verness.state.json`; the commented
  `verness.config.json` stays operator-owned so hand-written comments are never destroyed (T-131).

## Why not implement commands as a dsh plugin
The substrate's own slash commands live in the web surface (`dsh-session-log-export` ships `/export`).
A plugin is the right home for anything that must reach session state — and T-150..T-161 do exactly
that. But the *cheap* commands must not pay a model round trip or a plugin mount to answer "how many
tokens did I spend", so the launcher owns class 1. Two homes, chosen by whether the substrate is
needed, not by convenience.

## Consequences
- Declared-vs-enforced becomes a standing honesty requirement: persona `tools`, `skills`,
  `evaluators` and model requirements are recorded now and only enforced from M4/M5/M7. Any surface
  that prints them must label them **declared** (T-166), or the UI lies about its own policy.
- `/cost` and `/usage` are blocked on reading session logs, which are concatenated zstd frames that
  `zstdDecompressSync` only partially decodes. The supported route
  (`@deepseek-ai/dsh-session-query`) is preferred over parsing the format ourselves (T-133).
- Cost is never estimated: tokens and duration are reported, `0` on a local route, and a paid route
  needs an operator-written price table.
- Command breadth should follow M4, since the persona concept absorbs a third of the surface.
- `/` needs an escape (`//`) so a task beginning with a POSIX path still works.

## Amendment (2026-09-26, M2)
- Personas shipped as **JSON/JSONC** files, `personas/<id>.json`, not YAML. The shape is `PersonaFile`
  in `@verness/contracts`; every file is validated at load by `validatePersonaFile`, and
  `/persona check` reports issues as `personas/x.json:L:C path: message`.
- A persona's `commands` load `personas/<id>/commands/<name>.mjs` after the global commands; globals
  win and a collision warns, naming the owner.
- Teams likewise shipped as `teams/<id>.json`.
