# 14 — Performance between chats: plan

Status: **planned** (2026-10-03). Workstream **WS-P**, tasks T-455..T-466 in `03-BACKLOG.md`.

A chat turn in FiNess is slow because one message pays for several things that have nothing to do
with the answer: a fresh substrate process, extra model calls, hidden reasoning tokens and a large
request repeated on every step. This plan measures each cost, removes the cheap ones first, then
changes the structure that causes the expensive one.

---

## 1. What one message costs today (measured)

Measured on the owner's Windows machine, local route `ollama-local` with Qwen3 0.6B, over the newest
25 sessions (53 turns) and with direct timings of the launcher's steps.

| # | Where | Cost | How it was measured |
|---|---|---|---|
| A | **A new `dsh` process per message** (Node start, Cordis boot, plugin load, profile and session load) | **~3.0 s** per message | `dsh --profile finess "hi"` with the engine down: 3.26 s and 2.93 s to the connect failure |
| B | Model reasoning ("thinking") | **91% of generated characters** (1,190 reasoning vs 112 answer chars per step) | `assistant/message` content parts in the session logs |
| C | One LLM step | 2.5 s average; 1.5 steps per turn; a turn averages 3.9 s inside dsh | `step/start` to `assistant/message`, `turn/start` to `turn/end` |
| D | **Session-title LLM call** on the first turn of every session | **2.3 s**, 22 of 25 sessions | `session/title-llm-request` to `session/title` (provider) |
| E | Request size sent on every step (system prompt, 25 tool schemas, runtime context) | ~20 KB per request | `request/header` events |
| F | Runtime-context snapshot injected as a user message | 1 per session start (~1.1 KB) | `user/message` "Current runtime context" |
| G | Shadow decision call (Laya) before every task, awaited | ~0.95 s mean when the sidecar is up | `/cost` decision line (20 calls) |
| H | Launcher pre-task work: config re-read ~8x, session listing (75 ms), budget usage (72 ms), git snapshot (108 ms), engine probes (≤ 1 s each when down) | ~0.3-0.4 s, up to ~2 s with a slow probe | `scripts/lib/*` timed directly |
| I | Model unloaded between chats (`OLLAMA_KEEP_ALIVE` 5 min) | a reload on the next message after a pause | Ollama server config in its log |
| J | Tool failures on the 0.6B model (20 of 33 calls) | extra steps and retries | `/dashboard` tool table (T-438) |

**A simple question today:** about 0.4 s (H) + 1 s (G, when Laya is up) + 3 s (A) + 2.3 s (D, first
turn) + 2.5 s x 1.5 (C, mostly B) ≈ **7-10 s**, and the same again minus D for every next message.

## 2. Targets

| Case | Today | Target |
|---|---|---|
| Next message in a running chat, short answer, local model | ~5-7 s | **< 1.5 s** to the first token, < 3 s total |
| First message of a new chat | ~7-10 s | < 3 s |
| Launcher overhead before dsh gets the task | 0.4-2 s | **< 100 ms** |
| Requests to the model per short answer | 2-3 (title, steps) | 1 |

## 3. The plan

### Phase 0 — Measure every turn (do first)

- **T-455 Per-turn trace.** The launcher stamps each stage (input, config, decision, route, attach,
  budget, snapshot, spawn, first event, first token, end) into `.finess/perf.jsonl`, and reads the
  substrate's own step timings from the session log. `/perf` prints the last turn as a waterfall and
  p50/p95 over recent turns; the dashboard gets a "Where the time goes" panel. Every later task is
  judged by this trace, not by feel.
- **T-456 Benchmark.** `scripts/tools/bench.mjs` runs a fixed set of prompts (a greeting, a one-line
  question, a file read, a two-tool task) N times on the active route and reports p50/p95 per stage,
  steps and tokens. CI runs the launcher-only part (no model) as a regression gate.

### Phase 1 — Quick wins: configuration and small code (days)

- **T-457 Reasoning off for small local models.** Config `model.reasoning: off | on | auto`
  (`auto` = off under 4B). Rendered into the route as Qwen3's no-think switch (Ollama `think: false`,
  or the model's documented prompt switch). Expected: a step drops from ~2.5 s to well under 1 s,
  because 91% of what it generates today is reasoning.
- **T-458 No title LLM call on local routes.** Keep the substrate's fallback title (the first prompt)
  and turn the `session-title-first-prompt-llm` provider off for local routes in the profile patch
  (or point it at a cheap hosted model when one is configured). Saves 2.3 s on every first message
  and stops it competing with the answer on a one-request-at-a-time engine.
- **T-459 Keep the model loaded.** While FiNess runs, ask the engine to keep the model resident
  (`keep_alive` on the warm-up request, configurable `model.keepAlive`, default 30m); `/down` and
  `/off` still unload. Removes the reload after a pause.
- **T-460 Decision call off the critical path.** The shadow decision request runs in parallel with
  the task (fire and log when it returns), never awaited before the spawn. Saves ~1 s per message when
  Laya is up; nothing it decides is acted on today anyway.
- **T-461 Launcher pre-task diet.** Read the config once per turn (cached by mtime); cache session
  listings and budget usage by file mtime instead of decompressing every session every turn; run the
  git snapshot, attachment expansion and route probe concurrently; skip the engine probe when it
  answered in the last 30 s. Target < 100 ms before the spawn.

### Phase 2 — Structural: one living substrate instead of one per message (weeks)

- **T-462 Persistent dsh session.** Keep one headless dsh process alive for the REPL and send each
  message to it, instead of spawning a new process per message. Research first which entry the pinned
  substrate offers for this (its stdio/ACP apps, the SDK client in `packages/sdk/client`, or the web
  server's API that the browser UI already uses), with file:line evidence; then a launcher-side
  client with reconnect, cancel (ctrl+c aborts the turn, not the process), and a fallback to
  spawn-per-message. Removes ~3 s from every message after the first. This is the largest single gain.
- **T-463 Smaller requests.** Offer the model only the tools its persona may use (the `tools.restrict`
  seam, T-234) instead of 25 schemas, and trim tool descriptions for small models. Fewer input tokens
  per step means faster prompt evaluation on every step.
- **T-464 Stable prompt prefix.** Keep the system prompt and tool list byte-identical across turns and
  put volatile content (runtime context, notes, attachments) after them, so the engine's prompt
  (KV) cache is reused instead of re-evaluating the whole prefix each step. Verify with the engine's
  `prompt_eval_count` before/after.

### Phase 3 — Fewer, better model calls

- **T-465 Right-size the model per task.** Use the capability router (T-253) to send short chat to a
  small fast model and tool-heavy work to a 4B+ model or an API route; the 0.6B model's tool failures
  (J) cost extra steps. Advisory first, then gated like the decision rollout.
- **T-466 Streaming first token.** Make sure the answer streams to the terminal as it is generated
  (and the web UI shows the first token), so perceived latency is time-to-first-token, not total.

## 4. Order and expected effect

| Order | Task | Effort | Expected saving per message |
|---|---|---|---|
| 1 | T-455 trace, T-456 bench | small | (makes the rest measurable) |
| 2 | T-457 reasoning off | small | ~1.5-2 s per step |
| 3 | T-458 no title call | small | 2.3 s on first messages |
| 4 | T-460 decision off the path | small | ~1 s (with Laya up) |
| 5 | T-459 keep alive | small | a full model load after pauses |
| 6 | T-461 pre-task diet | small-medium | 0.3-2 s |
| 7 | T-462 persistent dsh | large | ~3 s on every message |
| 8 | T-463 smaller requests, T-464 stable prefix | medium | faster prompt eval each step |
| 9 | T-465 right-size, T-466 streaming | medium | fewer retries; better perceived speed |

Phase 1 alone should take a short local answer from ~5-7 s to ~3-4 s; Phase 2 brings it under the
1.5 s target.

## 5. Rules for this work

- Every change lands with a before/after from T-455/T-456 in `04-PROGRESS.md`.
- Nothing may change answers silently: reasoning off is a config default with an override, the title
  falls back to the first prompt, and the persistent session falls back to spawn-per-message.
- Windows and macOS identical; the trace must work on both.
