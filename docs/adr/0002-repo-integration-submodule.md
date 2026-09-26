# ADR-0002 — Integration shape: pinned submodule + our own package layer

- Status: accepted
- Date: 2026-09-25
- Decided by: repository owner

## Context
Three ways to relate to `dsh`: (a) pinned git submodule + our packages outside it, (b) full
in-tree fork/vendor of the upstream monorepo, (c) standalone package depending only on published
npm artifacts.

## Decision
(a). `upstream/deepseek-harness` is a git submodule, pinned, never edited. Our plugins live in
`packages/*` under the `@verness/*` scope and resolve `@deepseek-ai/*` from npm (they are
published, verified 2026-09-25: `@deepseek-ai/dsh@0.1.5-rc.3`, `@deepseek-ai/cordis@4.0.4`).
Composition happens through a profile patch (`profiles/verness/cordis.patch.yml`) that `insert:`s
our package specifiers — the documented mechanism for out-of-tree plugins
(`.refs/deepseek-harness/packages/boot/app-boot/README.md:65`).

## Why
- Our git history stays 100% ours; `git diff` never shows upstream noise.
- Upstream updates are a submodule bump, not a merge.
- The submodule still gives offline source truth for reading seams and for real-composition tests.
- (b) pollutes history with ~14k files and turns every upstream release into a merge; (c) loses the
  source-of-truth checkout we need for reading and for composition tests.

## Consequences / risks
- **Peer-version gate**: an out-of-tree plugin whose `peerDependencies["@deepseek-ai/dsh*"]` does
  not satisfy the running runtime is skipped silently unless exempted via `compatibility.json`.
  The submodule pin and our peer ranges must move together (T-006, T-015).
- Two package managers in play (npm available locally; pnpm 11.7.0 needed for upstream tooling).
- Fallback if M1's spike fails: an in-tree package inside a fork — would require a new ADR-0004.
