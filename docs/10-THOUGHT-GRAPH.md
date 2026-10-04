# 10 — The thought graph: ephemeral and persistent working memory

> Task block **T-280..T-297**. Status: **foundation built (T-280..T-284, `packages/thoughts`); dashboard panel and
> guards built (T-290, T-295..T-297); T-285..T-289 not implemented.** See "As built" at the end. Grounded in two research
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

## As built (T-280..T-284)

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
- **Projection** `thoughts`, `stateVersion: 1`, state `{v, task, turn, nextId, nodes}`, with a wire
  view (for T-290). Ephemeral ids are `n-<k>`, per task; at most 200 nodes per task, then
  `think_add` errors.
- **Persistent tier**: storage domain `finess_thoughts` (table `projects`, one record per project,
  keyed by its normalised working directory), at `$DSH_HOME/storages/finess_thoughts.json`. 16 KB cap
  per project; a write past it throws `ThoughtStoreFullError` and changes nothing. Ids are `p-<k>`,
  never reused. Each stored node carries `origin {by, session?, model?, from?}` (T-297, below). Writes are
  re-read and verified. The plugin opens the domain per operation, because the json backend holds
  the file in memory while open and would overwrite `/think`'s edits; `/think` writes the same file
  directly and atomically.
- **Tools**: `think_add` (ephemeral only; promotion is the operator's `/think promote`),
  `think_search`, `think_open`. `think_add` refuses nested (programmatic) calls, because
  `presentationMeta` only runs for top-level ones.

## As built (T-290, T-295..T-297)

New modules beside the foundation: `packages/thoughts/src/envelope.js` (boundary parsing of `origin`
and `conflicts`, called from `parseProject`), `src/provenance.js`, `src/conflicts.js`, `src/assist.js`;
launcher side `scripts/lib/thought-assist.mjs` and `scripts/lib/thoughts-panel.mjs`. The stored record
gained only optional fields (`origin.model`, `conflicts`, `nextConflict`), so `DOMAIN_VERSION` stays 1
and the node contract (`packages/contracts/src/thought.ts`) is unchanged.

- **T-297 provenance and revocation.** `/think promote` records `origin {by: 'model', session, model,
  from}`: the claim is the model's, not the operator's. The model is the last `request/header`
  (`data.header.config` provider/model) before the `tool/result` carrying the node, else `'unknown'`.
  `/think add` stays `by: 'operator'`, with no model. `/think show` prints the provenance line.
  `/think revoke <token>` matches, in order: an exact `p-<k>` id; else, among model-written nodes only,
  a session prefix (at least 4 characters, `session-` ignored) or a model (`provider/model` or the bare
  name). A token matching both a session and a model is refused. Matching nodes are removed with the
  edges to them, plus every pending conflict they wrote or pointed at; the full removed entries are
  appended to `$DSH_HOME/finess/thoughts-audit.jsonl` (outside `storages/`, which storage-json owns),
  so a revoke is recoverable by hand. `resolve ... replace` is audited the same way.
- **T-296 contradictions.** Rule (structural, no model): a claim is read as `subject predicate [not]
  value` over a closed predicate list (is/are/was, equals, defaults to, must be, runs on, lives in,
  returns, points to, belongs to: single-valued; uses, requires/needs, includes/contains, has:
  multi-valued), with articles, quotes and end punctuation dropped and contractions expanded. Two
  claims contradict when subject and predicate match and either the value is the same with one side
  negated, or both are positive with different values on a single-valued predicate. `--contradicts
  <p-id>` on `add`/`promote` marks one the rule cannot see. A contradicting write is not stored: it is
  held in the project record as `c-<k>` (its reserved `p-` id is never reused; it counts against the
  byte cap) and the command exits 2. `/think conflicts` lists them with both claims and provenance;
  `/think resolve <c-id> keep|replace|both` drops the incoming node, forgets the stored one and stores
  the incoming, or stores both. Only persistent writes are guarded; ephemeral `think_add` nodes never
  overwrite anything.
- **T-295 decision-model assist, shadow only.** One deviation: it runs **post-run in the launcher**,
  not inside `think_add`. The plugin is a copy under the dsh profile and cannot reach the decision
  client or the shadow log, and a call from inside the tool would race the dsh process exit. After
  each REPL task, `shadowThoughts` takes this task's nodes stamped at or after the run's start (at
  most 5) and per node asks, in one call, `persist` (yes/no) and `contradicts` (`none` plus up to 7
  persistent candidates from `searchNodes`, so at most 8 options; omitted when there is no candidate,
  since a choice needs two). Each answer is logged as a shadow record (`source: 'thoughts'`, `node`,
  `session`, `candidates`) beside the rules (`persist: 'no'`; `contradicts`: the structural rule).
  Nothing acts on them; decisions off means no call; failures are silent.
- **T-290 dashboard panel** (static export and `serve`): the current session's task graph (the
  `state.json` session, found in any workspace) as a tree, each node under its first parent, with
  `← derives from` / `→ used by` links and evidence; the persistent inventory per project with byte
  size, provenance and pending contradictions; and the latest `thoughts` shadow answers (model /
  rules). Those records are left out of the routing decisions table and its agreement rate. `serve`
  and `--watch` also watch `$DSH_HOME/storages`, so a `/think` write refreshes the page.
