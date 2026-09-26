# Web commands bridge — design

- Status: draft, for review
- Date: 2026-09-26
- Branch: `web-commands` (from `epic` 5338fd4)

## Goal
The quick-tools you use in the CLI REPL (`/cost`, `/usage`, `/persona`, `/api`, …) also work when
typed in the web UI's message bar, with the same behaviour and output, without a second
implementation of any command.

Success: in `./turn_on.sh web`, typing `/` lists the VerNess commands beside the substrate's own;
running `/cost` shows the same text as `/cost` in the REPL; `/model`, `/help` and the other
substrate commands keep working exactly as before.

## Out of scope
- **Per-persona `tools.allow` / `tools.deny`.** Not enforced on any surface yet (config says M4).
  Enforcing them is its own feature.
- **Sandbox mode.** Already shared: `web` boots through `prepareBoot` → `routeEnvironment`, which
  sets `DSH_PERMISSION_MODE` exactly as the REPL does. It is read at server start; see Limits.
- Interactive commands (prompting for more input) and a rich UI (popups) for any command.

## Approach
A new local plugin `@verness/commands` (plain ESM, like `packages/spike`) mounted in the web
profile. It does not load command modules itself: it runs the launcher, so every command keeps its
one implementation and the launcher-built context (`cfg`, `sync`, `builtins`, …) it expects.

```
browser  "/cost --week"
   │  dsh-commands (host)             @verness/commands                 launcher
   └───────────────▶ handler(invocation) ──spawn──▶ node scripts/verness.mjs cost --week
                                   ◀── stdout+stderr, exit code ───┘
                     { kind: 'success' | 'error', text }
```

### 1. Launcher: machine-readable command list
`node scripts/verness.mjs --list-commands` prints JSON, one entry per command (aliases folded in):

```json
[{ "name": "cost", "summary": "…", "usage": "/cost [--week]", "aliases": [], "web": true }]
```

A command definition gains an optional `web: false` for commands that only make sense in the
terminal. It is set on:

| command | why not on the web |
|---|---|
| `new`, `resume` | switch the terminal REPL's conversation, not the web session |
| `web` / `ui` | would start a second web server from inside the first |
| `off` | kills the server that would render its reply; stays a terminal command |
| `help` | clashes with the substrate's `/help`; lists terminal commands |

`--list-commands` is a flag, never a command word, so it cannot collide with a quick-tool.

### 2. Plugin: register on `ready`, skip taken names
- Config (generated into the patch row): `{ repo: <absolute path of the checkout> }`.
- `apply(ctx, config)`: run `--list-commands` once (synchronously, 5 s cap). On failure, log one
  line and register nothing; the web UI still boots.
- Registration waits for cordis `ready`, so every substrate command plugin has registered first.
  Each `web: true` command (and each alias) is registered with `ctx.commands.register`; a name that
  throws "already registered" is skipped and logged once, e.g.
  `verness-commands: /model left to the substrate`.
- Each registration: `definitionId` `@verness/commands:<name>`, `description` = summary,
  `input.hint` = the usage line after the name, `recordInput: true`.

### 3. Handler
- `spawn(process.execPath, [repo/scripts/verness.mjs, name, ...words(rawInput)], { cwd: repo,
  stdin: 'ignore', env: { ...process.env, NO_COLOR: '1', VERNESS_NO_PET: '1' } })`.
  No shell; words split on whitespace with simple quote handling (same rule the REPL uses).
- `invocation.signal` aborts the child (SIGTERM). No fixed timeout: `/team` and `/loop-task` are
  long by design and the UI owns cancellation.
- Output: stdout + stderr in order, ANSI escapes stripped, trimmed. Exit 0 → `success`, otherwise
  `error` with the output (or `exit <code>` when empty).
- The child inherits the server's environment, so `DSH_PERMISSION_MODE` and route keys match the
  running web session.

### 4. Wiring
- `verness.config.json` `settings.plugins` gains
  `{ "id": "verness-commands", "package": "@verness/commands", "path": "packages/commands",
  "enabled": true }`. `writePatch` adds `config.repo` to this row. `ensureProfile` already installs
  `path` plugins into both profiles; nothing else in the launcher changes.
- The plugin declares `inject = ['commands']`. The headless profile mounts no command service
  (upstream: "headless, ACP, and JSON-RPC entry points provide no slash commands"), so there the
  plugin never applies and costs nothing. The spike confirms this; if headless does mount
  `commands`, the fallback is an optional `surfaces: ["web"]` plugin field and a per-profile patch
  render in `syncPatch`.

## Limits (documented, not fixed)
- State-changing commands (`/persona`, `/api`, `/models`, `/access`) update state and the patch,
  but the running web server read its patch and environment at boot. They print the new state;
  the web reply adds: `restart the web UI to apply (./turn_on.sh off, then web)`. The plugin adds
  that line itself for these four names.
- ~0.2 s node start per command.
- A command that would prompt reads EOF on stdin and ends; none of the web-enabled ones prompt today.

## Verification
- `scripts/test/commands.list.mjs`: `--list-commands` is valid JSON, every command appears once,
  aliases are folded, the table above is `web: false`.
- `scripts/test/commands.bridge.mjs`: the plugin's registration and handler against a fake
  `ctx.commands` (clash is skipped and logged; success/error mapping; ANSI stripped; abort kills the
  child). No tokens, no dsh.
- Spike first (before the rest is built): mount a one-command version in the web profile and confirm
  (a) the command appears in the `/` list, (b) registering on `ready` leaves `/model` with the
  substrate, (c) the headless profile does not apply the plugin. If `ready` fires before substrate commands register, fall back to a fixed reserved-name
  list read from the installed substrate at build time, and say so in the ADR.
- End to end: `./turn_on.sh web --no-open`, run `/cost`, `/usage`, `/persona` in the browser; compare
  with the REPL output. Clean-clone check (`05-CONVENTIONS.md`) before merging into `epic`.

## Documentation
- ADR-0011 "Web commands bridge through the launcher".
- `docs/06-SETUP-AND-LAUNCHER.md`: web section lists which commands work there and the restart rule.
- Backlog tasks + progress entry per the conventions.
