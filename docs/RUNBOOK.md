# RUNBOOK — running VerNess locally (Windows)

> Status: **verified end to end on 2026-09-25** (Windows 11, Node v24.14.0), except the final LLM
> call, which needs a `DEEPSEEK_API_KEY` the repo owner must supply.

Substrate version: `@deepseek-ai/dsh@0.1.7-rc.2` — identical to the pinned submodule tag.
`DSH_HOME` on this machine: `C:\Users\totov\.dsh` (default: `%USERPROFILE%\.dsh`).

## 0. One-time setup (independent of this repo — updating VerNess never invalidates it)
```powershell
node -v                               # ^22.19 or >=24  (verified: v24.14.0)
npm i -g pnpm@11.7.0                  # corepack enable fails without admin (EPERM on C:\Program Files\nodejs)
npm i -g @deepseek-ai/dsh@0.1.7-rc.2  # pin the exact version; the npm latest tag still points at 0.1.5-rc.3
dsh --version                         # -> 0.1.7-rc.2
git submodule update --init --depth 1  # populates upstream/deepseek-harness (read-only)
```
`dsh plugin` shells out to `pnpm`, so pnpm is required even though we never build the upstream monorepo.

## 1. Create the VerNess profile (one time)
```powershell
dsh --profile verness --from-default-profile headless --dump-config > $null
```
Creates `$DSH_HOME\profiles\verness\` with `cordis.yml`, `cordis.patch.yml`, `package.json`
(bundles: `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-headless`).

## 2. Install the substrate packages our plugins import, then our plugins
```powershell
dsh plugin --profile verness add @deepseek-ai/dsh-tools@0.1.7-rc.2
dsh plugin --profile verness add "file:C:\Users\totov\Desktop\VerNess\VerNess\packages\spike"
```
- The `dsh: warning: ... declares no dsh.bundle` line is expected: these are plain dependencies
  mounted by our patch layer, not bundle layers.
- pnpm installs a local directory dependency as **hardlinked files**, not a symlink: edits to an
  existing file are live, but **adding or renaming a file requires re-running the add command**.

## 3. Sync our patch layer and verify composition
```powershell
npm run profile:sync                      # copies profiles/verness/cordis.patch.yml into DSH_HOME
dsh --profile verness --dump-config | Select-String verness
# -> # == C:\Users\totov\.dsh\profiles\verness\cordis.patch.yml
#    - id: verness-spike
#      name: '@verness/spike'
```

## 4. Verify the plugin actually MOUNTS (config presence is not proof)
`--help` does not mount the tree; booting a task does. Mounting happens before the LLM request, so
this proves the mount even without credentials:
```powershell
dsh --profile verness "x"
type "$env:USERPROFILE\.dsh\profiles\verness\node_modules\@verness\spike\verness-spike.log"
# -> ...Z mounted   /   ...Z disposed
```
A plugin that failed to activate prints `dsh: warning: N entry did not activate` followed by the
error — that line is the primary diagnostic.

## 5. Run for real
```powershell
$env:DEEPSEEK_API_KEY = "<key>"       # or store it via the web profile Models page
dsh --profile verness "call verness_ping and report the result"
```

## Troubleshooting
- **A persona is listed as broken** — run `node scripts/verness.mjs persona check` (or `/persona check`
  in the REPL); it prints `personas/x.json:line:column path: message` for every issue.
- **`N entry did not activate`** — read the error after it. Authoring mistakes in tool schemas are
  reported by the schema compiler, e.g. `parameters.x.required must be true when present`
  (optional parameters must simply omit `required`).
- **Plugin silently absent from `--dump-config`** — the patch file was not synced (step 3).
- **Plugin present but skipped at boot** — peer-version gate: `peerDependencies["@deepseek-ai/*"]`
  must satisfy the running runtime. Our packages pin `0.1.7-rc.2` exactly, which passes with no
  `compatibility.json` exemption (verified 2026-09-25).
- **`MISSING_CREDENTIAL: llm-deepseek`** — expected until `DEEPSEEK_API_KEY` is set; everything
  before the model request has already succeeded by then.
- **`npm i -g @sentropic/engram` warns that install scripts were not run** — npm 11+ skips install
  scripts of global packages by default, so the tree-sitter parsers' scripts did not run. The graph
  built fine without them (macOS, 2026-09-26). Only if a language fails to parse, reinstall with
  the list the warning prints:
  `npm install -g --allow-scripts=@sentropic/engram,tree-sitter-<lang>,... @sentropic/engram@0.19.0`.

## Never
- Edit anything under `upstream/` (ADR-0002).
- Mix a WSL checkout with Windows-installed dependencies (upstream `docs/development.md:16-22`).

---

## Local-model testing (zero API cost) — see ADR-0004

```powershell
ollama --version                      # verified: 0.32.13 (server already running on :11434)
ollama pull qwen3:0.6b                # 522 MB
dsh plugin --profile verness add @deepseek-ai/dsh-llm-pi-ai@0.1.7-rc.2
npm run profile:sync
$env:OLLAMA_API_KEY = "x"             # any non-empty value; Ollama ignores bearer auth
dsh --profile verness "Call verness_ping with note=hello. Then reply with only the tool output text."
# -> VerNess layer verness-spike is mounted: hello
```
The route and the default-model override live in `profiles/verness/cordis.patch.yml`
(`providers.ollama-local` + the `agent-default-model` row). Switch back to a paid route by editing
that one row.

### CRITICAL: never install a dsh runtime package into the profile as a copy
A plugin of ours that imports from a `@deepseek-ai/dsh-*` package must resolve **the exact same
files the running runtime uses**. `dsh plugin add @deepseek-ai/dsh-tools@<v>` installs a second
copy; the loader then resolves the profile's `tools` row to that copy while `dsh-agent-loop` keeps
its own, and because `TOOL_RUNTIME_SCHEDULER` is a module-local `Symbol(...)`
(`packages/core/tools/src/index.ts:480`), the two disagree. Every tool call then dies with:

```
dsh: UNKNOWN: Cannot read properties of undefined (reading 'prepare')
```

Fix — link the runtime's own copy so both resolve to one realpath (ESM identity is per resolved
file URL, and a symlink resolves to its target):

```powershell
cd "$env:USERPROFILE\.dsh\profiles\verness"
pnpm remove @deepseek-ai/dsh-tools
pnpm add "link:$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-tools"
```
Rule of thumb: **substrate packages are linked, never added; only our own packages are added.**

### Other notes
- `pnpm` may abort with `ERR_PNPM_IGNORED_BUILDS` (`@google/genai`, `protobufjs`). The dependency is
  still recorded and installed; run `pnpm approve-builds` in the profile dir only if something
  actually needs those native builds.
- `qwen3:0.6b` leaks its reasoning and echoes the system prompt. That is expected; it is a plumbing
  instrument, not a quality instrument (ADR-0004).

---

## Knowledge graph / cost control (Engram) — see ADR-0005

```powershell
npm i -g @sentropic/engram@0.19.0 # NOT graphifyy / @sentropic/graphify — both are deprecated shims
engram install                   # writes ~/.claude/skills/engram/ + ~/.claude/CLAUDE.md (user-level)
engram scope inspect .           # what would be analyzed (git-committed files; ignores .gitignore)
engram update .                  # = ./turn_on.sh graph: AST only, ZERO LLM calls -> .engram/graph.json
engram summary                   # compact orientation
engram query "what connects the profile patch to the spike plugin?"
```
- `.engram/` is gitignored while the corpus is small (engram itself reports there is nothing to
  compress yet).
- Semantic extraction over docs needs a model; keep it free with
  `engram extract --backend ollama` + `OLLAMA_BASE_URL=http://localhost:11434`.
- `engram update` may ask for assistant-written descriptions/labels under
  `.engram/*-instructions/`. Optional; it costs session tokens.
- A new Claude Code session is needed before `/engram` (deprecated alias `/graphify`) appears.
- Setup, current numbers and the optional `engram claude install` hook:
  [`06-SETUP-AND-LAUNCHER.md`](06-SETUP-AND-LAUNCHER.md#knowledge-graph-graph--adr-0005).
