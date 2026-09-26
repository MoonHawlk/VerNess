# RUNBOOK — running VerNess locally (Windows)

> Status: **skeleton, not yet verified end to end.** Milestone M1 (tasks T-010..T-016) verifies
> every step here and replaces the `VERIFY` markers with real, tested output.

Target substrate version: `@deepseek-ai/dsh@0.1.7-rc.2` (identical to the submodule pin).

## 0. Prerequisites
```powershell
node -v          # must be ^22.19 or >=24
corepack enable  # pnpm 11.7.0 is pinned via packageManager  (VERIFY: pnpm not yet installed here)
git submodule update --init --depth 1   # populates upstream/deepseek-harness (read-only)
```

## 1. Install the substrate
```powershell
npm i -g @deepseek-ai/dsh@0.1.7-rc.2    # VERIFY: exact version, do not use the `latest` dist-tag
dsh --version
```
`DSH_HOME` defaults to the per-user harness home; profiles live in `$DSH_HOME/profiles/<name>`.
Record the resolved path here during T-010.

## 2. Inspect the composed plugin tree (the patchable row inventory)
```powershell
dsh --profile web --dump-config > docs/research/dump-config.baseline.txt
```
Every printed row can be targeted by a patch (replace its `config` by `id`, or `insert:` new rows).

## 3. Create the VerNess profile
```powershell
# profile dir: $DSH_HOME/profiles/verness  (mirrored in this repo at profiles/verness/)
# cordis.patch.yml inserts our out-of-tree plugin by package specifier
```
See `profiles/verness/cordis.patch.yml` (created in T-013).

## 4. Run
```powershell
dsh --profile verness --dump-config     # our plugin row must appear
dsh --profile verness                   # then call the `verness.ping` tool (T-014)
```

## 5. If a plugin is silently skipped
It is almost always the peer-version gate: the plugin's `peerDependencies["@deepseek-ai/dsh*"]`
must satisfy the running runtime version, otherwise it lands in `skippedBundles`. Fix the range
first; only as a last resort grant an exact-version exemption in the profile's
`compatibility.json` with `acceptRisk: true` (T-015).

## Never
- Edit anything under `upstream/` (ADR-0002).
- Install upstream dependencies from a different OS environment than the checkout (WSL vs Windows
  mixing breaks native binaries — upstream `docs/development.md:16-22`).
