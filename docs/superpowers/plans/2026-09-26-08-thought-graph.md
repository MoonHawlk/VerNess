# WS-H — Thought graph: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Read
> `2026-09-26-00-master-plan.md` and `docs/10-THOUGHT-GRAPH.md` (the design) first. Requires WS-G
> G0 (build pipeline, seam signatures, boot harness) and M3 (for T-295).

**Goal:** Structured working memory. Ephemeral nodes survive compaction because they are log-only
session events. Persistent nodes are earned, capped, attributed and revocable. The model records
and retrieves nodes with tools, and the operator does the same with `/think`.

**Architecture:** One plugin, `packages/thoughts/`:
- a `thought/node` `SessionEvent` (log-only, no `surfaceOp`) and a `thoughts` projection with a
  `stateVersion`, which folds to empty on `task/start`;
- `ctx.thoughts` service: `add`, `link`, `search`, `open`, `promote`, `forget`, `demote`;
- tools `think_add`, `think_search`, `think_open`;
- the persistent tier in `ctx.storage` under key `verness/thoughts/<project-hash>`, byte-capped;
- a `system-prompt/assemble` contribution that injects **only** persistent `constraint` nodes, frozen
  at session start;
- a compaction contribution that renders the current task's `finding`/`decision` nodes.

The launcher's `/think` command talks to the plugin through a one-shot tool call, or reads the
projection from the session log for read-only subcommands, so no second store exists.

**Tech stack:** TypeScript plugin (WS-G pipeline), `@verness/contracts` (add a `ThoughtNode`
contract and validator), `node:test`, the boot harness.

**Spec:** `docs/10-THOUGHT-GRAPH.md` (node shape, scopes, three prompt tiers, the poisoning guard),
`docs/research/dsh-state-and-memory-seams.md`, `docs/research/context-retention-patterns.md`,
`docs/research/seam-signatures.md` §§6, 14, 15 (from WS-G G0).

## Global Constraints
Inherit the master plan. Also:
- `claim` ≤ 200 characters and a single sentence (no `. ` followed by an uppercase letter inside it).
  Enforced at the boundary; over-long claims are rejected with a message, never truncated silently.
- Persistent store cap: default 16 KiB serialised, configurable. **A full store errors** with
  "consolidate or forget nodes first". It never evicts silently.
- The frozen session-start injection is capped at 1.5 KiB and contains `constraint` nodes only.
  Nothing rewrites it mid-session (prompt-cache prefix).
- Persistent nodes always carry `{sessionId, model, persona, promotedAt}`.
- `confidence: 'verified'` is only accepted when the node cites evidence **read in this turn**
  (a `tool/result` id from the current turn). Otherwise it is stored as `asserted`, with a warning.

## Review Focus
1. Compaction with 200 ephemeral nodes: the rendered digest must stay bounded (≤ 2 KiB, newest and
   highest-degree first) and say how many nodes it omitted.
2. `derivedFrom` pointing at a forgotten or demoted node: links keep working through the stub, and
   `open` shows the recovery pointer.
3. Promotion of a node that contradicts an existing persistent node: it surfaces both nodes and
   requires `promote --replace <old>`. It never overwrites.
4. Two sessions promoting at the same time: storage writes are read-modify-write. Use the storage
   API's compare-and-set if it has one (seam §15); otherwise retry on a version mismatch up to 3 times.
5. Subagents: the evaluator subagent (M7) must receive **no** thought nodes unless they are passed
   explicitly. A boot test asserts this.

## File structure

```
packages/contracts/src/thought.ts          # ThoughtNode, validateThoughtNode()      (T-281)
packages/thoughts/
├── src/index.ts                           # apply(): event, projection, service, tools, listeners
├── src/event.ts                           # thought/node event + projection fold     (T-280)
├── src/service.ts                         # ctx.thoughts                              (T-282 backend)
├── src/store.ts                           # persistent tier on ctx.storage            (T-284, T-288, T-297)
├── src/tools.ts                           # think_add / think_search / think_open     (T-283, T-287)
├── src/inject.ts                          # frozen constraint injection               (T-285)
├── src/compaction.ts                      # digest renderer + compaction hook         (T-286)
├── src/contradiction.ts                   # rule + shadow decision                    (T-295, T-296)
└── test/*.test.ts
scripts/commands/think.mjs                 # /think                                     (T-282)
scripts/dashboard.mjs                      # thoughts panel                             (T-290)
```

---

### Task 1: `ThoughtNode` contract (T-281)

- [ ] Add to `packages/contracts/src/thought.ts`:

```ts
export const THOUGHT_KINDS = ['attempt', 'finding', 'decision', 'constraint', 'artifact'] as const
export type ThoughtKind = typeof THOUGHT_KINDS[number]
export interface ThoughtNode {
  id: string                         // 'n-<n>' for ephemeral, 'p-<n>' for persistent
  scope: 'ephemeral' | 'persistent'
  kind: ThoughtKind
  claim: string                      // one sentence, <= 200 chars
  evidence: string[]                 // tool/result ids or human-readable refs
  confidence: 'verified' | 'asserted'
  derivedFrom: string[]
  turn: number
  at: string
  provenance?: { sessionId: string, model: string, persona: string, promotedAt: string }   // required when persistent
  stub?: { recoverFrom: string }     // set when demoted: where the full node can be recovered
}
export function validateThoughtNode(v: unknown): Result<ThoughtNode>
```

- [ ] Tests: each rule from Global Constraints (claim length, single sentence, known kind,
  provenance required for persistent, `derivedFrom` ids well-formed), plus a round trip.
- [ ] Commit `feat(contracts): thought node contract (T-281)`.

### Task 2: Event and projection (T-280)

- [ ] Using seam-signatures §14, define `thought/node` (payload: `{op: 'add'|'link'|'forget'|'demote', node?, from?, to?, id?}`)
  as **log-only**. Register the `thoughts` projection with `stateVersion: 1`. The fold: `add` inserts,
  `link` appends to `derivedFrom`, `forget` removes, `demote` replaces the node with a stub, and
  `task/start` resets to empty. (If the substrate has no `task/start` event, use the goal-set event
  from §12 and record that choice in `docs/10-THOUGHT-GRAPH.md`.)
- [ ] Unit test the fold as a pure function over an event array, including reset on a task boundary.
- [ ] Boot test: a scripted model calls `think_add` (Task 4) twice, then the session is compacted
  (use the substrate's compaction trigger, or a tiny context window in the test profile), and the
  projection still holds both nodes afterwards. **This test is the reason the design works.**
- [ ] Commit `feat(thoughts): log-only thought/node event and projection (T-280)`.

### Task 3: Service and persistent store (T-282 backend, T-284, T-288, T-297)

- [ ] `ctx.thoughts`: `add(node) → id`, `link(a, b)`, `search(query, {scope?, kind?, limit=10})`
  (case-insensitive token overlap over `claim`, then by degree, then by recency. No embeddings in v1),
  `open(id) → {node, neighbours}`, `promote(id, {replace?})`, `forget(id)`, `demote(id)`.
- [ ] `store.ts` on `ctx.storage` (§15): `{version, nodes: ThoughtNode[]}` under a project-scoped key
  (a hash of the workspace path). `promote` validates `confidence === 'verified'`, attaches
  provenance, checks the byte cap (**error when full**), writes, then **re-reads and compares**
  (write verified by read-back, context-retention-patterns #3).
- [ ] `demote(id)`: the node becomes `{...stub fields, stub: {recoverFrom: 'session:<id>#event:<n>'}}`, never deleted (T-288).
- [ ] `revoke({sessionId? , model?})`: forget every persistent node with matching provenance (T-297),
  returning the count. Exposed as `/think revoke --session <id>`.
- [ ] Tests for every rule; an HMR test; a concurrent-promote test (two promotes race; both land
  or one retries; no lost write).
- [ ] Commit `feat(thoughts): service and capped, attributed persistent store (T-284, T-288, T-297)`.

### Task 4: Tools and the evidence rule (T-283, T-287)

- [ ] `think_add {kind, claim, evidence?: string[], derivedFrom?: string[], confidence?}`,
  `think_search {query, scope?, kind?}`, `think_open {id}` (seam §2; optional params omit `required`).
- [ ] Evidence rule (T-287): on `think_add` with `confidence: 'verified'`, every `evidence` entry that
  looks like a tool-result id must be a `tool/result` from the **current turn** (read the turn's events
  from the session projection). If none qualifies, store the node as `asserted` and return
  `stored as asserted: no evidence read in this turn`. Test both paths in a boot test.
- [ ] Commit `feat(thoughts): think_add/search/open tools with the in-turn evidence rule (T-283, T-287)`.

### Task 5: What reaches the prompt (T-285, T-286)

- [ ] `inject.ts`: a `system-prompt/assemble` section `verness-constraints` built **once per session**
  (cache it by session id at the first assemble, then return the cached text on every later call), from
  persistent `constraint` nodes, newest first, cut at 1.5 KiB with `(+N more; think_search to see them)`.
- [ ] `compaction.ts`: a pure `renderDigest(nodes, {maxBytes: 2048})` for the current task's
  `finding` + `decision` nodes: order by degree then recency, one line each `[id] claim (evidence: n)`,
  and an omitted-count line. Hook it into compaction per the seam (§14 notes or the compaction
  package's contribution point; record which in `docs/10-THOUGHT-GRAPH.md`).
- [ ] Tests: the cap, frozen-ness (a node promoted mid-session does **not** change the section until
  the next session), and digest ordering and cap. A boot test asserts the section appears once in
  `system/message`.
- [ ] Commit `feat(thoughts): frozen constraint injection and a structured compaction digest (T-285, T-286)`.

### Task 6: Subagent isolation (T-289)

- [ ] Nothing is added to a subagent's context automatically. Add a `seed: string[]` option wherever
  our plugins start subagents (M7 evaluator, WS-B T-172). It copies exactly those nodes into the
  child's first message as a delimited block.
- [ ] Boot test (Review Focus 5): an evaluator subagent started after 3 `think_add` calls receives 0 nodes;
  with `seed: ['n-2']` it receives exactly that one.
- [ ] Commit `feat(thoughts): subagents get only explicitly seeded nodes (T-289)`.

### Task 7: Contradictions and the decision assist (T-296, T-295)

- [ ] Rule baseline (`contradiction.ts`): a new persistent candidate "may contradict" an existing
  node when they share ≥ 60% of their content tokens and exactly one of them contains a negation
  (`not`, `never`, `no`, `isn't`, `doesn't`, `cannot`). `promote` then refuses with both claims
  printed and the hint `promote --replace <old-id>` (T-296).
- [ ] Decision assist (T-295), shadow only: through `ctx.decisions` (M3), ask
  `worth_persisting: {yes, no}` on promote and `contradicts: {yes, no}` on each rule candidate pair.
  Log both beside the rule's answer as `source: 'thoughts'` records in the same shadow log WS-E
  calibrates. They apply only after WS-E's gate passes for those keys.
- [ ] Commit `feat(thoughts): contradictions surface, never overwrite; shadowed decision assist (T-296, T-295)`.

### Task 8: `/think` and the dashboard panel (T-282, T-290)

- [ ] `scripts/commands/think.mjs`: `list`, `show <id>` read the projection from the latest session
  log (via `lib/sessions.mjs`; no model call). `add`, `link`, `promote`, `forget`, `revoke` run a
  one-shot `dsh --json` turn scripted to call the tool. **Say in the command summary that those
  cost one model turn.** If the substrate exposes a direct tool-invocation CLI (check
  seam-signatures §2), use it instead and make them zero-token.
- [ ] Dashboard (T-290): a `Thoughts` section per session. Nodes as a table with `derivedFrom` shown as
  links (`n-3 → n-5`), plus the persistent inventory with provenance and a byte meter against the cap.
  Reuse WS-D's aggregation style: a pure `thoughtsView(events)` in `scripts/lib/obs.mjs` with a unit test.
- [ ] Commit `feat(thoughts): /think command and dashboard panel (T-282, T-290)`.

## Exit
- A boot test proves nodes survive compaction.
- A full persistent store errors instead of dropping.
- `/think revoke --session <id>` removes every node that session produced.
- The evaluator subagent sees no nodes unless seeded.
- `docs/10-THOUGHT-GRAPH.md` status changes from "designed, not implemented" to "implemented", with
  the two seam choices recorded (task boundary event, compaction contribution point).
