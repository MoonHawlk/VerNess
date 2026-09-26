# Claude Code capability map

Purpose: choose VerNess's command surface deliberately instead of accumulating it. Every row is a
user-facing Claude Code capability mapped to where it would live here.

Target column:
- **L** — launcher-local command (`scripts/commands/*.mjs`), costs zero tokens
- **S** — needs a substrate seam / plugin (`ctx.*`, a Cordis event)
- **P** — persona / team concept (config + M4 enforcement)
- **N** — not applicable to a headless harness, or deliberately out of scope

Compiled from the assistant's own knowledge of Claude Code and this session's surfaced command and
skill listings. Availability differs by version and plan, so treat names as intent, not as a
contract; anything we copy should be re-checked against `claude --help` at implementation time.

## Slash commands

| Claude Code | What it does | Target | VerNess note |
|---|---|---|---|
| `/help` | list commands | L | generate from the registry so it cannot drift |
| `/clear` | drop conversation context | L | start a fresh `--session-id` |
| `/compact` | summarise and shrink context | S | `packages/compaction` exists upstream; expose, don't rebuild |
| `/context` | show what fills the context window | S | needs the assembled prompt; read from the session log |
| `/cost` | tokens + spend for the session | L | local route is $0 — report tokens and wall time, never a guessed price |
| `/usage` | plan/quota consumption | L | our analogue: tokens per route per day from session logs |
| `/model` | show / switch model | L | rewrite `activeRoute`, regenerate patch, re-sync |
| `/config` | view and edit settings | L | print resolved config + the file path; editing stays in the file |
| `/doctor` | environment health | L | already implemented as a launcher verb |
| `/status` | account, model, connections | L | merge `doctor` + engine `stats` |
| `/init` | bootstrap project memory (CLAUDE.md) | L | generate a project brief for the persona prompt |
| `/memory` | edit memory files | S | Hermes-style memory is parked until after M5 |
| `/agents` | manage subagents | P | list personas and teams; later `ctx.subagents` providers |
| `/mcp` | manage MCP servers | S | `packages/mcp` upstream; surface servers and tool filters |
| `/permissions` | allow/deny tool rules | S+P | persona `tools.allow`/`deny` enforced on `tools/pre-execute` (M4) |
| `/hooks` | configure lifecycle hooks | S | our hooks are Cordis listeners; expose a read-only list first |
| `/resume`, `--continue` | reopen a past session | L | `dsh --session-id`; list from `$DSH_HOME/sessions` |
| `/rewind` | restore an earlier checkpoint | S | session replay/fork exists upstream; needs a UX decision |
| `/export` | export the transcript | S | `dsh-session-log-export` already ships `/export` — reuse |
| `/todos` | show the task list | S | `ctx.todo` is mounted; render its projection |
| `/review`, `/security-review` | review a diff | P | a reviewer persona + evaluator suite (M7) |
| `/plugin`, marketplaces | install extensions | S | `ctx.pluginManager` + `dsh plugin`; our plugins are config rows |
| `/output-style` | change response style | P | a persona field, not a separate system |
| `/statusline` | custom status line | N | no persistent TUI chrome in headless |
| `/vim`, `/terminal-setup` | editor bindings | N | the REPL is line-based |
| `/bug`, `/release-notes`, `/privacy-settings`, `/upgrade`, `/login`, `/logout` | account & product plumbing | N | product-specific |
| `/install-github-app` | CI integration | N | later, if VerNess ever ships CI |
| `/loop`, `/schedule` | recurring / scheduled runs | S | `ctx.schedule` + `ctx.jobs` are already mounted |
| `/artifacts` | published pages | N | out of scope |
| `/code-review ultra` | multi-agent cloud review | P | the team concept, run locally |
| `/exit` | quit | L | empty line already exits; add for symmetry |

## Non-command capabilities

| Capability | Target | VerNess note |
|---|---|---|
| CLI: `-p/--print`, `--output-format json` | L | `dsh --profile … "task" --json` exists; wire `run --json` |
| CLI: `--resume`, `--continue`, `--model`, `--add-dir` | L | launcher flags mapping onto `dsh` flags |
| CLI: `--permission-mode`, `--allowedTools` | S+P | same seam as `/permissions` |
| `!` bash-mode prefix | L | REPL: `!<cmd>` runs a shell command locally, no model call |
| `@path` file mention | L | expand `@file` into the task text before dispatch |
| `#` memory-add prefix | L | the `/btw` sibling: `#` appends to persona/project notes |
| Keybindings, chords, autocomplete | N | line-based REPL; `/help` and prefix matching substitute |
| `CLAUDE.md` hierarchy + `@` imports | L | persona prompt + project brief assembled by the launcher |
| `settings.json`, permission rules | L+S | `verness.config.json` is ours; enforcement is M4 |
| Hooks (PreToolUse, Stop, SessionStart, …) | S | Cordis events cover the same ground with types |
| Built-in tools (read/write/edit/bash/glob/grep/web) | S | inherited from the substrate; nothing to build |
| Subagents with own tools/model | P+S | personas today, `ctx.subagents` providers later |
| Skills (`SKILL.md`, progressive disclosure) | S | M5, via `ctx.skills.registerProvider` |
| MCP servers (stdio/SSE/HTTP), tools as `mcp__*` | S | `packages/mcp`; personas filter them like any tool |
| Plan mode / auto-accept / permission modes | S | `packages/plan` + approval seam |
| Background tasks, output polling | S | `ctx.jobs` |
| Auto-compaction | S | `packages/compaction` |
| Checkpoints, session fork/replay | S | durable session log |
| Cost/usage telemetry, OTEL export | L | session-log derived; OTEL only if someone asks |
| IDE extensions, diff view | N | |
| Agent SDK / programmatic use | S | `dsh-sdk` profile template already exists |
| Cloud/remote sessions, teammates | N | |

## What this map implies

1. The high-value, low-cost surface is **L**: roughly a dozen commands that never call a model.
2. Most **S** rows are already mounted in the substrate — they need *surfacing*, not building. Every
   one of those is a candidate to get wrong by reimplementing.
3. `/agents`, `/permissions`, `/output-style`, `/review` all collapse into **one** VerNess concept:
   the persona. That is the strongest signal that personas (M4) should precede command breadth.
