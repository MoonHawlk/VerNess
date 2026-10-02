# 06 — Setup file and launcher

Two files are all you need day to day:

| File | Role |
|---|---|
| `finess.config.json` | **the setup file** — personas, tips, model, plugins, general settings |
| `finess` (or `turn_on.sh` / `turn_on.ps1` / `turn_on.cmd`) | **the launcher** — the `finess` bin and the thin wrappers all run `scripts/cli.mjs`, which checks Node and then loads `scripts/finess.mjs` |

The launcher is plain Node (`^22.19.0 || >=24`; 23.x is rejected; the substrate already requires 22.19), so the same logic runs on
Windows, macOS and Linux. The only platform-specific code is path resolution and the Windows `.cmd`
shim quirk (Node refuses to spawn a `.cmd` without a shell since 20.12, so the launcher opts into the
shell on Windows and quotes every argument itself).

## Commands

```sh
./turn_on.sh                # boot; a headless profile prompts for tasks in a loop
./turn_on.sh "audit docs/"  # run one task and exit
./turn_on.sh web            # browser UI: a chat window with a message bar (also /web in the REPL)
./turn_on.sh off            # stop the web UI, the decision sidecar and the local model (also /off)
./turn_on.sh setup          # install/repair everything (idempotent — safe to re-run)
./turn_on.sh doctor         # what is installed, what is missing
./turn_on.sh sync           # regenerate the profile patch from the config
./turn_on.sh graph          # rebuild the Engram knowledge graph (no LLM calls)
./turn_on.sh help
node scripts/dashboard.mjs  # task dashboard: prioritise the backlog, inspect sessions (also /dashboard)

./turn_on.sh models add <hf url | org/repo[:quant]> --use   # install a local model and switch to it
./turn_on.sh api use <provider> <model>                     # run the agent on a hosted model (key in .env)
./turn_on.sh api local                                      # back to the local model
./turn_on.sh access workspace                               # how far shell/file tools reach
```
Models and hosted routes are covered in full in [`11-MODELS-AND-API.md`](11-MODELS-AND-API.md).
Windows: `.\turn_on.cmd <same commands>` works everywhere, including from PowerShell.
`.\turn_on.ps1` is equivalent but **PowerShell blocks unsigned scripts by default**:

```
.\turn_on.ps1 : ... não pode ser carregado porque a execução de scripts foi desabilitada neste sistema
File ... cannot be loaded because running scripts is disabled on this system
```
Three ways out, least commitment first: use `.\turn_on.cmd`; use `npm start`; or allow local scripts
for your user only with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (no admin rights needed,
but it is a user-wide policy change — the first two options change nothing).

npm equivalents exist for habit: `npm start`, `npm run setup|doctor|sync|graph|model:up|model:stats|model:down`.

### One `finess` command

`package.json` exposes the launcher as a bin, so after linking it once every example above can be
written `finess <subcommand>` from any directory (`finess`, `finess web`, `finess doctor`, …):

```sh
npm link          # from the repo root (npm ships with Node): puts `finess` on PATH, pointing at this checkout
finess doctor
```
The link points at the checkout you ran it from, so link the clone you actually use (not a scratch
worktree). Remove it with `npm unlink -g finess`. (pnpm 11 dropped `pnpm link -g` — its `link`
now only takes a directory — so `npm link` is the documented way.) The `turn_on.*`
wrappers keep working and stay the zero-install way in: they only check that `node` is on PATH.

`scripts/cli.mjs` checks the Node version *before* loading the launcher, so an old Node gets a
plain `error: FiNess needs Node 22.19.0+ …` instead of a module-link error from the `.ts` contracts.
It also warns on stderr (`!! scripts/lib/x.mjs is imported by the launcher but not tracked by git`)
when a `scripts/lib` module the launcher reaches through its imports is not in git — it would run
here but a clone would not start. One `git ls-files`, overlapped with loading the launcher; silent
without git or outside a repository, and skipped for `--list-commands`.
Node 22.19.0 itself runs the launcher without a type-stripping `ExperimentalWarning` (checked with
`npx -y node@22.19`).

`setup` does, in order: check Node → install pnpm if missing → install the pinned `dsh` → fetch the
read-only submodule → create the profile from its template → install the route adapter → **link**
substrate packages to the runtime's own copy → add our local plugin packages → generate and sync the
patch → start Ollama and pull the model. Every step is a no-op when already satisfied.

## The browser UI (`web`)
`web` (alias `ui`, or `/web` inside the REPL) serves the substrate's own web client: a chat window
with a message bar, sessions in a sidebar, and tool calls rendered inline. Use it when a terminal prompt is
the wrong shape for the work. It boots a **sibling profile**, `<profile.name>-web` (override with
`profile.webName`), created from the upstream `web` template, so the terminal REPL keeps working
unchanged beside it.

- Same model, persona, tips and plugins. `sync` renders the patch for each profile: the rows it
  targets (`agent-default-model`, `system-prompt`, `tools`) are identical in the headless and web
  templates, and only plugin rows limited to one surface (`"surfaces": ["web"]`) differ.
- `setup` creates it, and the first `web` creates it if `setup` has not.
- It boots through the same checks as the REPL (`prepareBoot` → `prepareRoute` in
  `scripts/finess.mjs`): a fresh patch, the route's API key present in `.env`, and for a local
  route the engine up and the model pulled. It also runs in the same sandbox mode
  (`DSH_PERMISSION_MODE`, chosen with `/access`).
- **Persona, route, model and sandbox mode are read once, when the server starts.** After
  `/persona`, `/api`, `/models` or `/access`, restart it: `./turn_on.sh off`, then `./turn_on.sh web`.
- Flags pass through to the web app: `--port <n>`, `--no-open`, `--host <host>`. Any other word
  after `web` is passed through too, never read as a launcher command.
- The server is token-gated. It opens the browser for you; otherwise open the printed URL, since
  it carries the login token. Pick the `FiNess` workspace, then type in the bar. Ctrl+C stops it. Launched as `/web` from
  the REPL, it also ends the REPL, which shares the console.

### Quick-tools in the message bar (ADR-0011)
Type `/` in the bar: the FiNess quick-tools are listed beside the substrate's own commands, and run
without a model call, like in the REPL. The `@finess/commands` plugin (`packages/commands`, web
profile only) reads `node scripts/finess.mjs --list-commands` once at server start and runs each
command as `node scripts/finess.mjs /<name> <args>`; the reply is the same text the REPL prints.

- **Works on the web:** every quick-tool, its aliases, and the active persona's own commands
  (`/cost`, `/usage`, `/persona`, `/agents`, `/decide`, `/dd`, `/testplan`, ...).
- **Terminal only** (`web: false` in the command file): `/new`, `/resume` (they steer the REPL's
  conversation, not the web session), `/web` and `/off` (a second server, or killing the one that
  would answer), `/help` (the web `/` menu is the list), `/btw` (its notes are composed only into the
  terminal REPL's next task).
- **The substrate keeps its names.** `/model`, `/file`, `/compact`, `/export`, `/feedback`, `/goal`,
  `/permission` and `/plan` stay the web UI's own; FiNess's `/model` is a terminal command there. The
  server log says so once: `finess-commands: /model left to the substrate`.
- **Restart rule.** `/persona`, `/api`, `/models` and `/access` change state the server read at boot;
  their reply ends with `restart the web UI to apply (./turn_on.sh off, then web)`. The command list
  also follows the persona active at boot, so a persona's commands appear after that restart.
- Arguments split on whitespace (quotes do not group words), each command costs about 0.2 s of Node
  start, and cancelling in the UI stops the command.

## Stopping everything (`off`)
`off` (alias `stop`; `/off` inside the REPL) turns off, in order:

1. **The web UI.** macOS/Linux: whatever listens on TCP 6173 (`lsof`), plus any process whose
   command line matches `profile <web profile name>` (`pgrep -f`), so a UI started with
   `web --port <n>` is found too. Windows: the owner of the port-6173 listener, via PowerShell
   (port only, so a UI on another port must be stopped with Ctrl+C).
2. **The decision sidecar** (`decisionDown`), if FiNess started it.
3. **The local model** (`modelDown`): weights are unloaded (RAM/VRAM freed), and the engine server
   is stopped only if FiNess started it.

`off --force` also stops servers FiNess did not start, e.g. an Ollama you launched yourself.

Why it exists: `web down` does not stop anything — `web` passes trailing words to the web app and
boots the web UI again — and `down` alone only handles the model.

## The setup file

`finess.config.json` is JSON with `//` comments and trailing commas allowed. Every field is
optional; anything omitted falls back to `DEFAULTS` in `scripts/finess.mjs`.

| Section | What it controls |
|---|---|
| `substrate` | pinned `dsh` and pnpm versions (keep in lockstep with the submodule tag — ADR-0002) |
| `profile` | profile name and the template it is created from (`headless`, `web`, `acp`, `sdk`); `webName` names the browser-UI sibling (default `<name>-web`) |
| `model` | the local/OpenAI-compatible route: model id, base URL, context window, auto-serve, auto-pull |
| `extraRoutes` | additional named routes; with `api` + `baseURL` a hand-declared gateway, without them a catalog provider (key = the adapter's provider id) |
| `activeRoute` | the default route; empty means the `model` route. `/api use` overrides it in state without editing this file |
| `personas` | `active` plus `definitions`: identity `prefix`/`suffix`, and forward-declared `tools`/`skills`. A `personas/<id>.json` file with the same id wins over an inline definition |
| `tips` | standing guidance appended to the persona; every line costs tokens on every turn |
| `settings.toolsMode` | `native` (default), `ptc`, or `both` |
| `settings.plugins` | plugin rows: `{ id, package, path?, enabled?, surfaces?, repoConfig? }` — `path` means a local package; `surfaces` (e.g. `["web"]`) limits the row to profiles of those templates; `repoConfig: true` passes the checkout path as `config.repo`, written only into the profile copies under `$DSH_HOME` |
| `settings.webBundles` | browser-UI bundles, added to the **web** profile only (`dsh plugin add`, then enabled in `dsh.profile.bundles`) so their own patch applies; today `@linxin666/dsh-web-all` |
| `settings.allowBuilds` | `{ package: true \| false }`: whether a dependency's install script may run. pnpm 11 stops an install while any is undecided (`ERR_PNPM_IGNORED_BUILDS`); setup writes these into every profile's `pnpm-workspace.yaml` first, so macOS and Windows install the same way |
| `settings.linkedSubstratePackages` | substrate packages our plugins import; linked, never copied |

### What personas do today, honestly
The persona subsystem is M4. Until then a persona is **its identity text**, injected through the
existing `system-prompt` seam — real and useful, but `tools.allow`/`tools.deny` and `skills` are
**recorded and not yet enforced**. When M4 lands, the same config keys start being enforced by a
plugin on `tools/pre-execute`, and nothing in this file needs to change.

Since M2, persona files (`personas/<id>.json`, JSONC) are **validated at load** against the
`@finess/contracts` shape; a broken file is listed, not a crash. `/persona check` (or
`node scripts/finess.mjs persona check`) prints each issue as `personas/x.json:line:column path: message`.
A persona can also add its own commands (`personas/<id>/commands/<name>.mjs`, e.g. `/hypotheses`);
global commands win on a name clash. Inline `finess.config.json` definitions are not validated.
Step-by-step guide: `docs/12-PERSONAS.md`.

### Developing the launcher and contracts
`pnpm install` once, then `pnpm test` (launcher tests plus `packages/*/test/*.test.ts` via Node type
stripping) and `pnpm typecheck` (`tsc -p packages/contracts`).

## Generated, but committed
`profiles/<name>/cordis.patch.yml` is rendered from the config by `sync` (and automatically by
`start`/`run`). It stays in git so a reviewer can see the exact tree the runtime composes — but edit
the config, never the patch: the next `sync` overwrites it. See ADR-0006.

## Adding your own plugin
1. Create `packages/<name>/` with a `package.json` (`main`, `type: module`) and a plugin entry
   exporting `name` / `inject` / `apply` — copy `packages/spike/`.
2. Add a row to `settings.plugins`: `{ "id": "my-thing", "package": "@finess/my-thing", "path": "packages/my-thing" }`.
3. `./turn_on.sh setup` (needed once, so pnpm records the dependency), then `./turn_on.sh`.
Editing an existing file needs no reinstall — pnpm hardlinks local packages. **Adding or renaming a
file does**, so re-run `setup`.

## Model lifecycle (`up` / `stats` / `down`) — ADR-0007

One script, `scripts/model.mjs`, owns the local model on all three platforms. Weights come from
Hugging Face; the engine that runs them is Ollama (native builds everywhere, OpenAI-compatible
endpoint, and it pulls GGUF straight from a HF repo).

```sh
./turn_on.sh up       # engine installed? server up? weights pulled from HF? warm? -> ready
./turn_on.sh stats    # what is resident, how much memory, tok/s, latency, who owns the server
./turn_on.sh down     # evict the weights, free the memory, stop the engine we started
./turn_on.sh down --force   # also stop a server FiNess did not start
./turn_on.sh off      # web UI + decision sidecar + model in one step (see "Stopping everything")
```
Aliases: `npm run model:up | model:stats | model:down`, or `node scripts/model.mjs up|stats|down`.

Configure it in `finess.config.json` under `model`:

| Field | Meaning |
|---|---|
| `engine` | `ollama` (the only engine today) |
| `source` | `hf.co/<repo>:<quant>` — the Hugging Face GGUF, or an Ollama-registry name |
| `id` | what the engine serves it under; for a HF pull this equals `source` |
| `keepAliveMinutes` | how long weights stay resident after the last request |
| `autoInstallEngine` | let `up` install the engine with winget / brew / install.sh |
| `autoPull`, `autoServe` | fetch missing weights, start a stopped server |

Measured on this machine (Windows 11, Qwen3 0.6B Q8_0 from Hugging Face): warm-up 7.5 s, generation
~60 tok/s, resident 5.2 GiB (the GGUF is 610 MiB — the rest is context allocation, which is exactly
why `down` exists), and `down` reported 5.2 GiB released with 0 models resident.

**Two traps worth knowing**: only quants actually published in the HF repo are valid tags
(`Qwen/Qwen3-0.6B-GGUF` has `Q8_0`, not `Q4_K_M`), and `ollama pull` can print `Error:` while exiting
0 — so `up` verifies through `/api/tags` rather than trusting the exit code.

## Knowledge graph (`graph`) — ADR-0005

Engram (successor of `graphify`) builds a graph of the repo that an assistant can query instead of
re-reading files. Why and when it pays off: [ADR-0005](adr/0005-engram-knowledge-graph.md).

```sh
npm i -g @sentropic/engram@0.19.0   # global CLI `engram`
engram install                      # /engram skill -> ~/.claude/skills/engram/, trigger -> ~/.claude/CLAUDE.md
./turn_on.sh graph                  # = engram update . (also /graph in the REPL)
```
- `engram install` makes `/engram` available to Claude Code (`/graphify` is a deprecated alias);
  start a new Claude Code session to pick it up. `engram install --project` installs into the
  repo's `.claude/` instead.
- `graph` is an AST-only rebuild with no LLM calls: about 4 s on this repo, last run (after M2) 513
  nodes, 1592 edges, 19 communities. Output goes to `.engram/` (gitignored): `graph.json`,
  `GRAPH_REPORT.md`.
- `engram update` also writes optional description batches
  (`.engram/description-instructions/batch-*.json`) that an assistant can fill for richer node
  descriptions. The graph works without them.
- Not done here, optional: `engram claude install` adds a CLAUDE.md section and a PreToolUse hook
  so Claude Code always consults the graph first.
- `doctor` lists engram as optional. npm 11+ install-script warning: see RUNBOOK troubleshooting.
