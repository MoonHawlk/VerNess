# 09 — Handoff: decision-driven routing (task level, model tier, pipeline)

> **Purpose**: start a fresh session with zero re-derivation. Read this file, `docs/00-OVERVIEW.md`
> (the five laws) and `docs/08-DECISION-LAYER-LAYA.md` (what Laya is and is not), then begin at
> "First session plan" below. Task block **T-250..T-262**.

## The goal, in one sentence

Before the harness spends an LLM turn, a ~200 ms decision model answers three typed questions —
**how hard is this task, which model tier should serve it, which pipeline should run it** — so that
expensive intelligence is only invoked where cheap computation could not decide (law 3).

## What already exists (do not rebuild)

| Piece | State | Where |
|---|---|---|
| Substrate + profile + launcher | working | `./turn_on.cmd`, `scripts/verness.mjs` |
| Local generative model (Qwen3 0.6B, HF GGUF) | working, `up`/`stats`/`down` | `scripts/model.mjs`, ADR-0007 |
| Personas as files, teams, quick-tool registry | **committed but unwired** — see T-140..T-146 | `scripts/commands/`, `scripts/lib/` |
| Decision layer | **planned only** | `docs/08-DECISION-LAYER-LAYA.md`, ADR-0009 |
| Session-log reader (usage/telemetry) | working | `scripts/lib/sessions.mjs` |

**Order matters**: T-140 (REPL dispatch) and T-141 (`writePatch` honouring persona state) are
prerequisites for anything interactive here. Fix those first or the new work is unreachable.

## The three decisions, specified

All three are `choice` questions with small option sets — Laya's strong regime. No `score`
questions (weakest primitive, SST-5 0.372) and no `noul` (issue #156). One call answers all three:
every question in a call shares a single forward pass.

### 1. Task level
```json
{"type": "choice",
 "instructions": "How much work does this request require from an engineering assistant?",
 "criteria": {
   "trivial":  "a lookup or a one-line answer; no files need to be read",
   "simple":   "one file or one command; the path is obvious",
   "standard": "several steps across a few files, but the approach is known",
   "complex":  "many steps, unclear approach, or design decisions are needed",
   "research": "the answer is not known and must be investigated before acting"}}
```

### 2. Model tier — **never a model id**
```json
{"type": "choice",
 "instructions": "What capability does this request actually need?",
 "criteria": {
   "local_small": "mechanical work: formatting, extraction, a known command",
   "local_large": "ordinary reasoning over a small amount of context",
   "frontier":    "hard reasoning, long context, or code that must be correct first time"}}
```
The tier maps to a concrete model through the **capability router** (TODO.md §34): the persona
declares requirements, each model declares capabilities, the router picks. Laya narrows the search
space; it does not name the winner.

### 3. Pipeline
```json
{"type": "choice",
 "instructions": "Which execution strategy fits this request?",
 "criteria": {
   "standard": "one model turn with tools",
   "agent":    "plan first, then execute over several turns",
   "decision": "a deterministic or rule-driven loop; little generation needed",
   "adaptive": "reduce the problem with cheap computation first, then reason over what survives"}}
```

## Shadow mode: the only safe way to turn this on

Laya scores **0.362 zero-shot** on typed decisions against a **0.461 majority-class** baseline, and
ships with mean **ECE 0.466**. So it does not get to steer anything on day one.

```
task -> rules decide (as today)          <- what actually runs
     -> Laya decides in parallel         <- logged, never applied
     -> both recorded with the outcome   <- becomes the labelled set
```

1. **Phase 1 — shadow.** Every task asks Laya and logs `{question, answer, answer_confidence,
   rule_answer, what_actually_happened}` to `.verness/decisions/*.jsonl`. Zero behaviour change.
2. **Phase 2 — measure.** After ~200 logged decisions, label them and report accuracy, ECE and
   AUROC against the rule baseline (T-220..T-222). Refit one temperature per (question type, option
   count) — the card measures ECE 0.466 → 0.081 from exactly this.
3. **Phase 3 — gated rollout.** Enable one question at a time, high-confidence band only, rules
   still owning everything below the threshold. `pipeline` first (cheapest to get wrong), then
   `level`, then `tier` (most expensive to get wrong).

Shadow mode is not ceremony: it is the *only* way to obtain the labelled data that phase 2 needs,
and it costs one extra ~200 ms call per task.

## Confidence bands

Gate on **`answer_confidence`** (the temperature-calibrated field), never `confidence` (raw entropy)
and never `act_probability` (no usable signal, issue #185).

| Band | Action |
|---|---|
| ≥ high threshold | use Laya's answer |
| middle | fall back to the rule provider |
| ≤ low threshold | escalate to an LLM router, or ask the operator |

Thresholds are set **from measured data in phase 2**, not chosen by taste. Until then, every band
falls back to rules.

## First session plan

```powershell
# 0. verify the harness still runs
.\turn_on.cmd doctor

# 1. wire what is already written (blocking, ~an hour)
#    T-140 REPL "/" dispatch  ->  T-141 writePatch honours persona state  ->  T-146 builtins.model

# 2. stand up the decision sidecar (T-210..T-213) — first non-Node dependency
python -m venv .verness/py            # Python 3.12.3 present, needs >=3.10
.verness\py\Scripts\pip install "laya[serve]"     # pulls torch + transformers; large download
$env:LAYA_HOST="127.0.0.1"; $env:LAYA_API_KEY=<generated>   # never bind 0.0.0.0 (ADR-0009)
.verness\py\Scripts\laya-serve

# 3. confirm the contract against the LIVE server, not the model card (T-200)
curl -s http://127.0.0.1:8000/health
curl -s http://127.0.0.1:8000/v1/systemone -H "Content-Type: application/json" -d "{...}"

# 4. then: T-201 provider -> T-206 /decide -> T-250 shadow logging
```

Expect **193–464 ms per call on CPU** (32.8 ms is the T4 figure). Respect
`LAYA_MAX_CONCURRENT` (default 16, excess returns 503) in anything that fans out.

## Task block

- **T-250** Shadow-mode logger: ask the three questions per task, log answer + `answer_confidence`
  + rule answer + outcome to `.verness/decisions/*.jsonl`. No behaviour change.
- **T-251** Rule baseline for all three questions (keyword/length/path heuristics) — the thing Laya
  must beat, and the thing that runs whenever confidence is low.
- **T-252** `/decide` extended: run the three routing questions against the current input and print
  both answers side by side (Laya vs rules) with confidences.
- **T-253** Capability router: persona requirements + model capabilities → eligible models →
  cost/latency/policy → chosen model. Tier is an input, never a model id.
- **T-254** Pipeline executor for `standard` (the other three modes already have owners in M7).
- **T-255** `/routing` quick-tool: last N routing decisions, agreement rate between Laya and rules.
- **T-260** Label the shadow set and publish accuracy/ECE/AUROC per question (feeds T-221/T-222).
- **T-261** Per-question temperature refit and re-measure.
- **T-262** Gated rollout, one question at a time, starting with `pipeline`.

## Traps already paid for (do not rediscover)

- Substrate packages are **linked** to the runtime copy, never installed as a second copy — a module
  local `Symbol` breaks every tool call otherwise (`docs/RUNBOOK.md`).
- pnpm exits non-zero after successful installs; verify outcomes, not exit codes.
- `ollama pull` can print `Error:` and exit 0. Verify through `/api/tags`.
- On Windows, `.\turn_on.cmd` — PowerShell blocks unsigned `.ps1` by default.
- Team runner: `--parallel` and multi-line prompts both work now (T-144/T-145). A fan-out on one
  local model still contends for the same weights - measure before assuming it is faster.
