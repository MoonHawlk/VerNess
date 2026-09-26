# Context-retention patterns for a thought graph

Sources: `.refs/hermes-agent/website/docs/**` (Hermes Agent docs), `.refs/cwc-long-running-agents/**` (Anthropic's long-running-agent harness primitives). All line numbers/quotes below are from those trees as checked out in this repo. Claims marked **[inference]** are mine, not stated in the docs.

## 1. Hermes memory: on-disk shape, caps, load timing, write API, why frozen

- **Files**: two flat files, `MEMORY.md` (agent notes) and `USER.md` (user profile), both under `~/.hermes/memories/` (per-profile: `~/.hermes/profiles/<name>/memories/`). — `.refs/hermes-agent/website/docs/user-guide/features/memory.md:13-20`
- **Size caps**: `MEMORY.md` 2,200 chars (~800 tokens), `USER.md` 1,375 chars (~500 tokens). Enforced as hard char limits, not token limits. — `memory.md:15-18, 158-165`
- **No auto-compaction**: "Memory does **not** auto-compact: when a write would exceed the limit, the `memory` tool returns an error instead of silently dropping entries. The agent then makes room itself." — `memory.md:27-33`
- **Load timing — session start only**: "Both are stored in `~/.hermes/memories/` and are injected into the system prompt as a frozen snapshot at session start." — `memory.md:20`. Format example is a literal header block with a usage percentage, `§`-delimited entries. — `memory.md:38-49`
- **Frozen-snapshot / prompt-cache rationale (exact quote)**: "**Frozen snapshot pattern:** The system prompt injection is captured once at session start and never changes mid-session. This is intentional — it preserves the LLM's prefix cache for performance. When the agent adds/removes memory entries during a session, the changes are persisted to disk immediately but won't appear in the system prompt until the next session starts. Tool responses always show the live state." — `memory.md:57`
- Session boundary is the whole point of the design: "The whole memory system is built around the moment a session **ends**... Inside a single session none of that machinery has a reason to run." — `memory.md:61-65`. Practice: run `/new` at natural boundaries so the frozen snapshot is refreshed. — `memory.md:65`
- **Write API — three actions, no read**: `add`, `replace` (substring match via `old_text`, whole-entry overwrite), `remove` (substring match). "There is no `read` action — memory content is automatically injected into the system prompt at session start." — `memory.md:90-113`
- **Duplicate rejection** and **security scanning** (prompt-injection/exfil patterns, invisible-unicode) happen before a write is accepted. — `memory.md:210-216`
- **Approval gate**: `memory.write_approval: true` stages writes (foreground and background-review writes alike) for human approve/reject via `/memory pending|approve|reject`. — `memory.md:293-327`
- **Session search is the overflow valve**: unlimited, SQLite+FTS5, on-demand, zero token cost until queried, vs. memory's fixed ~1,300-token-per-session cost. — `memory.md:218-244` (comparison table at 235-244)

## 2. Skills vs. memory: procedural/factual split, progressive disclosure

- **Split, stated directly**: "Skills and memory work together in the self-improvement loop: memory stores small durable facts that should always be in context, while skills store longer procedures that should load only when relevant." — `skills.md:614-617`
- Memory doc restates the same split from the other side: "For a location the agent needs on every run of a recurring task, a skill is often the better home than a memory entry — it loads only when relevant and does not compete for the 2,200-character budget." — `memory.md:88`
- **Progressive disclosure — three levels, exact costs given**:
  ```
  Level 0: skills_list()           → [{name, description, category}, ...]   (~3k tokens)
  Level 1: skill_view(name)        → Full content + metadata       (varies)
  Level 2: skill_view(name, path)  → Specific reference file       (varies)
  ```
  "The agent only loads the full skill content when it actually needs it." — `skills.md:196-205`
- Large sources become **knowledge-base skills**: a lean `SKILL.md` (core mental models + index) plus one distilled file per topic under `references/`, loaded on demand. "Reference files cost nothing until a question needs one... query cost stays proportional to the answer, not the source." — `skills.md:167-178`
- Linter enforces the shape that keeps disclosure cheap: `oversized-body` warns when `SKILL.md` body exceeds ~24k chars because `skill_view` loads the *whole file* and it then stays in context for the rest of the session; `references-sprawl` warns past 60 reference files. — `skills.md:643-648`
- Skill content is explicitly *lessons, not logs*: "a pitfall is a generalizable rule plus one clause of why... Incident narration, PR or issue numbers, dates, and quoted chat are not skill content." — `skills.md:634-641`
- Bundles load several skills' full content via one slash command but "do not invalidate the prompt cache... a fresh user message... no system prompt mutation." — `skills.md:594-599`

## 3. `delegate_task` / subagents: exact context contract

- **Subagents start blank**: "Subagents start with a **completely fresh conversation**. They have zero knowledge of the parent's conversation history, prior tool calls, or anything discussed before delegation. The subagent's only context comes from the `goal` and `context` fields." — `delegation.md:82-84`
- **One inherited exception**: when the parent has a resolved workspace, the child's system prompt embeds that workspace's project context files (`.hermes.md` > AGENTS.md chain > CLAUDE.md > `.cursorrules`, same discovery/priority/size caps as the parent; SOUL.md excluded). — `delegation.md:86`
- Parent must pass **everything**: "the parent agent must pass everything the subagent needs in the call" with a BAD/GOOD example contrasting `goal="Fix the error"` against a fully self-contained goal+context. — `delegation.md:88-103`
- **What returns to the parent**: "Only the final summary enters the parent's context, keeping token usage efficient." — `delegation.md:578`. Optional `output_schema` turns that into a validated JSON contract, with one bounded correction turn on schema failure and a `schema_valid:false` fallback that still returns the raw text rather than discarding work. — `delegation.md:55-78`
- **Token economics is explicit, stated as the reason for the split**: "Decomposing a problem into well-specified subtasks takes frontier-level judgment; executing a subtask that already comes with a clear goal, full context, and an output contract usually doesn't. Meanwhile the children are where the tokens go — a parallel batch of subagents typically burns the large majority of a run's total tokens." Recommends frontier model for the parent/planner, cheap model pinned via `delegation.model` for children. — `delegation.md:277-292`
- **Blocked tools for children** (even if parent has them): `delegate_task` (leaf only — orchestrators keep it, depth-gated), `clarify`, `memory` (no shared-memory writes), `send_message`, `cronjob`. Both roles keep `execute_code`. — `delegation.md:329-341, 571-576`
- **Live transcripts persist independently of the summary**: one append-only log per task under `cache/delegation/live/<id>/task-<n>.log`, pruned after 7 days — "the full-fidelity operational record alongside the summary." — `delegation.md:518-530`
- **Depth is opt-in and flat by default** (`max_spawn_depth: 1`), explicitly to prevent runaway recursive delegation / cost blowup (3×3×3 example). — `delegation.md:532-550`
- Subagents compact independently, at the lower of the parent's ratio threshold and an optional absolute cap — i.e. a child's context management is its own, not shared with the parent's window. — `delegation.md:667`

## 4. Hermes context compression: trigger, preserved, dropped

- **Dual layers**: gateway "session hygiene" (85% of context, rough estimate, safety net) and the agent's own `ContextCompressor` (50% default, real token counts, primary mechanism). — `context-compression-and-caching.md:66-99`
- **Trigger token source priority**: real API-reported tokens from last turn → persisted usage anchor + delta of appended messages → rough char estimate, in that order. — `context-compression-and-caching.md:90-93, 107-116`
- **4-phase algorithm**:
  1. Prune old tool results (>200 chars, outside protected tail) to a stub — cheap, no LLM call.
  2. Determine boundaries: `protect_first_n` (system + first exchange) / middle → summarized / tail by token budget or `protect_last_n`, boundaries aligned to not split tool_call/tool_result pairs.
  3. Generate a **structured summary** via auxiliary LLM with fixed sections: Goal, Constraints & Preferences, Progress (Done/In Progress/Blocked), Key Decisions, Relevant Files, Next Steps, Critical Context.
  4. Reassemble: head + summary + tail; orphaned tool pairs sanitized.
  — `context-compression-and-caching.md:485-584`
- **What's preserved**: system prompt, first exchange, a token-budgeted verbatim tail (`lean` mode default: 2.5% of context window, 10K floor/25K cap), the structured summary, a mechanically extracted anchor index (PR numbers, SHAs, paths, error strings — "regex, never paraphrased"), every real user message verbatim, and a `session_search` recovery pointer. — `context-compression-and-caching.md:261, 511-521`
- **What's dropped**: everything in the middle not captured by the summary; old tool outputs are stubbed even before a full compression triggers. Failure mode: if the summary model's context window is smaller than the main model's, the whole middle is silently dropped **without a summary** — flagged as "the most common cause of degraded compaction quality." — `context-compression-and-caching.md:525-527`
- **Iterative re-compression**: later compactions pass the previous summary back to the LLM to *update* rather than resummarize from scratch, so information persists across multiple compaction cycles. — `context-compression-and-caching.md:576-584`
- **Cache interaction**: compression invalidates the cache for the compressed region but the system-prompt cache breakpoint survives; the rolling 3-message cache window re-establishes within 1-2 turns. Any mid-conversation model/credential change costs a full uncached re-read — stated as unavoidable, not a bug. — `context-compression-and-caching.md:694-709`

## 5. Anthropic cwc-long-running-agents: handoff, evidence log, commit-on-stop, fresh-context evaluator

- **Three primitives, named explicitly** in the README table: Default-FAIL contract, Fresh-context evaluator, Agent-maintained handoff. — `README.md:11-17, 40-46`
- **PROGRESS.md handoff pattern**: `CLAUDE.md` instructs every session to read `PROGRESS.md` first ("It is your handoff note from the previous session"), with four fixed sections `## Done / ## In progress / ## Next / ## Notes`, then `git log --oneline -10` and a smoke test before touching anything — "so you know you're starting from a working tree, not a broken handoff." Session scope is one feature at a time; new mid-session asks get appended to `PROGRESS.md` rather than context-switching immediately. — `claude-code-config/.claude/CLAUDE.md:6-11`
- **Why the handoff is agent-written, not harness-derived** (README, exact reasoning): "A fresh session has no memory of what the previous one did, and when a long session fills its context window Claude Code summarizes the history, which loses detail. So the agent maintains the handoff itself." — `README.md:63`
- **Evidence log / default-FAIL contract**: a `test-results.json` where every criterion starts `false`. `track-read.sh` (PreToolUse on `Read`) appends any opened screenshot/console-log/result file to `.claude/.evidence-reads`. `verify-gate.sh` (PreToolUse on `Write|Edit`) blocks any write to the results file unless that log is non-empty, then **consumes it** (truncates to empty) so the next claim needs fresh proof: "consume the evidence so the next change needs fresh proof." — `hooks/track-read.sh:1-11`, `hooks/verify-gate.sh:13-29`
- Explicitly flagged as a *teaching example, not a security boundary*: it only hooks Write/Edit (a shell `sed`/`jq` could bypass it), the path match is basename-only, and any evidence read unlocks any result row, not the specific one it's evidence for. — `hooks/verify-gate.sh:9-12`
- **Commit-on-stop**: a `Stop` hook runs `git commit -am "session checkpoint: <ts>"` only when there's a diff, using `-am` deliberately so *untracked* ephemeral artifacts (screenshots, logs) never enter history — the agent is expected to `git add` real source files itself. Fails silently; treated as a backstop, not the primary commit discipline (CLAUDE.md: "commit often... at meaningful checkpoints with descriptive messages"). — `hooks/commit-on-stop.sh:5-17`, `CLAUDE.md:23-24`
- **Fresh-context evaluator**: a separate subagent (`agents/evaluator.md`) with `tools: Read, Glob, Grep, Bash` — **no Write/Edit** — explicitly told "You did not see how it was built and you should not trust the builder's own assessment," must open every evidence file itself ("If a file fails to open or returns an error, treat it as missing evidence"), and must answer with a bare `PASS`/`NEEDS_WORK` first line so a wrapper script can parse it. "Plausibility is not correctness... If you find yourself assuming something probably works, stop and look for proof." On `NEEDS_WORK` its findings become the next builder session's starting prompt. — `agents/evaluator.md:1-25`, `README.md:60`
- **What makes it survive a context reset [docs' own framing]**: the combination of (a) durable state living entirely on disk/in git rather than in-context (PROGRESS.md, test-results.json, git log), (b) a structural read-before-write gate so a compacted/reset agent can't fabricate "done," and (c) a judge that never shares the builder's context so it can't inherit the builder's blind spots or a corrupted/compacted memory of its own work. — synthesized from `README.md:11-17,60-66` and `CLAUDE.md:6-18`.
- Two operator-control hooks, same file-as-channel pattern: `kill-switch.sh` blocks every tool call while `./AGENT_STOP` exists; `steer.sh` surfaces `STEER.md` contents once (as a `block` decision carrying `"OPERATOR STEERING: ..."`) then clears the file, and is explicitly noted as "a convenience channel, not a trust boundary" since an agent with write access could write its own steering. — `hooks/kill-switch.sh`, `hooks/steer.sh`

## 6. Synthesis — what a thought graph should learn

**NODE SHAPE**
- Recommendation: give every node a fixed, small structured schema, not free text — mirror Hermes's compression summary template (Goal / Constraints / Progress / Decisions / Files / Next / Critical Context, `context-compression-and-caching.md:532-558`) and cwc's PROGRESS.md four-section shape (`CLAUDE.md:6-11`). Evidence: both independent designs converge on "structured slots survive summarization better than prose," and Hermes explicitly reuses the previous summary as structured input to the next compaction rather than raw transcript (`context-compression-and-caching.md:576-584`).
- Recommendation: cap node size hard, in characters not "as needed," the way MEMORY.md/USER.md are capped (2,200 / 1,375 chars, `memory.md:15-18`) — a byte ceiling forces consolidation instead of silent creep.

**WHEN IT IS WRITTEN**
- Recommendation: EPHEMERAL nodes write continuously during a task step (like PROGRESS.md updates "after each completed item," `CLAUDE.md:20-21`, and cwc's commit-on-checkpoint discipline). PERSISTENT nodes should be promoted deliberately via an explicit tool call analogous to `memory(action="add")` — never an automatic side effect of ordinary conversation, since Hermes's memory tool requires an explicit call and a sentence like "I've saved that" without the tool call is a documented failure mode (`memory.md:71-78`).
- Recommendation: gate promotion of a PERSISTENT node behind evidence, mirroring the default-FAIL contract: a node claiming "task X succeeded" should require that the agent actually opened proof (test output, screenshot) in the same turn, enforced structurally (`verify-gate.sh:13-29`) rather than by instruction alone ("Asking nicely in the prompt doesn't reliably stop this," `README.md:50`).

**WHEN IT IS READ BACK INTO THE PROMPT**
- Recommendation: read PERSISTENT nodes back only at session/task-start as a frozen block, not on every turn — exactly Hermes's frozen-snapshot pattern, for the same prefix-cache reason ("captured once at session start... preserves the LLM's prefix cache," `memory.md:57`). Mid-session mutations to the graph should be persisted to storage immediately but excluded from the live prompt until the next boundary.
- Recommendation: EPHEMERAL nodes stay in the live transcript/tail and need no separate re-injection — they are what compression's `protect_last_n`/token-budget tail already protects (`context-compression-and-caching.md:512-517`).
- Recommendation: give the agent a session-search-equivalent (query graph nodes on demand, zero standing token cost) rather than trying to cram history into the always-loaded budget — this is exactly why Hermes pairs bounded MEMORY.md with unlimited, on-demand `session_search` (`memory.md:218-244`).

**EVICTION / COMPACTION**
- Recommendation: no silent auto-drop of PERSISTENT nodes — require an explicit consolidate-or-remove step when a capacity limit is hit, as memory's `add` does (returns an error naming current entries, asks the agent to `replace`/`remove` before retrying, `memory.md:167-186`). Silent loss is the failure mode Hermes explicitly avoids here.
- Recommendation: for EPHEMERAL nodes/transcript, follow the lean-tail approach: demote old detail to one-line stubs with a recovery pointer rather than deleting outright (`context-compression-and-caching.md:261`), and keep a mechanically-extracted (regex, not paraphrased) anchor index of hard facts (IDs, paths, error strings) that must never be lossily summarized.
- Recommendation: track provenance/staleness the way the compression-summary re-write does (moves items Done/In-Progress, drops obsolete info on each pass, `context-compression-and-caching.md:576-584`) rather than accreting nodes forever.

**PERSISTENCE ACROSS SESSIONS**
- Recommendation: PERSISTENT nodes live on disk (or a DB) independent of any one session's transcript, keyed so a fresh session/subagent can load them without replaying history — same principle as MEMORY.md/USER.md files plus git-committed PROGRESS.md. Durability comes from writing to storage that outlives the context window, not from hoping compaction preserves it (`README.md:63`, `memory.md:20`).
- Recommendation: subagents/forks should receive PERSISTENT nodes relevant to their task explicitly passed in (goal+context), not inherited automatically — Hermes subagents get *zero* implicit history, only what the parent puts in the call plus repo-level project-context files (`delegation.md:82-88`). This is the sharpest token-economics lesson: push a curated slice, never the whole graph.
- Recommendation: scope PERSISTENT storage per profile/workspace the way Hermes scopes memory per profile, to avoid two writers compounding into state neither authored (`memory.md:22-24` caution box).

## 7. Explicit failure modes named in the docs

- **Unbounded growth**: memory's hard char caps exist specifically "to keep system prompts bounded" (`memory.md:158-160`); skills' `oversized-body`/`references-sprawl` linter rules exist because an unbounded `SKILL.md` "stays in context for the rest of the session" once loaded (`skills.md:643-648`); compression's `threshold_tokens` absolute cap exists so even a 1M-token window doesn't grow unchecked (`context-compression-and-caching.md:258`).
- **Stale / silently-lost context**: compression's biggest named failure — summary-model window smaller than main model's window silently drops the middle with no summary at all, flagged as "the most common cause of degraded compaction quality" (`context-compression-and-caching.md:525-527`). Session-search exists precisely because "fresh memory entries also stay invisible to the running session" until the next boundary (`memory.md:63`).
- **Memory poisoning by the model's own wrong conclusions**: the entire `write_approval` gate exists to answer "the agent saved a wrong assumption about me" (`memory.md:316-318`); the fresh-context evaluator exists because "the builder shouldn't grade its own work" and "plausibility is not correctness" (`agents/evaluator.md:9,18`); the default-FAIL contract exists because agents "mark a feature 'passing' after a curl when the UI is visibly broken" (`README.md:50`).
- **Cache invalidation from mid-session rewrites**: explicitly called out — "Adding or removing messages in the middle invalidates the cache for everything after" and any mid-conversation model/credential swap forces a full uncached re-read at undiscounted price, which is why the frozen-snapshot pattern for memory exists at all (`context-compression-and-caching.md:691-709`, `memory.md:57`).
- **Claimed-but-not-executed writes**: "a sentence like 'I've added that to my memory' is just text" — small/weak-tool-calling models confirm saves that never happened; the fix is verifying the on-disk file, not trusting the transcript (`memory.md:71-78`).
- **Two writers on one store**: pointing two agent processes at the same Hermes home "compound[s] each other's entries into state neither of them (nor you) authored" (`memory.md:22-24`).
- **Runaway recursive delegation cost**: nested orchestration is flat by default specifically to prevent this, with the 3×3×3=27-concurrent-agent example as a warning (`delegation.md:532-550`).
- **Evidence gate is not a real security boundary**: the cwc harness authors state their own gate can be bypassed by `sed`/`jq`, matches paths too loosely, and lets any evidence unlock any row — an explicit warning against treating a teaching-example gate as sufficient (`hooks/verify-gate.sh:9-12`).
- **Operator channel is not a trust boundary either**: `steer.sh`'s STEER.md channel can be self-written by an agent with filesystem access, so it's convenience, not control (`hooks/steer.sh:6-7`).

## Ten rules for our thought graph

1. Every node gets a fixed structured schema (goal/progress/decisions/next), not free prose, because both Hermes's compression summary and cwc's PROGRESS.md converge on that shape surviving compaction best (§6, §4, §5).
2. Cap PERSISTENT node storage in bytes, and make a full store return an error listing current entries rather than silently dropping or truncating anything (§1, §7).
3. PERSISTENT nodes are only written by an explicit tool call, verified by re-reading storage, never inferred from the model's own narrated confirmation (§1, §7).
4. Promoting a node to PERSISTENT (marking a step "done") requires the agent to have read its own evidence in that turn, enforced structurally, not just requested in a prompt (§5, §7).
5. PERSISTENT nodes are injected into the prompt as a frozen block at session/task-start only, and mid-session mutations wait for the next boundary, to protect the prefix cache (§1, §6).
6. EPHEMERAL nodes live in the live transcript/tail and get evicted by demotion-to-stub-with-pointer, never outright deletion (§4, §6).
7. Give the agent an on-demand, zero-standing-cost search over the full node history, separate from the small always-loaded PERSISTENT set (§1, §6).
8. A subagent or forked worker receives only the specific nodes relevant to its task, explicitly passed in the call — never the whole graph by inheritance (§3, §6).
9. Anything that judges whether a node's claim is true must run in a context that never saw the work being judged (§5, §7).
10. Durability comes from writing PERSISTENT nodes to storage that outlives the context window (disk/DB/git), not from trusting that compaction or the model's memory will preserve them (§5, §6, §7).

