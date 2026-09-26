# ADR-0006 — One setup file; the profile patch is generated from it

- Status: accepted
- Date: 2026-09-25

## Context
Running the harness meant remembering a sequence: create the profile, install the adapter, link the
substrate package, hand-edit `cordis.patch.yml`, export a dummy API key, start Ollama, pull a model,
then boot with the right flags. That is fine once and hostile forever — and it differs per platform.

## Decision
`verness.config.json` is the single editable surface. `scripts/verness.mjs` renders
`profiles/<name>/cordis.patch.yml` from it and performs every install/repair step, and
`turn_on.sh` / `turn_on.ps1` / `turn_on.cmd` are three-line wrappers around it.

The generated patch stays committed: reviewers must be able to see the composed tree in a diff
without running anything. Its header says it is generated.

## Why a Node script rather than shell + PowerShell twins
Node >=22.19 is already a hard requirement of the substrate, so it is guaranteed present — while
keeping a `.sh` and a `.ps1` in sync is a standing source of drift. The wrappers only check for Node
and delegate.

## Consequences
- Editing `profiles/*/cordis.patch.yml` by hand is a mistake: the next `sync` overwrites it.
- Two things the launcher must keep doing, both learned the hard way:
  substrate packages are **linked** to the runtime copy (a second copy breaks every tool call —
  module-local `Symbol`), and pnpm's **exit code is not trusted** (`ERR_PNPM_IGNORED_BUILDS` and peer
  warnings make it non-zero after a perfectly good install), so outcomes are verified by reading the
  profile's `package.json`.
- The config carries fields that are recorded but not yet enforced (persona `tools`/`skills`). This is
  deliberate forward-declaration and is marked as such in `docs/06-SETUP-AND-LAUNCHER.md`; it must
  never be described to a user as working policy.
- `scripts/profile-sync.mjs` is superseded and removed.
