---
name: verness-tools
description: Use in the VerNess repo before grepping, reading files one by one, or chaining git/test commands - to locate code or docs, check the backlog or a task ID, see branch state, run tests, audit docs, list quick-tools, check the Engram graph, or inspect the dsh profiles. Lists the repo's read-only tool scripts and when to use each.
---

# VerNess tools

## Overview

`scripts/tools/*.mjs` are small read-only scripts whose output is the answer you would otherwise
assemble from grep, git and file reads. Use them first: one call instead of five, the same output
every time, and far fewer tokens. They are plain Node, so they behave the same on macOS and Windows.

**Core rule:** locate through the tools (the Engram graph for code, a scan for docs), then read only
the lines they point to. Do not run Engram's semantic doc extraction; the code graph is free.

## The tools

Run from the repo root: `node scripts/tools/<tool>.mjs [args]`. Every tool takes `--help`.

| Tool | Use it to | Example |
|---|---|---|
| `where.mjs` | find a function, file or concept: code definitions with `file:line`, community and neighbours from the graph, plus every doc line that mentions it | `where.mjs readAnswer` · `where.mjs persona family --limit 5` · `--code-only` / `--docs-only` |
| `backlog.mjs` | open tasks per workstream, where a task ID lives (open/done/unused), the next free ID, duplicate-ID check | `backlog.mjs --ws WS-E` · `backlog.mjs T-223 T-398` · `backlog.mjs --next-id` · `backlog.mjs --check` |
| `repo.mjs` | branch, uncommitted files, stashes, every local branch vs origin, epic vs main, latest tag | `repo.mjs` |
| `tests.mjs` | run the suite and get counts plus only the failures; exit code = result | `tests.mjs` · `tests.mjs calibration` · `tests.mjs --typecheck` |
| `docs.mjs` | docs audit: each doc's status line, outdated status versions, broken relative links, "not built" statuses to confirm | `docs.mjs` · `docs.mjs --problems` |
| `commands.mjs` | every quick-tool, global and persona-scoped, with owner and group; persona/global clashes | `commands.mjs` · `commands.mjs dd` |
| `graph.mjs` | Engram code-graph size, the commit it was built from, whether code changed since, top hubs; rebuild | `graph.mjs` · `graph.mjs --rebuild` |
| `release-notes.mjs` | draft the next `CHANGELOG.md` entry: done tasks since the last tag grouped Added / Changed / Fixed, Upgrade when setup inputs changed, a review list of what it could not place | `release-notes.mjs` · `release-notes.mjs --since v0.3.0 --to v0.4.0` |
| `profiles.mjs` | the dsh profiles on this machine: bundles, plugins and web bundles vs installed, undecided pnpm build scripts, patch rows | `profiles.mjs` |

## When to use which

- **Before editing anything:** `where.mjs <thing>`. Read only the files and lines it lists.
- **Before adding a task or ID:** `backlog.mjs --next-id`, and `backlog.mjs --check` after.
- **Before a commit, merge or push:** `tests.mjs` (and `--typecheck` if contracts changed), `repo.mjs`.
- **After changing code:** `graph.mjs --rebuild`, so the next `where.mjs` sees it.
- **After changing docs:** `docs.mjs --problems`.
- **A panel, plugin or bundle is missing, or setup warned:** `profiles.mjs`, then fix it in
  `verness.config.json` and re-run setup. Never hand-edit `~/.dsh/profiles` (it must work the same on macOS and Windows).

## Adding a tool

One file in `scripts/tools/`, Node only (no shell syntax), read-only, `--help` via `helpIf` from
`_lib.mjs`, and a short answer-shaped output. `scripts/test/tools.test.mjs` checks every tool's
`--help` automatically. Add a row to the table above.
