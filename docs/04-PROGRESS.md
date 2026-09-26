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
