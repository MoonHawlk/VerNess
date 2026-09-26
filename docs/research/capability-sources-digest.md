# Capability Sources Digest

Reusable design contracts for porting onto a plugin layer over `deepseek-harness`.
No code copied — formats/mechanisms only. Paths relative to source repo.

- A = `.refs/hermes-agent` (`website/docs/**`)
- B = `.refs/cwc-long-running-agents`

---

## 1. Hermes Agent

### 1.1 Skills

Layout (`developer-guide/creating-skills.md`): `skills/<category>/<name>/SKILL.md`
(required) plus optional `scripts/`, `references/`, `templates/` loaded on demand.
Bundled: `skills/`; official-optional: `optional-skills/`; user: `~/.hermes/skills/`;
plugin-bundled skills namespaced `plugin:skill`.

Front-matter (verbatim shape, lines 46-79): `name`, `description`, `version`,
`platforms: [macos, linux]` (optional OS gate); `metadata.hermes.tags`,
`.requires_toolsets`/`.requires_tools` (hide if NOT active/available),
`.fallback_for_toolsets`/`.fallback_for_tools` (hide if IS active/available),
`.config: [{key, description, default, prompt}]` (non-secret settings ->
config.yaml), `.blueprint: {schedule, deliver, prompt, no_agent}` (marks skill
runnable as cron); top-level `required_environment_variables:
[{name, prompt, help, required_for}]` (secrets). Body: `# Title` then
`## When to Use / Quick Reference / Procedure / Pitfalls / Verification`.

Activation: every installed skill auto-becomes a slash command (`/skill-name`);
agent can also load one via a `skill_view` tool call from natural language.
Visibility gated by `requires_toolsets`/`requires_tools`/`fallback_for_*` against
the session's active tools, plus `platforms:` OS gating.

Progressive disclosure (three-tier, `guides/work-with-skills.md` L75-84):
1. `skills_list()` — compact list, ~3k tokens, at session start.
2. `skill_view(name)` — full SKILL.md, only when relevant.
3. `skill_view(name, file_path)` — one reference file, only if needed.
Zero token cost until step 2.

Prompt injection: SKILL.md body injected as a message with
`[Skill directory: /abs/path]`; two template tokens substituted in body:
`${HERMES_SKILL_DIR}`, `${HERMES_SESSION_ID}`. Opt-in inline shell snippets
(`` !`cmd` ``) inline their stdout — off by default (`skills.inline_shell`).

Required-tool declaration: `requires_toolsets`/`requires_tools` = visibility
only; `required_environment_variables` (secrets, auto-passed to sandboxes) and
`required_credential_files` (OAuth files, auto-mounted read-only into
Docker/Modal) = actual dependency declarations.

### 1.2 Memory

Stored: two char-capped flat files, no auto-compaction: `MEMORY.md` (agent notes,
2,200-char limit) and `USER.md` (user profile, 1,375-char limit), `§`-delimited
entries, under `~/.hermes/memories/` (per-profile). Separately, `session_search`
= unlimited FTS5 search over SQLite session log (`~/.hermes/state.db`), on-demand,
no LLM summarization (`user-guide/features/memory.md`).

Scopes: per-profile. External providers (Honcho, Mem0, …) run *alongside*
built-in memory, never replacing it.

Mechanism: injected into system prompt as a **frozen snapshot at session start**
(never mutated mid-session, preserves prefix cache). Agent writes via a `memory`
tool: `add`/`replace`/`remove` (substring-match `old_text`); no `read` action.
Writes gateable via `write_approval: true` (staged, `/memory pending|approve|reject`).
A background post-turn review can autonomously write memory/skills (own model
routing, cost caps, idle-defer for local GPUs).

Skills vs memory (table, `work-with-skills.md` L265-274): skills = procedural,
on-demand, can be large, free until loaded; memory = factual, injected every
session, must stay compact, constant token cost. "If you'd put it in a reference
document, it's a skill; if you'd put it on a sticky note, it's memory."

### 1.3 Provider/model routing

One shared resolver (`developer-guide/provider-runtime.md`) used by CLI, gateway,
cron, ACP, auxiliary calls: `(provider, model)` → `(api_mode, api_key, base_url)`.
Providers self-register via `register_provider()` from `plugins/model-providers/<name>/`
— no resolver branch needed for a new one.

Resolution precedence: explicit CLI/runtime request > `config.yaml` saved choice >
env vars > provider defaults/auto (so a stale shell export can't override a saved
choice).

Auxiliary tasks (vision, summarization, compression, memory) can route to a
different provider/model (`auxiliary.<task>.{provider,model}`) via the same path.

Fallback chain: ordered `(provider, model)` list, tried on max-retries-invalid-
response / non-retryable 4xx (401/403/404) / max-retries-transient (429/500/502/503).
Swaps model/provider/base_url/client in place, fires once
(`_fallback_activated`). Subagents inherit provider/credentials but NOT the
fallback chain; auxiliary tasks use their own independent chain.

### 1.4 MCP integration

Config (`user-guide/features/mcp.md`), under `mcp_servers:` — stdio server:
`{command, args, env}`; HTTP server: `{url, headers, auth: oauth}`; per-server
`tools: {include: [glob...], exclude: [glob...], prompts: false, resources: false}`
(include wins on conflict); `lazy: true` (register from cache, spawn on first
call); `idle_timeout_seconds`/`max_lifetime_seconds` (recycle heavy stdio
servers); `supports_parallel_tool_calls: true`.

Tool naming: `mcp_<server_name>_<tool_name>`; server contributing ≥1 tool becomes
runtime toolset `mcp-<server>`. If everything filtered out, no empty toolset created.

Local vs remote: stdio (`command`/`args`/`env`, host shell env NOT inherited except
explicit allowlist+baseline) vs HTTP (`url`/`headers`, optional OAuth2.1
PKCE/DCR/CIMD, mTLS via `client_cert`/`client_key`). Discovery at startup, bounded
concurrency (`mcp.discovery_concurrency`, default 4). Server-pushed
`notifications/tools/list_changed` triggers automatic re-registration.

### 1.5 Subagents / sessions / compression / scheduling

**Subagents** (`user-guide/features/delegation.md`): `delegate_task(goal, context, …)`
spawns a fresh isolated child agent — zero parent history, only `goal`+`context`
(+`images`) passed in. Child inherits parent's toolsets (can't widen) but is
blocked from `delegate_task` (unless `role="orchestrator"`, depth-gated by
`max_spawn_depth`), `clarify`, `memory`, `send_message`, `cronjob`. Up to
`delegation.max_concurrent_children` (default 10) run in parallel; each gets its
own terminal session and optionally its own git worktree
(`delegation.worktree_isolation`). Only the final summary re-enters the parent's
context. Optional `output_schema` (JSON Schema) + one bounded correction turn on
failure. No wall-clock timeout by default; heartbeat/stall monitor abandons a
frozen child (450s idle / 1200s in-tool). `delegation.model`/`provider` lets
parent stay frontier while workers run cheap.

**Sessions/persistence** (`developer-guide/session-storage.md`): one SQLite DB
(`~/.hermes/state.db`, WAL) per profile: `sessions`+`messages`+`messages_fts`
(FTS5). Lineage via `parent_session_id`; source tagging (`cli`/`telegram`/
`subagent`/`cron`); contention via short SQLite timeout + jittered app-level
retry + `BEGIN IMMEDIATE`.

**Context compression** (`developer-guide/context-compression-and-caching.md`):
dual-layer — 85%-of-context gateway safety net (rough estimate, pre-agent) +
primary in-loop `ContextCompressor` at configurable ratio (default 50%, capped
absolute at `threshold_tokens`=256k). Algorithm: (1) strip old tool results
outside protected tail; (2) boundaries aligned to tool_call/result groups,
protecting first N(=3) and a token-budgeted tail (`protect_last_n`=20 min); (3)
one auxiliary-LLM call produces a structured summary (Goal/Constraints/Progress
Done-InProgress-Blocked/Key Decisions/Relevant Files/Next Steps/Critical Context),
iteratively *updated* (not re-summarized) on later compactions; (4) reassemble
head+summary+tail, repair orphaned tool pairs. Compacts **in place** (same
session id, old turns archived not deleted) by default rather than rotating —
fixed lost `/goal` state and orphaned sessions. Prompt caching: 4-breakpoint
"system_and_3" rolling strategy (system + last 3 messages), 5m/1h TTL.

**Scheduling** (`user-guide/features/cron.md`): one `cronjob_manage` tool,
action-style (create/edit/pause/resume/run/remove/list), NL or cron-expression
schedules, `--skill` attachment (loads exactly as `/skill-name` would),
`context_from`/`continuity` job-chaining (prior output prepended as next job's
context), delivery to any messaging platform/`local`/`bot-chat`, `no_agent` mode
(pure script, zero LLM cost, stdout delivered verbatim, `{"wakeAgent": false}`
= silent tick), `[SILENT]`/`[CRON_FAILURE]` output markers, pre-dispatch config
validation (blocks before spending tokens on a job that can't succeed), durable
execution ledger (`executions.db`). Model resolution: per-job pin > `cron.model`
fleet default > main agent model.

---

## 2. Anthropic cwc-long-running-agents

All files under `claude-code-config/.claude/`.

### 2.1 Generator/evaluator loop

Three independently-pluggable primitives (README.md L11-19, 48-67):

1. **Default-FAIL contract.** Project-created `test-results.json`
   (`{"feature-1":{"passes":false}}`, name overridable via `RESULTS_FILE`), every
   criterion starts false. Enforced by two hooks in `settings.json`:
   - `hooks/track-read.sh` (`PreToolUse`, matcher `Read`) — reads JSON stdin,
     extracts `tool_input.file_path`; if it matches
     `*screenshots/*|*-console.txt|*-result.txt|*.png` and the file exists, appends
     path to evidence log (`./.claude/.evidence-reads`).
   - `hooks/verify-gate.sh` (`PreToolUse`, matcher `Write|Edit`) — if target is the
     results file and evidence log is empty, emits
     `{"decision":"block","reason":"Cannot modify the results file: no screenshot
     or console-log evidence has been Read this session..."}`; otherwise consumes
     (truncates) the log so the next write needs fresh proof. Documented gaps:
     only guards Write/Edit (Bash sed/jq bypasses), basename-only match, any
     evidence unlocks any row.

2. **Fresh-context evaluator.** `agents/evaluator.md` — subagent front-matter
   `name: evaluator`, `description: Skeptical second-opinion reviewer...`,
   `tools: Read, Glob, Grep, Bash` — no Write/Edit (Bash explicitly NOT a hard
   read-only boundary). Procedure:
   read spec → `git diff` vs baseline → open every screenshot/log under
   `screenshots/`, judge actual content not filename → decide. Contract: reply's
   **first line must be the bare word `PASS` or `NEEDS_WORK`** (wrapper parses
   `head -1`); PASS + one evidence line, or NEEDS_WORK + bullet findings. Invoked
   out-of-band (`claude --agent evaluator -p "..."`), never by the builder itself.

3. **Agent-maintained handoff.** `CLAUDE.md`: read `PROGRESS.md` first (create
   with `## Done/In progress/Next/Notes` if missing), run smoke test once, work
   exactly one item per session, mark passing only after running it live +
   Reading the result + confirming it, update `PROGRESS.md` after each item,
   commit at checkpoints. Backstop: `hooks/commit-on-stop.sh` (`Stop` event) runs
   `git commit -am "session checkpoint: <ts>"` only if tracked changes exist
   (`-am`, not `-a .` — ephemeral scratch never enters history); fails silently
   with no git identity.

Stop/continue is left to the wrapper (README.md): a shell `while` loop greps
`test-results.json` for `"passes": false`, each pass runs `claude -p "Read
PROGRESS.md and build the next unfinished feature..."` then
`claude --agent evaluator -p "Review the most recent commit..."`; if the
verdict's first line isn't `PASS`, its body is written to `NEXT_FINDINGS.md` for
the next pass. Exit: contract file all-true, a cycle makes no changes, budget
hit, or `touch AGENT_STOP` (kill switch).

### 2.2 `/goal` command shape

Built into Claude Code: `/goal <plain-English completion condition>`, e.g.
`/goal every feature in PROGRESS.md is implemented, committed, and its tests pass`.
After every turn a **separate fast model** checks the condition against the
transcript, keeps the session going until met — no contract file/hooks needed.
Works in interactive, `claude -p` (headless), and Remote Control.

### 2.3 Verification pattern

Evidence = file matching a fixed glob under a known dir, opened with Read
(tracked at session granularity, one read unlocks one gated write) **and**
independently judged by a second agent with no edit tools and a fresh context
that never saw the build. Evaluator instructions: "A diff that looks reasonable
paired with a screenshot that shows a broken layout is NEEDS_WORK."

### 2.4 Context-management tactics

- **Externalize state to disk, not context.** `PROGRESS.md` is durable cross-
  session memory (fresh sessions have zero conversational memory; in-window
  summarization loses detail). `git log` is a second independent record.
- **Scope sessions narrowly.** One feature/session bounds context needed and
  keeps evaluator diffs small.
- **Operator override channels, outside model context:**
  - `hooks/kill-switch.sh` (`PreToolUse`, matcher `*`) — blocks every tool call
    while `./AGENT_STOP` exists.
  - `hooks/steer.sh` (`PreToolUse`, matcher `*`) — if `./STEER.md` has content,
    surfaces once as `{"decision":"block","reason":"OPERATOR STEERING: ..."}`,
    then clears the file.
- **Disk-only observability:** PROGRESS.md, git log, screenshots/, evidence-read
  log — `tail -f`/`watch` gives a live view, no dashboard needed.

---

## Porting priorities

- Hermes: SKILL.md front-matter schema + 3-tier progressive disclosure; the
  `memory` add/replace/remove contract with char budget + frozen-snapshot
  injection; MCP `tools.include/exclude` glob-filter shape; `delegate_task`
  isolated-child contract (goal+context only, blocked-tool list, summary-only
  return).
- Anthropic (B): default-FAIL / evidence-gate / fresh-context-evaluator loop and
  its hook JSON contract (`{"decision":"block","reason":"..."}`); evaluator's
  `PASS`/`NEEDS_WORK` first-line contract for wrapper parsing.
