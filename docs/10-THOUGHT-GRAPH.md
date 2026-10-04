# 10 — The thought graph: ephemeral and persistent working memory

> Task block **T-280..T-297**. Status: **built: T-280..T-289 (`packages/thoughts`); T-290, T-295..T-297
> not implemented.** See "As built" at the end. Grounded in two research
> digests: `docs/research/dsh-state-and-memory-seams.md` (what the substrate forces) and
> `docs/research/context-retention-patterns.md` (what Hermes and Anthropic learned the hard way).

## The problem, precisely

Session continuity (shipped) fixed the crude failure: the model no longer meets each question cold,
because every turn now adopts the same durable session. But a *long* task still degrades, for two
reasons the session log alone cannot fix:

1. **Compaction**. History is finite. When it is compacted, the reasoning that produced a conclusion
   is summarised away, and the model is left with prose about what it once knew.
2. **Nothing survives the session.** A conclusion earned expensively on Monday is re-derived on
   Tuesday, at full price.

A thought graph addresses both: each step records a small, structured **node** — what was attempted,
what was concluded, what evidence backs it — with an explicit scope:

- **ephemeral** — lives for this session, resets per turn or per task, cheap and disposable.
- **persistent** — outlives the session, reusable by later sessions, and therefore expensive: it
  must be earned, capped and verifiable.

## What the substrate forces on us (non-negotiable)

From `docs/research/dsh-state-and-memory-seams.md`:

| Constraint | Consequence for the design |
|---|---|
| "Model-visible means logged": model-visible state must be a `SessionEvent` folded by a projection — a plain variable silently breaks on resume | Thought nodes are session events, not a side file. This is law 5 restated by the runtime itself |
| Log-only events (no `surfaceOp`) are **immune to compaction's surface-replace shadowing** | This is the free mechanism we needed: nodes survive compaction *by construction*, simply by never being surface events |
| Per-turn ephemeral state is already solved: fold `turn/start` back to empty, as the todos projection does | Ephemeral scope needs no new machinery, only the right fold |
| `stateVersion` must bump on any shape change, and two registrants cannot share a key at different versions | Version the projection from day one; schema evolution is a breaking change, not a patch |
| New event types thread through a generated catalog | Prefer **one** generic `thought/node` event over a family of bespoke ones |
| Neither `spill` (write-only, temp) nor `workspace` is a legitimate durable home; cross-session durability belongs to `ctx.storage` | Persistent scope lives in `ctx.storage`, deliberately *outside* the session log — no replay, no compaction |
| Subagents inherit **nothing** automatically | Sharing is explicit: seed the nodes you pass, never "inherit the graph" |
| Nothing resembling a thought graph exists upstream today | We are not duplicating a subsystem — but we own the maintenance |

## What the prior art forces on us

From `docs/research/context-retention-patterns.md` (Hermes, Anthropic cwc):

1. **A fixed node schema beats free prose** — both Hermes's compression template and cwc's
   `PROGRESS.md` converge on goal / progress / decisions / next.
2. **Persistent storage is capped, and a full store errors** rather than silently dropping.
3. **Persistent writes happen through an explicit tool call and are verified by re-read** — never
   inferred from the model's claim that it wrote something.
4. **"Done" requires evidence read in-turn**, enforced structurally (cwc's default-FAIL gate).
5. **Persistent nodes inject once, frozen, at session start** — mid-session rewrites invalidate the
   prompt-cache prefix, which is a direct cost increase.
6. **Ephemeral nodes evict by demotion to a stub with a recovery pointer**, not by deletion.
7. **Search over full history is on demand and zero standing cost**, separate from the small
   always-loaded set.
8. **Subagents receive only the nodes explicitly passed.**
9. **Whatever judges a claim runs in a context that never saw the work.**
10. **Durability means storage that outlives the context window** — never trust compaction.

## Design

### Node

```jsonc
{
  "id": "n-7",
  "scope": "ephemeral" | "persistent",
  "kind": "attempt" | "finding" | "decision" | "constraint" | "artifact",
  "claim": "The session identity includes the 'session-' prefix.",   // one sentence, <=200 chars
  "evidence": ["session log dsh-headless README:54", "verified by boot"],
  "confidence": "verified" | "asserted",   // verified == evidence was read in-turn
  "derivedFrom": ["n-3", "n-5"],           // the edges; this is what makes it a graph
  "turn": 4,
  "at": "2026-09-26T04:12:00Z"
}
```

`claim` is capped and single-sentence on purpose: a node that needs a paragraph is a document, and
documents belong in artifacts with the node pointing at them.

### Storage, by scope

- **ephemeral** → a `thought/node` **session event** + a `thoughts` projection. Log-only, so
  compaction cannot shadow it; folded to empty on `task/start` (not `turn/start` — a task spans
  turns). Costs nothing until read back.
- **persistent** → promoted explicitly into `ctx.storage` under a project-scoped key, with a byte
  cap. Promotion is a deliberate act (`/think promote <id>`), never automatic, and it re-reads to
  verify. A full store **errors** and asks for consolidation.

### What reaches the prompt

Never the whole graph. Three tiers, mirroring Hermes's progressive disclosure:

1. **Always** (frozen, injected once at session start, hard-capped ~1–2 KB): persistent nodes marked
   `constraint` plus the current goal — the things it is never acceptable to forget.
2. **On demand**: `think_search` / `think_open` tools let the model pull a node or a subgraph when it
   decides it needs one. Zero standing cost.
3. **Automatic, bounded**: on compaction, inject a rendered digest of the current task's `finding`
   and `decision` nodes — the structured replacement for the prose summary compaction would write.

### Why the decision model belongs here

Two of the graph's hardest questions are classification, not generation: **is this node worth
persisting?** and **does this new finding contradict an existing one?** Both are small typed
questions — exactly the shape Laya answers in one forward pass. They are also gated behind the same
calibration rule as routing (T-223): until measured, a rule decides and the model only shadows.

## Task block

- **T-280** `thought/node` session event + `thoughts` projection (log-only, versioned, folds to empty on task start)
- **T-281** Node schema + validation, with the claim length cap enforced at the boundary
- **T-282** `/think` quick-tool: `add`, `list`, `show <id>`, `link <a> <b>`, `promote <id>`, `forget <id>`
- **T-283** `think_add` / `think_search` / `think_open` tools, so the model itself can record and retrieve
- **T-284** Persistent tier in `ctx.storage` with a byte cap that errors when full
- **T-285** Frozen session-start injection of `constraint` nodes, hard-capped, cache-safe
- **T-286** Compaction hook: render the task's findings and decisions into the compacted context
- **T-287** Evidence rule: `confidence: verified` requires evidence read in-turn, enforced structurally
- **T-288** Eviction by demotion to stub with a recovery pointer, never deletion
- **T-289** Explicit subagent seeding: pass named nodes, never the whole graph
- **T-290** `/dashboard` panel: the graph as a list with its edges, and promoted-node inventory
- **T-295** Decision-model assist (shadowed): "is this worth persisting?" and "does this contradict?"
- **T-296** Contradiction handling: a new finding that conflicts with a persistent node must surface, not overwrite
- **T-297** Poisoning guard: persistent nodes record which session and which model produced them, so a bad run can be traced and revoked

## The failure mode to design against

The prior art is unanimous on the danger: **memory poisoning**. A model that persists its own wrong
conclusion will keep reading it back as fact, and each session makes it more confident. That is why
persistence is explicit, capped, evidence-gated, attributed to its producer, and revocable — and why
a contradiction surfaces rather than silently overwriting. An unbounded, self-written memory is not
a feature; it is a slow corruption with a good user interface.

## As built (T-280..T-289)

`packages/thoughts` (`@finess/thoughts`, plugin row `finess-thoughts`), the contract in
`packages/contracts/src/thought.ts`, and the operator command `scripts/commands/think.mjs`.

- **One deviation, forced by the substrate: no bespoke `thought/node` SessionEvent.** `Session.append`
  cannot set the envelope's `ignorable` marker (upstream `packages/core/session/src/index.ts:722`), and
  the JSONL loader refuses any event type outside the generated `KNOWN_SESSION_EVENT_TYPES` that is not
  marked ignorable (`packages/session/session-persistence/src/storage-contract.ts:75`). A plugin event
  would make every later `--session-id` adoption fail. So each node is a `thought/node` *record*
  carried in the `think_add` call's own `tool/result.meta`, written by the tool's
  `output.presentationMeta`. It is still in the durable log, still folded by a projection, and still
  out of compaction's reach, because the fold reads the log, not the surface. The payload can move to
  a first-class event unchanged once the substrate lets a plugin mark one ignorable.
- **Task boundary**: a direct human prompt (`user/message` with `source.kind === 'user'`) folds the
  graph to empty. In FiNess one REPL line is one dsh run is one human prompt; goal rounds and
  injected context do not reset it. A human follow-up in the web UI does.
- **Projection** `thoughts`, `stateVersion: 2` (2 since T-289: a fork cut folds to empty), state
  `{v, task, turn, nextId, nodes}`, with a wire view (for T-290). Ephemeral ids are `n-<k>`, per
  task; at most 200 nodes per task, then `think_add` errors.
- **Persistent tier**: storage domain `finess_thoughts` (table `projects`, one record per project,
  keyed by its normalised working directory), at `$DSH_HOME/storages/finess_thoughts.json`. 16 KB cap
  per project; a write past it demotes older nodes (T-288, below), and only one that cannot make room
  that way throws `ThoughtStoreFullError` and changes nothing. Ids are `p-<k>`,
  never reused. Each stored node carries `origin {by, session?, from?}` (room for T-297). Writes are
  re-read and verified. The plugin opens the domain per operation, because the json backend holds
  the file in memory while open and would overwrite `/think`'s edits; `/think` writes the same file
  directly and atomically.
- **Tools**: `think_add` (ephemeral only; promotion is the operator's `/think promote`),
  `think_search`, `think_open`. `think_add` refuses nested (programmatic) calls, because
  `presentationMeta` only runs for top-level ones.

### What reaches the prompt (T-285, T-286, T-289)

One mechanism carries all three: a durable user-role context message with the plugin's own
source `{kind: 'finess-thoughts', form, part}`, entered through the `agent/pre-step` waterfall
(upstream `packages/core/agent-loop/src/agent.ts:277`, typed `packages/core/agent/src/runtime-types.ts:320`)
right after the step's claimed messages, as `agent-instructions` does
(`packages/context/agent-instructions/src/index.ts:315-341`). A plugin source kind is legal: the
source map is merge-extensible (`packages/llm/llm/src/message.ts:103-115`) and the session checks a
user message's source only for a non-empty `kind` (`packages/core/session/src/index.ts:354-359`), so
resume is unaffected. Logged, each message is frozen by construction; a second projection,
`thoughtsContext` (`stateVersion: 1`, `src/context.js`), folds them back so nothing enters twice.
A system-prompt section was rejected: its text is re-evaluated on every assembly and its
`AssembleContext` carries only a scope, no session (`packages/core/system-prompt/src/index.ts:42-49, :66`).

- **T-285, frozen constraints** (`src/inject.js`): on a top-level session's first step only (no
  `step/start` in the log yet), the project's persistent `constraint` nodes, oldest first, stubs
  excluded, capped at 12 nodes and 1536 bytes (the "N more" line inside the cap), as part
  `constraints`. Computed once; later store changes reach only later sessions. A session that starts
  with none gets none later. Children get none.
- **T-286, compaction digest** (`src/compact.js`): when a `compaction/summary`
  (`packages/compaction/compaction/src/types.ts:34`) is newer than the last digest, the next step
  enters part `digest`: the session's frozen block verbatim from the log (the compacted range may have
  swallowed it), then this task's `finding` and `decision` nodes, newest first, capped at 24 nodes and
  3 KB. compaction-basic compacts inside the same waterfall (`compaction-basic/src/index.ts:158-176`),
  so the listener checks after `await next()` and sees it in either listener order. A `compaction/prune`
  does not count. An overflow compaction (`compaction-basic/src/index.ts:190-218`) retries without a
  pre-step, so its digest enters with the following step.
- **T-289, explicit subagent seeding** (`src/subagent.js`): the subagent tool's parameters are fixed
  (`packages/subagent/tool-subagent/src/index.ts:389-399`) and `tools/pre-execute`
  (`packages/core/tools/src/index.ts:153`) can allow or deny but not rewrite arguments (`:607`), so the
  parent names nodes in the prompt: `[thoughts: n-2 p-1]` (`think_open`'s description says so). The
  pre-execute listener resolves them against what the parent sees and denies the call, with the known
  ids, when one is unknown or malformed or the set exceeds 12 nodes / 4 KB; once the rest of the
  waterfall allows the call, it stashes the nodes under the prompt text (bounded, consume-once). The
  child's first pre-step finds its prompt among the claimed messages and enters part `seed`, which
  the context projection folds into the child's `seeds`. A child (header `origin: 'subagent'` or
  `delegationDepth > 0`, `packages/core/session/src/types.ts:117,123`) gets no baseline, its
  `think_search` / `think_open` see its own nodes plus its seeds and never the project store, and its
  own ids start above the seeded `n-` ids. A fork's inherited thought records fold away at the tagged
  `session/end-seed` cut (`types.ts:427`); the inherited conversation itself is model-visible
  history, which no plugin can retract. Only in-process children run the plugin: an out-of-process
  provider (Claude Code, Codex, ACP) gets the marker as plain text and no nodes.

### Evidence and eviction (T-287, T-288)

- **T-287, "verified" needs evidence read this turn** (`src/evidence.js`): `think_add` pairs this
  turn's `tool/call`s of `read`, `grep` and `web_fetch` with their non-error `tool/result`s by
  `message.toolCallId` (`packages/core/session/src/types.ts:361,375`), within the current task segment.
  An evidence token names a read when it is the file read (absolute, cwd-relative or a trailing path;
  drive-letter paths case-insensitive; `:42` / `#L3` suffixes dropped), appears in a grep's output, or
  is the fetched URL. Unproven `verified` is recorded as `asserted` with a `note` in the result, and
  the logged record carries the downgrade. A call whose result is not logged yet (a parallel call in
  the same step) did not happen yet. `/think promote` re-checks the node against its own turn's log
  and downgrades it the same way. The operator's own `/think add --verified` is taken at the
  operator's word.
- **T-288, eviction by demotion** (`src/evict.js`): a node write (add, promote) that would pass the
  cap demotes older nodes to stubs until it fits: attempts, artifacts, findings, decisions, then
  constraints, oldest first; never the node being written. A stub keeps id, kind, turn, `at` and
  edges, and is encoded in the existing fields - claim `[demoted] <60-char head>…`, evidence
  `[recover: <session>#<n-id>]`, confidence `asserted` - so the stored shape and `DOMAIN_VERSION` are
  unchanged (a version bump would make storage-domain refuse existing files). Only a node whose
  origin names the session and the ephemeral id it was promoted from is demotable; with nothing
  demotable the write still throws `ThoughtStoreFullError` and changes nothing. `link` does not
  demote. `/think` prints what it demoted, and `/think restore <p-id>` finds the original record in
  that session's log (matching id, `at` and kind, since ephemeral ids repeat across tasks) and puts it
  back under the same id, demoting others if it must.
