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
- **`N entry did not activate`** — read the error after it. Authoring mistakes in tool schemas are
  reported by the schema compiler, e.g. `parameters.x.required must be true when present`
  (optional parameters must simply omit `required`).
- **Plugin silently absent from `--dump-config`** — the patch file was not synced (step 3).
- **Plugin present but skipped at boot** — peer-version gate: `peerDependencies["@deepseek-ai/*"]`
  must satisfy the running runtime. Our packages pin `0.1.7-rc.2` exactly, which passes with no
  `compatibility.json` exemption (verified 2026-09-25).
- **`MISSING_CREDENTIAL: llm-deepseek`** — expected until `DEEPSEEK_API_KEY` is set; everything
  before the model request has already succeeded by then.

## Never
- Edit anything under `upstream/` (ADR-0002).
- Mix a WSL checkout with Windows-installed dependencies (upstream `docs/development.md:16-22`).
