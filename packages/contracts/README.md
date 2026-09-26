# @verness/contracts

VerNess's shared vocabulary: TypeScript types and dependency-free validators for the shapes
that flow between packages (config, tool manifests, profile data, and so on).

This package has **no runtime behaviour** of its own: no I/O, no side effects, no logic beyond
pure functions that validate and normalise data. It exists so every other package (and the
launcher) can agree on the same types without importing each other.

Source is plain, erasable-only TypeScript (`erasableSyntaxOnly` in `tsconfig.json`), so it runs
directly under `node --test` and the launcher's `node --experimental-strip-types`-style resolution
with no build step. `tsc` is dev-only, for typechecking (`npm run typecheck`) and later for
producing the published `lib/` output (`npm run build`).

Later tasks in this milestone each add one paragraph here per contract they introduce.

## Contracts

- **Issue / Result** (`src/issue.ts`) — the shared validator outcome shape (`Result<T>`), a
  single validation problem (`Issue`), and small helpers (`formatPath`, `closest`) for rendering
  paths and suggesting corrections in error messages.
- **Capabilities** (`src/capabilities.ts`) — the capability vocabulary (`CAPABILITY_KEYS`,
  `CAPABILITY_LEVELS`) and the shape a model, persona, or task uses to describe or require them
  (`ModelCapabilities` / `CapabilityRequirements`), plus `levelRank`, `capabilityGaps` (what a
  model falls short of), `mergeRequirements` (combine requirements, keeping the stricter value
  per key), and `validateCapabilities`.
- **Persona** (`src/persona.ts`, `src/validate-persona.ts`) — the v2 persona file shape
  (`PersonaFile`, with `PERSONA_FIELDS` listing every allowed top-level field) and the normalised
  `Persona` every consumer reads (identity, prompt, model/decision/tool/memory/evaluation/security
  policies, tips, commands). `validatePersonaFile(v, { expectedId })` checks a parsed
  `personas/<id>.json` — unknown fields with "did you mean", string and string-array types,
  `tools.allow`/`tools.deny` overlap, approval modes, `models.requirements` via
  `validateCapabilities`, command names — collecting every issue, and fills in the defaults
  (`version '1'`, `name` falls back to `id`, `memory.scope 'session'`, empty prompt parts, arrays
  and records). `personaToFile` turns a `Persona` back into a file that re-validates to the same
  value. v1 files (`id`, `name`, `description`, `prompt`, `tools`, `skills`, `evaluators`, `tips`)
  are valid v2 files unchanged.
