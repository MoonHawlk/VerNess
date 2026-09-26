# 06 — Setup file and launcher

Two files are all you need day to day:

| File | Role |
|---|---|
| `verness.config.json` | **the setup file** — personas, tips, model, plugins, general settings |
| `turn_on.sh` / `turn_on.ps1` / `turn_on.cmd` | **the launcher** — thin wrappers over `scripts/verness.mjs` |

The launcher is plain Node (>=22.19, which the substrate already requires), so the same logic runs on
Windows, macOS and Linux. The only platform-specific code is path resolution and the Windows `.cmd`
shim quirk (Node refuses to spawn a `.cmd` without a shell since 20.12, so the launcher opts into the
shell on Windows and quotes every argument itself).

## Commands

```sh
./turn_on.sh                # boot; a headless profile prompts for tasks in a loop
./turn_on.sh "audit docs/"  # run one task and exit
./turn_on.sh setup          # install/repair everything (idempotent — safe to re-run)
./turn_on.sh doctor         # what is installed, what is missing
./turn_on.sh sync           # regenerate the profile patch from the config
./turn_on.sh graph          # rebuild the Engram knowledge graph (no LLM calls)
./turn_on.sh help
```
Windows: `.\turn_on.ps1 <same commands>` (or `turn_on.cmd` from `cmd.exe`).
npm equivalents exist for habit: `npm start`, `npm run setup|doctor|sync|graph`.

`setup` does, in order: check Node → install pnpm if missing → install the pinned `dsh` → fetch the
read-only submodule → create the profile from its template → install the route adapter → **link**
substrate packages to the runtime's own copy → add our local plugin packages → generate and sync the
patch → start Ollama and pull the model. Every step is a no-op when already satisfied.

## The setup file

`verness.config.json` is JSON with `//` comments and trailing commas allowed. Every field is
optional; anything omitted falls back to `DEFAULTS` in `scripts/verness.mjs`.

| Section | What it controls |
|---|---|
| `substrate` | pinned `dsh` and pnpm versions (keep in lockstep with the submodule tag — ADR-0002) |
| `profile` | profile name and the template it is created from (`headless`, `web`, `acp`, `sdk`) |
| `model` | the local/OpenAI-compatible route: model id, base URL, context window, auto-serve, auto-pull |
| `extraRoutes` | additional named routes (paid providers); keys are route names |
| `activeRoute` | which route the agent uses; empty means the `model` route |
| `personas` | `active` plus `definitions`: identity `prefix`/`suffix`, and forward-declared `tools`/`skills` |
| `tips` | standing guidance appended to the persona; every line costs tokens on every turn |
| `settings.toolsMode` | `native` (default), `ptc`, or `both` |
| `settings.plugins` | plugin rows: `{ id, package, path?, enabled? }` — `path` means a local package |
| `settings.linkedSubstratePackages` | substrate packages our plugins import; linked, never copied |

### What personas do today, honestly
The persona subsystem is M4. Until then a persona is **its identity text**, injected through the
existing `system-prompt` seam — real and useful, but `tools.allow`/`tools.deny` and `skills` are
**recorded and not yet enforced**. When M4 lands, the same config keys start being enforced by a
plugin on `tools/pre-execute`, and nothing in this file needs to change.

## Generated, but committed
`profiles/<name>/cordis.patch.yml` is rendered from the config by `sync` (and automatically by
`start`/`run`). It stays in git so a reviewer can see the exact tree the runtime composes — but edit
the config, never the patch: the next `sync` overwrites it. See ADR-0006.

## Adding your own plugin
1. Create `packages/<name>/` with a `package.json` (`main`, `type: module`) and a plugin entry
   exporting `name` / `inject` / `apply` — copy `packages/spike/`.
2. Add a row to `settings.plugins`: `{ "id": "my-thing", "package": "@verness/my-thing", "path": "packages/my-thing" }`.
3. `./turn_on.sh setup` (needed once, so pnpm records the dependency), then `./turn_on.sh`.
Editing an existing file needs no reinstall — pnpm hardlinks local packages. **Adding or renaming a
file does**, so re-run `setup`.
