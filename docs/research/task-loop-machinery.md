# Task-loop machinery for `/loop-task`

Research for a `/loop-task <objective>` command that keeps a small local model
working autonomously until the objective is met or a limit stops it, without
the model repeating itself into a non-converging cycle.

Sources: `upstream/deepseek-harness/packages/**`, `.refs/hermes-agent/website/docs/**`,
`.refs/cwc-long-running-agents/**`. All paths below are relative to the repo
root unless given in full.

---

## 1. `ctx.goals` + `goal-round-driver` — the continuation mechanism

Package: `upstream/deepseek-harness/packages/goal/goal-round-driver/src/index.ts`
(state machine) + `.../src/prompt.ts` (injected text) + goal domain types in
`packages/goal/goal/src/types.ts`.

**Stop condition lives in the goal state**, not the driver: a `GoalView` carries
`phase` (`active|paused|blocked|complete`), `activation` (`armed|disarmed`,
process-local, never persisted), `roundsStarted`, and `maxGoalRounds`. The
driver only asks "is there capacity and is it armed":

```ts
// packages/goal/goal-round-driver/src/index.ts
const goal = currentGoal(state)
if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return
if (goal.roundsStarted >= goal.maxGoalRounds) {
  ctx.goals.block(agent, goalRef(goal), {
    code: 'round-limit',
    message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.`,
  })
  return
}
const round = goal.roundsStarted + 1
const content = renderGoalRoundPrompt(goal, round)
```

**Round cap**: `maxGoalRounds` is set at goal creation (`CreateGoalRequest`);
default resolved by the service config. **Only an admitted round increments
`roundsStarted`** (session projection in `packages/goal/goal/src/domain.ts`) —
a rejected/stale reservation does not consume the round number.

**What gets injected each round** (`packages/goal/goal-round-driver/src/prompt.ts`):
one `<goal_round>` user-message block naming the JSON-quoted objective, the
`round/maxGoalRounds` counter, and an instruction to treat current workspace
and tool results as authoritative rather than trusting earlier narration, to
make concrete progress, gather evidence before claiming completion, and leave
the goal active if work remains.

**Continuation trigger**: a round is queued only at whole-agent idle
(`agent.status === 'idle'`), with no competing queued message, an armed goal,
fiber active, and the driver not stopping (`readyToDrive`). It's driven by
event listeners (`agent/status`, `goal/changed`, `agent/inbox/*`,
`session/event`) that call `requestDrive`, which serializes into one drive
loop per agent. Race fences on `agent/pre-step` (`validReservation`) reject a
stale/cancelled/competing prompt both before and after downstream listeners
run.

**Stops automatically** when: the round cap is exhausted (blocks with code
`round-limit`), a turn ends with `max-tokens`, a durability flush fails, the
agent is cancelled, or the plugin unloads. Human messages arriving mid-flight
pause/interrupt automatic continuation; `dsh-tool-goal` requires the same
blocking condition to persist for `blockedAfterConsecutiveRounds` (default 3)
consecutive rounds before the model may self-block — see §7 below, this is
the substrate's only "stagnation" throttle, and it throttles *blocking*, not
looping.

**Known limitation, stated by the package itself**: "No independent
evaluator — the model-facing goal policy decides when evidence is sufficient
for completion... evaluator-backed certification remains deferred." Same-
session only; no Ralph-style fresh-context restart.

---

## 2. `agent/turn-stopping` — exact signature and continuation contract

`upstream/deepseek-harness/packages/core/agent/src/runtime-types.ts:381` (line
number of the hook itself; doc block starts a few lines earlier):

```ts
'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> | void
```

- **Dispatch mode**: `@mode serial` — every listener runs, none can short-
  circuit the others' invocation (contrast with `@mode waterfall` for
  `agent/pre-step`, which chains transformable decisions, and `@mode emit`
  for pure notifications like `agent/assistant-stream`/`agent/error`).
- **Semantics**: fires when "the model owes no response (no live tool calls,
  no fresh steering)" and is awaited *before* the turn boundary commits.
- **A listener does not return a value to object.** It objects by calling
  `agent.steer(...)` during the hook; the machine re-reads the agent's inbox
  after all listeners settle — "fresh steering runs another step, none closes
  the turn. Data decides, so listener order cannot change the outcome."
- **The inverse (stop a tool loop early) is not this hook at all** — it's data
  carried on a tool result: `concludesTurn` ends the turn at that step.
- This is exactly the mechanism `goal-round-driver` would use if it operated
  at turn-stop instead of idle+event-driven scheduling; in practice the driver
  uses `agent/status` idle + `agent/pre-step`, not `agent/turn-stopping`
  directly — worth noting for `/loop-task`'s own hook choice.

---

## 3. Headless continuation — `dsh --profile headless`

Package: `packages/bundle/headless/README.md` + Agent Note
`.agents/notes/archived/architecture/2026-08-09-headless-direct-core-entry-point.md`.

**Yes, drivable in a loop from outside, via a stable session id**:

```sh
dsh --profile headless "run the tests"
dsh --profile headless --session-id my-loop-1 "next step: ..."
```

- Every invocation defaults to a fresh `session-<uuid>`; pass `--session-id`
  to **adopt** a persisted session and continue it. Adoption fails loudly if
  the id is unknown, if an Agent is *already live* under that id in-process
  (exclusivity — no two owners), or if the recorded cwd/preset don't match.
- Each invocation is exactly **one task per process**: "the same product
  contract is one local task with final assistant text on stdout... no
  interactive follow-up." So an outer bash/PowerShell loop driving `/loop-task`
  would be: (a) create session, (b) loop invoking `dsh --profile headless
  --session-id X "<next-round prompt>"` and inspect exit code / `--json`
  stream, (c) stop on `completed` or a caller-side round/time budget.
- `--json` gives newline-delimited events (`session`, `status`, `text`,
  `thinking`, `tool_call`, `tool_result`, `final`, `error`) so a wrapper script
  can detect stagnation itself (e.g. diff tool_call sequences across
  invocations) without touching harness internals.
- **Exit mapping**: exit 0 iff the final `turn/end` reason is `completed`;
  everything else (aborted, error, no turn in interval) exits 1.

**Complete `TurnEndReason` kind list** (`packages/core/session/src/types.ts:201-227`,
`TurnEndReasonMap`, merge-extensible):

| kind | meaning |
|---|---|
| `completed` | normal end, model owed no more response |
| `aborted` | a cancellation interrupted the live turn (carries `TurnEndCancelCause`: `user`, `parent`, `hook`, `disposed`, or legacy) |
| `blocked` | (approval/goal-style block) |
| `error` | turn failed; carries a structured `LlmFailure` |
| `max-tokens` | at least one step hit its output-token ceiling |
| `interrupted` | crash-orphaned turn closed after the fact on resume/cold read; loop never emits this live |
| `forked` | fork-seed construction closed a turn open at the fork boundary; loop never emits this live |

`goal-round-driver` reacts specifically to `max-tokens` (disarms) and
`aborted` (marks the in-flight attempt cancelled) via the `session/event`
switch on `turn/end`.

---

## 4. Anti-repetition — `repeat-tool-reminder` (exists, is advisory only)

Package: `upstream/deepseek-harness/packages/guard/repeat-tool-reminder/src/index.ts`.
This is the harness's *only* loop-detection/dedupe mechanism I found; there is
no independent "no-progress" detector or hard loop-breaker anywhere else in
the tree (`grep` across `packages/` for loop-detect/dedupe/stagnation/cycle-
detect turned up nothing else load-bearing — everything else is a false
positive on the word "loop"/"repeat" in unrelated UI/localization code).

Mechanism:
- Chain keyed by **`(tool name, canonical arguments)`** per agent, in a
  `WeakMap<Agent, Chain>`. Canonicalization = deep key-sort + `JSON.stringify`
  (property order ignored, but **exact-match only** — a tweaked path or extra
  whitespace evades it).
- Counted in `tools/post-execute` (also fires for **denied** calls — "a model
  hammering a denied call is exactly the loop worth breaking").
- Configurable `thresholds` (default `[3, 5, 8]`): first threshold delivers a
  gentle reminder, later ones a detailed one naming tool/count/args:

```ts
const GENTLE_REMINDER =
  'You are repeating the exact same tool call with identical arguments. '
  + 'Carefully analyze the previous result before calling again...'
```

```
Repeated tool call detected:
- tool: <toolName>
- consecutive_calls: <count>
- arguments: <canonicalArguments>
The repeated calls are not making progress. Do not call this tool with
these exact arguments again...
```

- Delivered as an injected `user/message` (`additionalContexts`), never
  blocking — `PostToolDecision` supports blocking but this package doesn't use
  it. Reset on any `user`-sourced message (`agent/pre-step` listener deletes
  the chain). **In-memory only** — a session resume starts a fresh chain.
- **Stated limitations** (from its own README): exact-match only (no fuzzy
  near-duplicate detection); compaction does not reset chains; advisory only,
  no escalation to a hard block; no cross-subagent chain sharing; a chain
  goes silent past the highest configured threshold (no periodic re-nudge).

Separately, `dsh-tool-jobs`'s `maxConsecutiveWakes` (packages/jobs/tool-jobs)
caps how many times an idle owner may be woken by background-job completions
before notices degrade to silent injection — a different kind of "stop
self-exciting loops" primitive, for the wake/job axis rather than tool calls.

**Bottom line for item 4**: repetition detection exists and is real, but it
is (a) exact-match, (b) advisory/nudge-only, (c) has no notion of "no
progress" beyond identical calls, and (d) is not wired to actually end a
turn or block a goal round. `/loop-task` needs to add real teeth on top.

---

## 5. Hermes — continue/stop decision, budgets, `delegate_task`

Source: `.refs/hermes-agent/website/docs/developer-guide/agent-loop.md`.

Loop shape (`AIAgent.run_conversation()`, `agent/conversation_loop.py`):
prepare → build/cache system prompt → check preflight compression (>50%
context) → build API messages → make interruptible API call → parse response
→ **if tool_calls: execute, append results, loop back to step 5; if text:
persist session, flush memory, return.** So "another round" = model emitted
a tool call; "stop" = model emitted a plain text response with no tool call.

**Budgets** (`## Budget and Fallback Behavior`):
```
- Default: 500 iterations (configurable via `agent.max_turns`)
- Each agent gets its own budget. Subagents get independent budgets capped at
  `delegation.max_iterations` (default 50) — total iterations across parent +
  subagents can exceed the parent's cap
- At 100%, the agent stops and returns a summary of work done
```

**No-progress rule found**: a narrow, specific one — "A Codex Responses turn
that stalls on reasoning-only output (three consecutive continuations with no
visible text or tool call) also fails over to the next fallback with reason
`incomplete_response`; if the stall consumed the iteration budget, the
fallback gets exactly one bounded grace call." This is a stall detector, not
a repeated-identical-call detector — Hermes doesn't appear to have the latter
(nothing found matching dedupe/repeat-call in the agent-loop doc).

**`delegate_task` bounding**: intercepted before the general tool registry
(`agent/tool_executor.py`), spawns subagent(s) with isolated context; each
subagent gets its own `IterationBudget` capped by `delegation.max_iterations`
(default 50), independent of and not deducted from the parent's 500-iteration
cap. `subagent-lifecycle-api.md` additionally notes the public lifecycle API's
requests are fail-closed: sizes capped, unknown/parent-broadening toolsets
rejected, and **per-launch timeouts are explicitly rejected until Hermes can
support them without weakening isolation** — i.e. Hermes currently has no
wall-clock timeout on a subagent, only the iteration cap.

Compression triggers at 50% (preflight) / 85% (gateway auto) context use,
independent of the iteration budget.

---

## 6. Anthropic `cwc-long-running-agents` — generator/evaluator round structure

Source: `.refs/cwc-long-running-agents/README.md` and
`claude-code-config/.claude/agents/evaluator.md`.

Three primitives form "the quality loop":

1. **Default-FAIL contract** — every criterion in `test-results.json` starts
   `false`; `hooks/verify-gate.sh` denies any write to that file unless the
   agent has first *Read* an evidence file (screenshot/log) this session:
   ```
   {"decision":"block","reason":"Cannot modify the results file: no screenshot
   or console-log evidence has been Read this session. Open the evidence file
   with the Read tool first, then retry."}
   ```
   (tracked via `.claude/.evidence-reads`, written by `hooks/track-read.sh`,
   consumed/reset on each gated write — so proof must be fresh every time).
2. **Fresh-context evaluator** — a separate subagent (`agents/evaluator.md`,
   tools `Read, Glob, Grep, Bash`, **no Write/Edit**) that never saw the build.
   It receives: the spec/acceptance criteria, `git diff` against baseline, and
   every screenshot/console-log the builder produced. It returns, as the
   literal first line, `PASS` or `NEEDS_WORK`, followed by either one
   evidence-citing sentence or a bullet list of fixable findings.
3. **Agent-maintained handoff** — the builder writes `PROGRESS.md` and
   commits to git each checkpoint; `hooks/commit-on-stop.sh` is a Stop-hook
   backstop that commits whatever's left uncommitted at session end.

**Exact round wiring** (the loop itself, from the README):
```bash
while grep -q '"passes": false' test-results.json; do
  claude -p "Read PROGRESS.md and build the next unfinished feature per CLAUDE.md."
  VERDICT=$(claude --agent evaluator -p "Review the most recent commit against its spec.")
  [ "$(echo "$VERDICT" | head -1)" = "PASS" ] || echo "$VERDICT" > NEXT_FINDINGS.md
done
```
The verdict's first line is parsed by the wrapper (`head -1`); on anything but
`PASS`, the full findings are written to `NEXT_FINDINGS.md`, which becomes the
next builder session's starting context, closing the loop. **Exit conditions,
explicitly listed**: "the contract file has nothing left failing, a cycle
makes no changes, or a budget is hit; `touch AGENT_STOP` to stop early." Note
"a cycle makes no changes" is named as an exit condition but is *not* itself
implemented anywhere in the shipped hooks — it's left to the wrapper author.

Operator controls: `hooks/kill-switch.sh` blocks every tool call while
`./AGENT_STOP` exists (`{"decision":"block","reason":"Kill switch engaged..."}`);
`hooks/steer.sh` surfaces `STEER.md` once then clears it, for mid-run redirection.

Alternative in-product path noted: Claude Code's built-in `/goal` command runs
the same generator/evaluator shape natively, with a separate fast model
checking a plain-English completion condition after every turn — directly
analogous to `dsh-goal` + `goal-round-driver`, but with the evaluator as a
second model call rather than the same model's own self-report.

---

## 7. Budgets and safety in the substrate

- **Round budget**: `maxGoalRounds` on the goal (§1) — hard cap, blocks with
  `round-limit` when exhausted.
- **Self-block throttle**: `dsh-tool-goal`'s `blockedAfterConsecutiveRounds`
  (default 3) — the model may not mark a goal `blocked` until the *same*
  condition has persisted for that many consecutive rounds; enforced at
  execution time (`packages/goal/tool-goal/src/index.ts:308`), not just prompted.
- **Background-job wake budget**: `tool-jobs`'s `maxConsecutiveWakes` — caps
  self-exciting wake chains from background-job completions before delivery
  degrades to silent inbox injection (`packages/jobs/tool-jobs/README.md`).
- **Turn-level token ceiling**: `turn/end` reason `max-tokens` (§3) is itself
  a safety valve the goal driver reacts to by disarming.
- **Approval gate**: `packages/interaction/user-approval` — `ctx.approval`,
  per-session `ApprovalPolicy` of `'ask'` (default, delegates to answerer
  chain, fails closed to `unavailable`→denied with no answerer) or `'never'`
  (deterministically `rejected`, "the strict headless stance (CI, unattended
  runs)"). For an unattended `/loop-task`, `policy: 'never'` plus explicitly
  allow-listed safe tools is the documented headless pattern, not a bypass.
- **Cost/token accounting**: `ctx.tokenMeter` (`packages/llm/token-meter`) —
  replay-based, deterministic, no model calls; exposes `measure(session)` →
  `{totalTokens, surfaceTokens, nodes}` and `estimateMessage(message)`. It
  explicitly "adds no model-visible content and makes no loop decisions" —
  i.e. it's a read-only gauge; nothing in the substrate currently wires it to
  a stop condition (that wiring would be `/loop-task`'s own job).
- **`ctx.jobs`**: no run-length/budget field on the job contract itself
  beyond `maxConcurrentJobsPerOwner` (default 10) and ring-buffer byte caps
  (`retainBytes`/`settledRetainBytes`); no wall-clock timeout per job found.
- **NOT VERIFIED**: I found no per-turn wall-clock timeout config in the
  harness (only token-based and round-based limits); if one exists it wasn't
  surfaced by these searches and should be treated as absent until confirmed
  against `packages/core/agent-loop`.

---

## Design recommendations for `/loop-task`

1. **Model the objective as a `ctx.goals`-style state machine, not a bare
   prompt loop.** Reuse the shape in `packages/goal/goal/src/types.ts`:
   `phase` (active/paused/blocked/complete) + `roundsStarted`/`maxGoalRounds`
   + `activation`. Cheap — it's a data-shape decision, no new infra.
2. **Drive continuation the way `goal-round-driver` does**: only requeue at
   whole-agent idle, with a durable revision/CAS check
   (`packages/goal/goal-round-driver/src/index.ts`, `validReservation`), not
   from inside a tool-call handler. Cheap to copy the pattern; avoids the
   race class that package's `RoundAttempt`/fence machinery exists to close.
3. **Use `agent/turn-stopping` (`runtime-types.ts:381`) as the hook point for
   "should another round happen"** rather than reacting only to `turn/end` —
   it's awaited before the boundary commits, so a listener can `steer()` to
   keep going with zero extra turns. Cheap, direct reuse of an existing hook.
4. **Anti-repetition defense #1 (cheap, do first): port
   `repeat-tool-reminder`'s exact-match chain but make the top threshold
   *block*, not just nudge**, for `/loop-task` specifically (interactive
   sessions can stay advisory-only). `packages/guard/repeat-tool-reminder/src/index.ts`
   already has the canonicalization and per-agent chain; the missing piece is
   a `PostToolDecision` block returned past the last threshold.
5. **Anti-repetition defense #2 (cheap): inject a state digest each round**,
   not just the objective — e.g. append to the `<goal_round>` prompt
   (`goal-round-driver/src/prompt.ts`) a short structured summary of "files
   touched," "last N distinct tool calls," and "current goal-check result"
   pulled from session projections, so the small model sees *what already
   happened* instead of re-deriving it from scratch each round. This directly
   targets the stated failure mode (re-asking/re-deriving). Moderately cheap
   — needs a small projection, no new event types.
6. **Anti-repetition defense #3 (cheap): an explicit no-progress counter**
   independent of exact tool-call matching — track whether the workspace/
   session actually changed between rounds (e.g. hash of tool-visible state,
   or "0 file writes and 0 new tool names this round") and force a stop or a
   forced-strategy-change prompt after N stagnant rounds, mirroring Hermes's
   three-consecutive-stall fallback rule (`agent-loop.md`, "three consecutive
   continuations with no visible text or tool call"). This catches
   *semantically* repeated work that varies its arguments and thus evades
   defense #1's exact-match key.
7. **Anti-repetition defense #4 (speculative, higher value): an independent
   evaluator round**, modeled on `.refs/cwc-long-running-agents`'s
   `evaluator.md` — a second, fresh-context pass (could be the same small
   model with a wiped context, or a distinct call) that reads `git diff` +
   evidence files and returns a bare `PASS`/`NEEDS_WORK` line, exactly as
   quoted in §6. This is the one piece none of the three sources ship as a
   generic library primitive (dsh's own README calls evaluator-backed
   certification "deferred") — treat it as the main net-new build item, not
   a reuse.
8. **Borrow the default-FAIL evidence contract wholesale**: a
   `verify-gate`-style `PreToolUse`-equivalent that refuses to let the model
   mark the objective done unless it has first read/produced a concrete
   evidence artifact this round (`.refs/cwc-long-running-agents/claude-code-config/.claude/hooks/verify-gate.sh`).
   Cheap, and it's the single highest-leverage defense against a small model
   hallucinating "done" instead of looping — different failure mode than
   repetition but usually co-occurs with it.
9. **Bound the run with the substrate's real levers, composed, not
   reinvented**: `maxGoalRounds` (hard round cap) + `blockedAfterConsecutiveRounds`-
   style consecutive-condition throttle (§1/§7) + `approval: 'never'` with an
   explicit tool allowlist for unattended safety (`docs/subsystems/approval.md`)
   + a wall-clock timeout enforced by the *outer* `dsh --profile headless`
   wrapper loop, since the harness itself has no verified per-turn wall-clock
   timeout (§7, NOT VERIFIED — build this at the `/loop-task` orchestration
   layer, not inside the agent).
10. **Drive it headlessly with a stable `--session-id` from an outer script**,
    inspecting `--json`'s `final`/`turn_end` events each round rather than
    trying to keep one giant in-process turn alive (`packages/bundle/headless/README.md`,
    §3). This gives `/loop-task` a natural place to run defenses #3 and #7
    (no-progress counter, evaluator) *between* invocations, where they're
    cheap to implement (shell/script logic) instead of inside the model's own
    context.

**done**

Recommended loop shape: goal-object state machine (phase/rounds/cap) driven
at agent-idle via an `agent/turn-stopping`-style hook, each round wrapped by
an outer headless `--session-id` invocation so state lives outside the
model's context. Anti-repetition, layered: (1) exact-match repeated-call
chain escalating to a hard block, not just a nudge; (2) a state-digest
injected into every round's prompt so the model sees what already happened;
(3) an explicit no-progress counter over workspace/tool-diversity, not just
identical calls; (4) an independent fresh-context evaluator returning
PASS/NEEDS_WORK before "done" is accepted. (1)+(3) are cheap, near-direct
ports of existing dsh/Hermes code; (2) is cheap but net-new; (4) is the
speculative, highest-effort piece — no source here ships it as reusable
infra.
