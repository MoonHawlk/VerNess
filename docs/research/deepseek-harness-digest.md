# DeepSeek Harness (dsh) — Extension Digest

Source: `.refs/deepseek-harness` (read-only research). Goal: extend from outside core (Cordis
plugins, no agent-loop edits). Every package under `packages/` is itself a Cordis plugin; there is
"no privileged core to patch" (`docs/architecture.md:13`).

## 1. Cordis plugin anatomy

- Framework: vendored Cordis at `vendor/cordis`. Primer: `docs/cordis-primer.md`. Hands-on
  tutorial: `docs/cordis-tutorial/01-first-plugin.md` .. `07-into-the-harness.md`.
- A plugin is a function `(ctx) => void`, an object `{ name, apply(ctx) {} }`, or a `Service`
  subclass. Optional named exports: `name` (diagnostics label), `inject` (string[] of required
  `ctx.*` service keys), `Config` (schemastery schema for the entry's `config:`).
- Minimal function plugin (`docs/cordis-tutorial/01-first-plugin.md:11-19`):
  ```ts
  import type { Context } from '@deepseek-ai/cordis'
  export const name = 'hello'
  export function apply(ctx: Context) { /* ... */ }
  ```
- Registration in composition: a `cordis.yml` (or a `cordis.patch.yml` overlay) list entry:
  `{ name: './hello.ts' | '@scope/pkg', id?, config?, disabled? }`. `id` gives stable identity so
  HMR/patches can target the row (`docs/cordis-tutorial/06-composition-and-hmr.md:9-19`).
- Adding a new typed service to `ctx` — declaration merging + `Service` subclass
  (`docs/cordis-tutorial/03-services.md:11-35`):
  ```ts
  declare module '@deepseek-ai/cordis' {
    interface Context { greeter: GreeterService }
  }
  export class GreeterService extends Service {
    constructor(ctx: Context) { super(ctx, 'greeter') }
    greet(who: string) { return `Hello, ${who}!` }
  }
  export function apply(ctx: Context) { ctx.plugin(GreeterService) }
  ```
  Runtime registration (`super(ctx, 'greeter')`) and the `declare module` merge are independent:
  runtime works without the merge, but callers lose type safety on `ctx.greeter`.
- Consuming a service: `export const inject = ['greeter']` — plugin stays `PENDING` until every
  injected service exists; if the service later disappears (unload/HMR), the dependent plugin is
  unloaded too and reloads when the service returns (`docs/cordis-tutorial/03-services.md:44-78`).
  Optional/soft dependency: `ctx.get('greeter')` (returns `undefined` if absent), no `inject`.
- Lifecycle/dispose: fiber states `PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED` (or
  `FAILED`) (`docs/cordis-tutorial/02-lifecycle-and-effects.md:68-82`). Every registration should
  be reversible: `ctx.on(event, fn)`, `ctx.plugin(child)`, and harness registry `.register(...)`
  calls are effects already disposed on unload; for unmanaged resources wrap manually:
  ```ts
  ctx.effect(() => {
    const timer = setInterval(fn, 200)
    return () => clearInterval(timer)
  })
  ```
  Disposers run in reverse registration order; concurrent async disposers are NOT sequenced unless
  kept in one disposer.

## 2. Extension seams/events (Cordis dispatch modes: emit/waterfall/parallel/serial/bail —
   `docs/cordis-primer.md:19-26`)

Full generated matrix: `docs/event-producer-consumer.md`. Turn/seam flow diagram:
`docs/architecture.md:84-117`, `docs/tool-execution-pipeline.md`.

| Concern | Event | Mode | Declared in |
|---|---|---|---|
| System prompt assembly | `system-prompt/assemble` | waterfall | `packages/core/system-prompt/src/index.ts:31` |
| System prompt changed (observe) | `system-prompt/change` | emit | `packages/core/system-prompt/src/index.ts:37` |
| Tool pre-execute (policy: allow/deny/ask) | `tools/pre-execute` | waterfall | `packages/core/tools/src/index.ts:153` |
| Tool execute (around-dispatch: timeout/retry/metrics) | `tools/execute` | waterfall | `packages/core/tools/src/index.ts:164` |
| Tool post-execute (accept/block/replace/add context) | `tools/post-execute` | waterfall | `packages/core/tools/src/index.ts:176` |
| Tool result (final, immutable, observe-only) | `tools/result` | emit | `packages/core/tools/src/index.ts:198` |
| PTC sub-call dispatch log | `tools/ptc-dispatch-log` | waterfall | `packages/core/tools/src/index.ts:190` |
| Agent pre-step (accept/reject/rewrite input) | `agent/pre-step` | waterfall | `packages/core/agent/src/runtime-types.ts:320` |
| Agent request (route/capability negotiation before prompt commit) | `agent/request` | waterfall | `packages/core/agent/src/runtime-types.ts:337` |
| Agent request error | `agent/request-error` | waterfall | `packages/core/agent/src/runtime-types.ts:353` |
| Turn stopping (serial, no `next()`) | `agent/turn-stopping` | serial | `packages/core/agent/src/runtime-types.ts:381` |
| Agent created (async init before work starts) | `agent/created` | serial | `packages/core/agent/src/runtime-types.ts:261` |
| LLM streaming (wrap adapter stream) | `llm/stream` | waterfall | `packages/llm/llm/src/index.ts:75` |
| Approval prompt | `approval/request` | waterfall | `packages/interaction/user-approval/src/types.ts:87` |
| Human question/answer | `user-questions/request` | waterfall | `packages/interaction/user-questions/src/types.ts:88` |
| Filesystem write/edit intent (guard) | `fs/write-intent`, `fs/edit-intent` | waterfall | `packages/fs/fs/src/index.ts:59,67` |
| Filesystem observed (post-mutation) | `fs/observed` | emit | `packages/fs/fs/src/index.ts:77` |
| Durable session log | `session/event` | emit | `packages/core/session/src/index.ts:77` |

Waterfall listeners MUST call `next()` to delegate (around-middleware); returning without `next()`
short-circuits — used for single-decision policy (deny/ask) (`docs/cordis-primer.md:29-36`).
`agent/turn-stopping` is `serial` and has **no** `next()` — every listener runs, in order.

Tool pipeline order (`docs/tool-execution-pipeline.md`): `tool/call` logged → `tools/pre-execute`
waterfall (hooks/permission/sandbox) → registered monotonic guards (`ctx.tools.guard()`, cannot be
undone by later listeners) → `ctx.approval` one-shot prompt if `ask` → `tools/execute` waterfall
(wraps dispatch) → tool body `execute()` → `ToolDefinition.projectContent` → `tools/post-execute`
waterfall → `finalizeContent` → `tools/result` (frozen, synchronous) → `tool/result` session event.

## 3. Registering new capabilities

- **Tool** — `docs/cookbook/adding-a-tool.md`; reference impl `packages/shell/tool-bash`.
  ```ts
  export const inject = ['tools']
  export function apply(ctx: Context) {
    ctx.tools.register(defineTool({
      name: 'read_file', description: '...', parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args, exec) { /* args typed from schema; exec.signal cancellable */ },
    }))
  }
  ```
  Policy (`tools/pre-execute`), around-dispatch (`tools/execute`), and result rewriting
  (`tools/post-execute`) are added by SEPARATE plugins, not by editing the tool.

- **LLM provider/model** — `docs/cookbook/adding-an-llm-adapter.md`; refs `packages/llm/llm-deepseek`
  (raw HTTP/SSE) and `packages/llm/llm-pi-ai` (wraps a library).
  ```ts
  class MyAdapter extends LlmAdapter { async *stream(options) { /* yields StreamChunk */ } }
  export const inject = ['llm']
  export const Config = z.object({ apiKey: z.string() })
  export function apply(ctx: Context, config: Config) {
    ctx.llm.registerAdapter(['my-provider'], new MyAdapter(config))
  }
  ```
  Protocol contract (must-follow): emit `usage` before `finish`, nothing after; tool-call
  `arguments` are raw JSON strings streamed as `argumentsDelta`; block `index` allocated in
  first-seen order; throw `LlmError` for transport failures or end stream with
  `finish {kind:'error'|'aborted'}`; honor `options.signal`; unsupported option → throw
  `LlmError(..., 'UNSUPPORTED_OPTION')`. One adapter per provider route; duplicate registration
  throws.

- **Subagent provider** — `SubagentProvider` registered via `ctx.subagents.registerProvider(...)`
  (`packages/subagent/subagent/src/index.ts:512`), interface at
  `packages/subagent/subagent/src/types.ts:344`. Examples: `packages/subagent/subagent-acp`,
  `subagent-codex`, `subagent-claude-code`, `subagent-fork-in-process`,
  `subagent-spawn-in-process`, `subagent-dsh-sdk`. Service key: `ctx.subagents`.

- **Skill** — `ctx.skills.registerProvider(create)` where `create(control) => SkillProvider`
  (`packages/skill/skill/src/index.ts:390`); `SkillProvider.list(options)` returns
  `SkillCandidate[]` (`packages/skill/skill/src/index.ts:247-259`). Examples:
  `packages/skill/skill-filesystem`, `skill-office`, `skill-badge`. Consumed by
  `packages/skill/tool-skill`. Service key: `ctx.skills`.

- **Goal / evaluator** — `packages/goal/goal` owns `ctx.goals`: one durable completion objective
  per session, persisted through `ctx.sessionProjections.register(goalProjectionDefinition)`
  (`packages/goal/goal/src/index.ts:258`). It is a state/domain service, not a pluggable
  evaluator interface — continuation policy lives in the separate `goal-round-driver` package
  which listens to `agent/pre-step`/`goal/changed`. To add "an evaluator", build a plugin that
  injects `['goals']` and listens to `goal/changed`/`session/event`.

- **Job / cron** — background async work: `ctx.jobs.start({ kind, label, owner: exec.agent, run })`
  (see `docs/cookbook/adding-a-tool.md:51-55`, interface `packages/jobs/jobs/src/index.ts:49`,
  `types.ts`). Scheduled/cron reminders are a separate domain, `ctx.schedule`
  (`packages/schedule/schedule`), with tools `schedule_create/list/delete/update` supporting
  `at`, `every`, `daily`, `weekly`, and five-field Vixie `cron` rules
  (`packages/schedule/schedule/README.md:37,45`). Register a job producer by depending on
  `ctx.jobs` and calling `.start()`; register a new delivery/trigger kind by extending `ctx.schedule`.

## 4. Presets / bundles / profiles

- **Profile** = a named Cordis composition stored in `$DSH_HOME/profiles/<name>`: lists bundles it
  stacks + its own `cordis.patch.yml` (+ optional `compatibility.json` for version exemptions).
  Shipped templates: `web`, `headless`, `sdk`, `sdk-minimal`, `acp`
  (`docs/architecture.md:19`, `packages/boot/app-boot/README.md:48-50`).
- **Bundle** = a distribution unit declared in a package's own `package.json` under `dsh.bundle`:
  ```json
  { "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
  ```
  (`packages/bundle/base/package.json`) or an ordered list of patch files
  (`packages/bundle/web-app/package.json`: `["./cordis.patch.yml", "./presets/standard.patch.yml", ...]`).
- **Composition order**: bundles in the profile's listed order → profile's own
  `cordis.patch.yml` → home-level `cordis.patch.yml` → any `--patch` CLI overlay
  (`docs/architecture.md:27`). A patch entry replaces a targeted row's whole `config` by `id`, or
  `insert:`s new rows (see `packages/bundle/base/cordis.patch.yml`,
  `packages/bundle/headless/cordis.patch.yml`).
- **Layer bundle package**: `dsh-base` is shared first layer for web/headless/sdk/acp; each app
  bundle (`packages/bundle/web-app`, `headless`, `sdk-app`, `acp-app`) adds its surface;
  `sdk-minimal` is a standalone exception owning its full tree.
- Preview the composed tree: `dsh --profile web --dump-config`. Every printed row is patchable.
- **Loading an out-of-tree npm package as a plugin — yes**: "Inserted plugin names may be
  absolute filesystem paths, file URLs, or package specifiers"
  (`packages/boot/app-boot/README.md:65`). Concretely:
  1. Add a `cordis.patch.yml` `insert:` row naming the npm package as `name` (module specifier),
     in the profile's or home-level patch file.
  2. Or use `dsh plugin` CLI / the `plugin_manager` tool (`ctx.pluginManager`,
     `packages/boot/plugin-manager`) to `installBundle`/`inspect` a registry package, git repo, or
     tarball — it runs `pnpm add` inside the profile directory, updates the profile's
     `package.json`/`pnpm-lock.yaml`, and toggles `dsh.profile.bundles`.
  3. Compatibility gate: the plugin's `peerDependencies` on `@deepseek-ai/dsh` /
     `@deepseek-ai/dsh-*` are checked against the current runtime version before mount; a
     mismatch is refused unless an exact-version exemption is granted in `compatibility.json`
     (`packages/boot/app-boot/README.md:52,56` and version-compatibility section of
     `packages/boot/plugin-manager/README.md`).
  4. Optional display metadata for an npm plugin: `locale/en.json` with `meta.title` /
     `meta.description`, exported via `package.json.exports`
     (`docs/cookbook/adding-a-package.md:112-161`, "plugin display metadata").
- **Agent presets** (`packages/preset/agent-preset-registry`, `ctx.agentPresets`) compose a
  per-session capability set (different tool/service rows, `isolate` realm) — see
  `docs/architecture.md:145`: "Give one session a different capability set → compose an agent
  preset; a service row there needs an `isolate` realm."

## 5. Repo mechanics

- Package manager: **pnpm 11.7.0**, pinned via Corepack (`"packageManager": "pnpm@11.7.0"` in root
  `package.json`). Node: `^22.19.0 || >=24.0.0` (`package.json` `engines`); CI matrix covers 22.19,
  24, 26.
- New package path pattern: `packages/<group>/<pkg>/` — exactly one level below a group
  (`core`, `llm`, `shell`, `compaction`, `subagent`, `todo`, `session`, `client`/`host`, `util`,
  `test-support`, or a new group) — `docs/cookbook/adding-a-package.md:9-25`.
  Package name convention: `@deepseek-ai/dsh-<name>`.
  Required `package.json` invariants (enforced by `pnpm run constraints`): `private: true`,
  `version` matching root, `type: module`, `main: "lib/index.js"`,
  `types: "lib/types/index.d.ts"`, `exports["."]` types+default set accordingly,
  `@deepseek-ai/cordis` in BOTH `peerDependencies` and `devDependencies` (matching range),
  `files` limited to `lib/index.js`, `lib/types/**/*.d.ts`, plus recognized runtime artifacts.
  Source uses explicit `.ts` import specifiers (`from './types.ts'`).
- tsconfig registration (manual step — not auto-discovered):
  add `{ "path": "./packages/<group>/<pkg>" }` to `tsconfig.host.json` (Host packages) OR
  `tsconfig.client.json` (Client packages) — never both unless it is one of the 6 explicitly split
  packages (`docs/development.md:54-70`, `docs/cookbook/adding-a-package.md:31-38`). For a new
  *group*, also add its wildcard to `tsconfig.base.json`'s `@deepseek-ai/dsh-*` paths candidate.
  Root `package.json` workspaces, `tsdown.config.ts`, `.oxlintrc.json`, and
  `scripts/check-workspace-constraints.ts` pick new packages up automatically via globs — no edit
  needed there.
- Build order: `tsc -b tsconfig.host.json` → `tsdown --env.DSH_BUILD_FACE host` → desktop bundle →
  `tsc -b tsconfig.client.json` → `tsdown --env.DSH_BUILD_FACE client` → `pnpm run build:web`
  (`docs/development.md:74-81`).
- Run tests for a single package: vitest resolves workspace imports to `src` via
  `tsconfig.base.json`/`vite-tsconfig-paths` — run `pnpm vitest run packages/<group>/<pkg>` (or
  `pnpm run test -- packages/<group>/<pkg>`) from repo root; full policy in `docs/testing.md`.
  Coverage gate requires per-file 100% on `packages/*/*/src` (`pnpm run test:coverage`).
- Verification sequence for a new package (`docs/cookbook/adding-a-package.md:163-172`):
  ```sh
  pnpm install
  pnpm run doc-sync
  pnpm run constraints && pnpm run typecheck && pnpm run lint
  pnpm run build && pnpm run hygiene
  ```
- Lint/format/hooks: **lefthook**, config `lefthook.yml`, installed via
  `node scripts/install-lefthook.mjs` (runs on `postinstall`).
  - `pre-commit`: translation-pairing check on staged `*.i18n.yaml`, Oxlint on staged
    `*.{ts,tsx,mts,cts,mjs}` with `.oxlintrc.staged.json` (auto-fix + one retry), regenerates
    `THIRD_PARTY_NOTICES.md` when dependency-affecting files are staged, whitespace check,
    vendor-manifest guard.
  - `pre-merge-commit`: same translation-pairing check.
  - `pre-push`: `pnpm run typecheck` (full Host lib phase + Client tsc).
  - Hooks deliberately do NOT run tests/snapshots/build/hygiene — CI owns that;
    `pnpm run check:all` opts into the full local gate set.

## 6. Constraints / gotchas / license

- **No privileged core** — every subsystem (model adapter, tool registry, session log, agent loop
  itself) is a plugin behind a named `ctx.*` service key; a third-party extension mounts beside
  them via config, never by editing `packages/core/*` (`docs/architecture.md:11-13`).
- **Windows**: development is supported natively or via WSL2, but "Keep the checkout, installed
  dependencies, and toolchain in the same operating system environment" — don't mix a WSL
  checkout with Windows-installed deps, and vice versa; native binaries differ per OS
  (`docs/development.md:16-22`). Per-file 100% coverage on `packages/shell/pwsh-local/src`
  requires a real `pwsh` binary; without it those suites self-skip (`docs/testing.md:10`).
- **Session log is the invariant boundary**: "Model-visible means logged" — a runtime invariant
  checks every model request is reconstructable from the session log; adding new model-visible
  state requires a new `SessionEvent`, not ad-hoc mutable state (`docs/architecture.md:125`).
  Changing existing message content requires "pure message projections"
  (`docs/subsystems/session.md#plugin-owned-message-projections`) — a naive plugin that mutates
  history directly will violate this invariant and is checked by `packages/*/invariants.ts`
  gates (see `ctx.invariants.register(...)` pattern used throughout, e.g.
  `packages/goal/goal/src/invariant.ts:80`, `packages/jobs/jobs/src/invariant.ts:116`).
  Every registry is expected to ship an HMR-safety test (dispose the contributing fiber, assert
  cleanup) (`docs/testing.md:9`).
  Product-visible plugins need a non-unit REAL-composition test booted through Loader/app —
  hand-built `ctx.plugin(...)` unit suites alone are insufficient (`docs/testing.md:38-40`).
- **Peer-version gate on external plugins**: an installed npm plugin's
  `peerDependencies["@deepseek-ai/dsh*"]` must satisfy the exact running runtime version or it is
  silently skipped (`skippedBundles`) unless an exact-version exemption is granted via
  `compatibility.json` + explicit `acceptRisk: true` (`packages/boot/app-boot/README.md:52,56`,
  `packages/boot/plugin-manager/README.md` "Version compatibility and exemptions").
- **Two separate TypeScript program aggregates** (Host vs Client) exist because both
  declaration-merge the Cordis `Context` interface under the same keys with DIFFERENT services;
  a single `ts.Program` seeing both collides. A new package belongs to exactly one aggregate
  (`docs/development.md:64-70`).
- **License**: root `LICENSE` is **MIT** (`Copyright (c) 2026 DeepSeek`). `THIRD_PARTY_NOTICES.md`
  is auto-generated (`scripts/gen-third-party-notices.ts`) and lists direct deps plus vendored
  Cordis-family packages (all MIT, source-vendored under `vendor/`, republished under
  `@deepseek-ai` scope with preserved upstream `LICENSE` files — see `vendor/README.md`). A fork/
  redistribution should keep `LICENSE`, keep `THIRD_PARTY_NOTICES.md` regenerated/in sync (it is
  a pre-commit-hook-maintained file, gated by `scripts/gen-third-party-notices.spec.ts` in CI),
  and preserve each vendored package's own upstream license file under `vendor/*/LICENSE`.
