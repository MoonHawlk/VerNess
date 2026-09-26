# 04 — Progress log (append-only, newest last)

## 2026-09-25 — M0 started
- Reference repos cloned into `.refs/` (gitignored, shallow):
  ```sh
  git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git .refs/deepseek-harness
  git clone --depth 1 https://github.com/NousResearch/hermes-agent.git .refs/hermes-agent
  git clone --depth 1 https://github.com/anthropics/cwc-long-running-agents.git .refs/cwc-long-running-agents
  ```
- Research digests written: `docs/research/deepseek-harness-digest.md`,
  `docs/research/capability-sources-digest.md`. (T-001, T-002)
- Version reality check (relevant to T-006): upstream source tree is `0.1.7-rc.2`; npm
  `@deepseek-ai/dsh` is `0.1.5-rc.3`; `@deepseek-ai/cordis` is `4.0.4` on npm while `dsh` depends
  on `4.0.2`. The `@deepseek-ai/dsh-*` packages ARE published despite `private: true` in-tree, so
  an out-of-tree plugin can resolve them from npm.
- Plan docs 00–05 + ADRs 0001–0003 written. Integration strategy chosen by the repo owner:
  submodule + own package layer (ADR-0002). Docs language: English. (T-003, T-004)
- Toolchain on this machine: Node v24.14.0, npm 11.9.0, git 2.51.1 (Windows), Python 3.12.3.
  **pnpm is not installed** — needed for the upstream toolchain (pnpm 11.7.0 via corepack). Tracked in T-007.
- Submodule added and pinned: `upstream/deepseek-harness` @ `477b4f4` = tag `dsh-v0.1.7-rc.2`
  (`shallow = true` in `.gitmodules`, so a fresh `git submodule update --init` stays cheap). (T-005)
- **T-006 resolved — target version is `0.1.7-rc.2`.** `npm view @deepseek-ai/dsh versions` shows
  `0.1.7-rc.2` IS published (the `latest` dist-tag merely still points at `0.1.5-rc.3`). So the
  submodule pin and our npm dependency ranges can be identical: pin `@deepseek-ai/dsh*` to
  `0.1.7-rc.2` exactly, and install with an explicit version/tag rather than `latest`.
  `@deepseek-ai/cordis`: `4.0.4` — that is the version vendored in the pinned tag
  (`upstream/deepseek-harness/vendor/cordis/package.json`), and it matches npm-latest.
- Workspace scaffold only (no `pnpm install` executed, no dependencies added yet): root
  `package.json` (private, `packageManager: pnpm@11.7.0`) + `pnpm-workspace.yaml`
  (`packages/*`, `profiles/*`; the submodule is intentionally outside the workspace). (T-007)
- `docs/RUNBOOK.md` skeleton written; all unproven steps carry a `VERIFY` marker for M1. (T-008)
- **M0 complete. Next: M1 / T-010** — install `@deepseek-ai/dsh@0.1.7-rc.2`, capture
  `--dump-config` baseline, then the out-of-tree plugin spike. M1 is the go/no-go for ADR-0002.

## 2026-09-25 — M1 done: the out-of-tree plugin strategy works
- Toolchain: `corepack enable` fails on this machine (EPERM writing the Node install dir), so
  **pnpm 11.7.0 was installed with `npm i -g pnpm@11.7.0`**. pnpm is needed only because
  `dsh plugin` shells out to it. `@deepseek-ai/dsh@0.1.7-rc.2` installed globally.
  `DSH_HOME = C:/Users/totov/.dsh`. (T-010)
- Baseline composition captured (376 rows): `docs/research/dump-config.headless.txt`. (T-011)
- Spike: `packages/spike/` (plain ESM, no build step) registers `verness_ping` and appends
  `mounted`/`disposed` lines to `verness-spike.log`. Mounted through
  `profiles/verness/cordis.patch.yml` -> `insert: [{ id: verness-spike, name: '@verness/spike' }]`,
  installed with `dsh plugin --profile verness add "file:<repo>/packages/spike"`. (T-012..T-014)
- Findings worth remembering:
  - `--dump-config` proves *composition*, not *mount*. Only a real boot mounts; a failure prints
    `dsh: warning: N entry did not activate` followed by the error.
  - Tool schemas reject `required: false` — optional parameters omit `required` entirely.
  - pnpm installs a local directory dependency as **hardlinks**, so edits to existing files are
    live but new/renamed files need the `add` command re-run.
  - `@deepseek-ai/dsh-tools` must be installed into the profile for `defineTool` to resolve.
  - Peer-version gate passed with exact pins; no `compatibility.json` exemption. (T-015)
- `docs/RUNBOOK.md` is now a verified recipe. **ADR-0002 is confirmed by execution.** (T-016)
- Only blocker for a live end-to-end run: `DEEPSEEK_API_KEY` (owner-supplied). Everything up to the
  model request already succeeds.
- **Next: M2 / T-020** — `packages/contracts` (types + schemas only).
