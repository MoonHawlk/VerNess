# 10 — The thought graph: ephemeral and persistent working memory

> Task block **T-280..T-297**. Status: **designed, not implemented.** Grounded in two research
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
