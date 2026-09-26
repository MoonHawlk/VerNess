# dsh: MCP client vs. in-repo HTTP plugin — integrating an external decision service

Source: `upstream/deepseek-harness` (read-only). All paths below are relative to that root unless
stated otherwise.

## 1. MCP client support

- Owning package: `packages/mcp/mcp-client` (`@deepseek-ai/dsh-mcp-client`). Plugin name `mcp-client`,
  injects `tools` (`packages/mcp/mcp-client/src/index.ts:31,34`).
- Config lives in **the profile's `cordis.patch.yml`** as one plugin-loader row per MCP server (one
  instance = one server; load N instances for N servers). There is no separate MCP-specific settings
  file — `packages/mcp/mcp-client/README.md:34-53` gives the copy-pasteable shape:

```yaml
- id: mcp-decision-service
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: decision       # [A-Za-z0-9_-]{1,32}, unique per registration scope
    transport: stdio
    command: python
    args: ['-m', 'decision_service.mcp_server']
    env:
      DECISION_SERVICE_MODE: 'mcp'
    cwd: /path/to/decision_service
    toolCallTimeoutMs: 60000    # default
    failOnStartupError: false  # default: harness still boots if this server is down
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 }

# HTTP/SSE alternative (Streamable HTTP), same package:
- id: mcp-decision-service-http
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: decision
    transport: streamable-http
    url: http://localhost:8080/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.DECISION_TOKEN}`'
```

  Schema source: `packages/mcp/mcp-client/src/index.ts:119-142` (`Config = z.union([stdio, streamable-http])`).
  Field table and defaults: `packages/mcp/mcp-client/README.md:55-67`. Generated exhaustive field list:
  `docs/config-catalog.md#deepseek-aidsh-mcp-client`.
- stdio transport spawns via `StdioClientTransport`; env is the subprocess seam's
  `scrubbedParentEnv()` (drops ambient `KEY|PASSWORD|SECRET|TOKEN` and `DSH_*` names) merged with your
  explicit `env` (`packages/mcp/mcp-client/src/transport.ts:21-46`).
- No separate "settings file" — it is purely a profile-patch plugin row; nothing else to configure.

## 2. Tool naming and filtering

- Naming: `mcp__<serverName>__<rawName>`, normalized to `[A-Za-z0-9_-]{1,64}`; a lossy
  normalization/truncation appends a 12-hex SHA-256 suffix so identities never collide
  (`packages/mcp/mcp-client/src/tools.ts:81-87`, contract described in
  `packages/mcp/mcp-client/README.md:73-81`). The raw name is only ever sent on the wire; the public
  name is never parsed back into it (`tools.ts:9-11`).
- Allow/deny filtering: there is **no filter field on the mcp-client config itself**. Filtering is done
  through the generic tool registry API, `ctx.tools.restrict({ allow?, deny?[] })`
  (`packages/core/tools/src/index.ts:701-711,1091-1124`) — it must run on a **scoped** context
  (`agent.ctx`), throws on an empty filter or an unknown/reserved name. The one first-party consumer of
  this pattern in the tree is `tool-subagent`'s own `toolFilter` config, which wraps `tools.restrict()`
  internally — see `snapshots/session/subagent-tool-filter/cordis.yml:9-10`:
  ```yaml
  toolFilter:
    deny: [write, edit, glob, grep, web_search, web_fetch]
  ```
  There is no equivalent `toolFilter` key shipped on `mcp-client` — to allow/deny a subset of an MCP
  server's tools globally you write a ~5-line companion plugin that calls
  `ctx.tools.restrict({ deny: ['mcp__decision__unsafe_tool'] })` inside an agent-scoped effect.
- Description/schema override: **not found**. `createMcpToolDefinition` (`tools.ts:225-247`) builds
  `description`/`parameters` straight from the upstream MCP `tools/list` response; there is no local
  override hook in this package. To change the description/schema the model sees, you'd need to fix it
  server-side or write your own thin wrapper tool that re-registers under a different name (not
  supported as config).

## 3. Lifecycle

- `startConnection` in `packages/mcp/mcp-client/src/connection.ts:127-409` is the supervisor: it owns
  spawn/connect, tool sync, and reconnection. `apply()` in `index.ts:154-203` awaits
  `connection.ready` before the plugin fiber activates, so tools exist before the harness's first turn.
- Failure modes:
  - `failOnStartupError: false` (default): a failed initial connection is logged, tools from that
    server just don't appear, and **the harness still starts** — `index.ts:199-202`,
    confirmed by `README.md:12,71` ("Slow or crashed servers can delay startup or fail calls until
    recovery" / "the harness still starts but no tools from that server appear").
  - `failOnStartupError: true`: rejects plugin activation (`index.ts:200-202`); app-boot's startup
    policy still lets one optional MCP entry fail without aborting the whole harness
    (`packages/mcp/mcp-client/README.md:71`, pointing at `packages/boot/app-boot`).
- Timeouts: no MCP-client-owned connect/discovery timeout — negotiation and `tools/list` inherit the
  MCP SDK's 60s request default (`README.md:210`, "Known Limitations"). `toolCallTimeoutMs` (default
  60000) bounds each `tools/call`/resource request (`connection.ts:37`, `README.md:61`).
- Reconnect: exponential backoff (`initialDelayMs` doubling to `maxDelayMs`), `maxAttempts` per outage,
  budget resets after staying up past `maxDelayMs` (`connection.ts:5-13,211-245`, defaults at
  `RECONNECT_DEFAULTS` `connection.ts:41-46`: enabled, 500ms, 30000ms, 10 attempts). Exhaustion
  unregisters that server's tools and stops; only HMR reload or Host restart brings it back
  (`connection.ts:225-234`, `README.md:93`).
- Who starts/stops the process: the plugin's `apply()`/`dispose()` lifecycle
  (`index.ts:181-203`), driven by Cordis effect scoping — disposal (including HMR hot-swap) closes the
  transport and unregisters tools (`index.ts:6-11`, `connection.ts:388-407`).
- One unreachable MCP server never fails the whole session/harness by itself (given default
  `failOnStartupError: false`); only that server's tools are absent.

## 4. Approvals/permissions

- Yes — MCP tools are ordinary `ToolDefinition`s registered on `ctx.tools`
  (`packages/mcp/mcp-client/src/tools.ts:150` calls `ctx.tools.register(definition)`), so every call
  goes through the exact same pipeline as native tools: `tools/pre-execute` waterfall → monotonic
  guards → (optional) `ctx.approval` one-shot prompt → `tools/execute` → tool body → `projectContent` →
  `tools/post-execute` → `finalizeContent` → `tools/result`
  (`docs/tool-execution-pipeline.md:6-63`, event declarations at
  `packages/core/tools/src/index.ts:153,164,176,190`). There is no MCP-specific bypass of
  `tools/pre-execute`/approval — the bridge does not special-case its own tools in that pipeline.
- `PreToolDecision` shape (`packages/core/tools/src/index.ts:598-611`): `{kind:'allow'}`,
  `{kind:'deny', reason, info?}`, `{kind:'cancel'}`, `{kind:'ask', reason?, displayReason?}` — `ask`
  only proceeds if an approval service returns `allowed-once`, otherwise denies.

## 5. The non-MCP alternative: minimal in-repo HTTP plugin

- Smallest legal shape: a Cordis plugin (`export const name`, `export const inject = ['tools']` at
  minimum) that registers a listener on the seam(s) below inside `ctx.effect(...)`, calling
  `fetch()`/`http` to your Python service's JSON endpoint during the call. No new tool package, no MCP
  transport, no subprocess management needed if the Python service is already running (you own its
  lifecycle yourself, e.g. as a systemd/OS service or your own subprocess plugin).
- Seam that fires per tool call: **`tools/pre-execute`**, declared at
  `packages/core/tools/src/index.ts:153` (waterfall; `next()` delegates to allow). This is exactly the
  seam the in-tree precedent (`auto-review`, see §7) uses to call out to an LLM per call — swap the LLM
  call for an HTTP POST to your decision service and you have the same shape.
  - Legal returns: `PreToolDecision` — `allow` | `deny (reason, optional structured info)` | `cancel` |
    `ask` (defers to human approval) — `index.ts:598-611`.
- Other seams available if you need step/turn-level control instead of per-tool-call:
  - `agent/pre-step` — waterfall, declared `packages/core/agent/src/runtime-types.ts:320`. A listener
    may reject/replace the messages entering the next step by returning a `PreStepDecision`
    (`next()` preserves current messages).
  - `agent/turn-stopping` — serial, declared `packages/core/agent/src/runtime-types.ts:381`. Fires at
    the turn's stop boundary; a listener can object by steering the agent (`agent.steer(...)`), which
    reopens another step instead of closing the turn — it cannot itself return a value that vetoes
    closure, the *data* (fresh steering) decides.
  - `tools/post-execute` — waterfall, declared `index.ts:176`. Legal returns: `PostToolDecision` —
    `accept` (optionally replacing content/value, adding `additionalContexts`) or `block` (feedback
    content that becomes the model-visible error) — `index.ts:617-620`.
- Minimal example (concept, ~15 lines):
```ts
export const name = 'decision-gate'
export const inject = ['tools']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'risky_tool') return next()
    const res = await fetch('http://127.0.0.1:8787/decide', {
      method: 'POST',
      body: JSON.stringify({ name: exec.name, args: exec.arguments }),
      signal: exec.signal,
    })
    const { allow, reason } = await res.json()
    return allow ? next() : { kind: 'deny', reason }
  }), 'decision-gate.pre-execute')
}
```

## 6. Doing work outside the model loop: `ctx.jobs`

- Abstract seam `JobRegistry` (`packages/jobs/jobs/src/index.ts`, documented in full at
  `docs/subsystems/jobs.md:386-494`); `jobs-local` is the process-local provider.
- Start: `ctx.jobs.start(spec: JobSpec): JobId` — `spec.run(job: JobHandle): JobHooks` is called
  synchronously after preflight; `JobHandle` gives `append(text, opts)` and `updateProgress(line)`
  (`docs/subsystems/jobs.md:24-96`, abstract signature at `jobs.md:411`).
- Await: `ctx.jobs.wait(id, timeoutMs, caller?, signal?): Promise<JobView>` — waits for settlement or
  timeout without cancelling (`jobs.md:463-474`). `ctx.jobs.read(id, caller?): JobRead` consumes the
  output ring and hands back `JobOutcome.result` once, after settlement (`jobs.md:429-437,262-274`).
- Report/surface results: `JobHooks.done: Promise<JobOutcome>` resolves with
  `{status: 'completed'|'killed'|'failed', detail?, result?}` (`jobs.md:100-136`); the model-facing
  consumer package is `dsh-tool-jobs` (`packages/jobs/tool-jobs`), which exposes job start/list/read/kill
  as a tool if you want the model itself to manage background decision-service calls; otherwise a
  plugin can call `ctx.jobs.start`/`wait`/`read` directly without any model-facing tool at all.
- This is the right seam if the external HTTP call is long-running and you don't want to block a
  `tools/pre-execute` waterfall listener on it; a fast synchronous-ish decision call (sub-second HTTP
  round trip) is fine directly inside `tools/pre-execute` as in §5.

## 7. Existing classifier/router/policy precedent

- **`packages/experimental/auto-review/src/index.ts`** is exactly this shape already in the tree: an
  LLM-backed reviewer prepended to `tools/pre-execute` (`{ prepend: true }`, `index.ts:686,721`) that
  classifies every pending native/PTC call's risk and returns `allow`/`deny`/`ask`
  (`auto-review/src/index.ts:678-739`, decision materializers at lines 618-675). It:
  - Builds a bounded snapshot of the pending action + session history (`snapshotAutoReview`, lines
    361-523) instead of trusting the model's own framing.
  - Calls out (there: `ctx.llm.stream`, here: your Python HTTP/MCP service) and parses a strict
    protocol response (`parseDecision`, lines 561-588) — fail-closed on any parse ambiguity.
  - Wires into `ctx.permissionPresets`/`ctx.approval` so a "deny" either denies outright or downgrades
    to an `ask` depending on the active approval policy (lines 709-716).
  - This is the pattern to imitate for the decision service: a `tools/pre-execute` listener that
    POSTs the pending call to your Python service and maps its JSON answer to `PreToolDecision`.
- No other allow/deny/routing decision-maker was found outside this one and the structural
  `tools.restrict()`/`ToolGuard` primitives (`packages/core/tools/src/index.ts:701-774,1127-1142`) that
  `auto-review` and `tool-subagent`'s `toolFilter` both build on.

## What I could not find

- No MCP-specific timeout/discovery-timeout config beyond the SDK's inherited 60s default
  (explicitly called out as an open direction in the package's own Dev Note,
  `packages/mcp/mcp-client/README.md:225`).
- No config-level (cordis.patch.yml) allow/deny or description/schema-override field for mcp-client
  itself — both require a companion plugin (`tools.restrict()` for filtering; no supported override
  path for description/schema at all).
- No generic top-level "router/classifier" plugin other than `auto-review`; nothing under
  `docs/cookbook/` names a decision-service/router pattern specifically.

## Recommended integration path

- **MCP path**: lowest code (zero — config-only) if the Python process already speaks MCP well;
  you get tool discovery, JSON-schema validation, structured content, and reconnection for free via
  `dsh-mcp-client`. Cost: an extra protocol hop, no local description/schema override, and MCP's own
  60s-inherited timeouts if your decision service is occasionally slow.
- **HTTP-plugin path (`tools/pre-execute`)**: lowest latency and full control (your own timeout,
  retry, payload shape) for a call that must gate *every other tool call* — this is what a "decision
  service" typically is, not a new tool the model chooses to invoke. MCP tools are model-invoked;
  a policy/decision gate is harness-invoked on every call, which only the `tools/pre-execute` seam
  supports.
- If the service's job is "the model can ask it a question" (a normal tool), prefer **MCP** — you get
  naming, discovery and lifecycle for free and avoid hand-rolling a tool definition.
- If the service's job is "gate/veto/rewrite every tool call the model makes" (a policy/router), prefer
  the **HTTP plugin** on `tools/pre-execute`, following the `auto-review` pattern in §7 almost verbatim
  (swap its LLM call for an HTTP POST) — MCP has no seam for gating other tools' calls.
- A hybrid is legitimate and cheap: register the Python service as an MCP server for its ordinary
  callable tools (§1) *and* write a ~30-line `tools/pre-execute` plugin (§5, §7) that calls its plain
  HTTP endpoint synchronously for policy decisions — the two seams are independent and compose.
