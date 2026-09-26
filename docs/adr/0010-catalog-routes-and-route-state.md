# ADR-0010 — Hosted models through the adapter's catalog; the route choice is state

- Status: accepted
- Date: 2026-09-26

## Context
The agent could only run on hand-declared OpenAI-compatible routes, one model each, chosen by
editing `activeRoute` in the commented config. The route adapter already mounted in every profile
(`dsh-llm-pi-ai`) ships catalogs for dozens of hosted providers — endpoint, wire protocol, model list
and the variable each key is read from — and serves a catalog route from nothing but `apiKeyEnv`.

## Decision
1. **Hosted models are catalog routes.** `/api use <provider> <model>` records the provider id and
   its key variable; the generated patch declares only `apiKeyEnv` for it. VerNess names no vendor:
   providers, models and key variables are read from the adapter installed in the profile
   (`providers/data/*.json`, `env-api-keys.js`), which also keeps ADR-0003 intact.
2. **The route choice is state, not config.** Route, model and access mode live in
   `.verness/state.json`, exactly like the persona (ADR-0008). The commented config stays
   operator-owned.
3. **One resolver.** `scripts/lib/routes.mjs#effectiveRoute` is the only place that decides route and
   model; a model choice is bound to the route it was made for.
4. **Keys live in `.env`** (gitignored), loaded by the launcher; the shell environment wins.

## Consequences
- A newer hosted model appears when the substrate pin moves, not before; `extraRoutes` remains the
  escape hatch for anything the catalog lacks.
- Reading `env-api-keys.js` by file path couples us to an internal module of the adapter's
  dependency. It is guarded: on failure the launcher falls back to `<PROVIDER>_API_KEY`, and the
  fail-loud `MISSING_CREDENTIAL` path still names whatever variable was chosen.
- Omitting `apiKeyEnv` (the adapter's ambient discovery) was rejected: it would work, but a missing
  key would surface as an opaque provider error instead of a named variable.
