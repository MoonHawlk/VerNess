# 08 — The decision layer, and Laya as its first provider

> Task block **T-200..T-232**. Status: **planned, not implemented.** Nothing in this document is
> wired yet; every claim here is sourced, and the ones we have not verified ourselves say so.

## Why this matters more than "another model"

The project's central bet (TODO.md §11–18, `docs/00-OVERVIEW.md` law 3) is that an LLM is *one* class
of compute, and that most agent decisions — route, rank, filter, retry, stop, escalate, allow/deny —
should be made by something cheaper and more reliable. Until now the `DecisionModel` contract
(M3, T-030..T-037) had no real provider: the plan was a `RuleDecisionProvider` plus a **stub** for
Jev, a paid API.

`convaiinnovations/laya` fills that slot with a self-hostable, Apache-2.0 model:

- **Non-autoregressive**: it never generates text, so there is nothing to parse and nothing to
  hallucinate. Typed questions in, typed answers with calibrated probabilities out.
- **One forward pass for every question in a call** (model card, *Architecture*).
- **~33–40 ms** per call on a T4; the card cites third-party measurements of Jev at 236–276 ms p50
  and claims ~6–8× faster ([card, *Speed*](https://huggingface.co/convaiinnovations/laya)).
- **Apache-2.0, commercial use**, weights on the Hub.

And the detail that decides our architecture:

> `laya-serve` exposes the `Router` on the same `POST /v1/systemone` request and response shape as
> TypeSafe Jev, so existing TypeSafe clients work by changing their base URL.

So we do not integrate "Laya". We integrate the **SystemOne wire protocol**, and Laya becomes the
first provider behind it — with Jev, a fine-tuned Laya, or any future compatible server as drop-in
alternatives. That is exactly what ADR-0003 (vendor-neutral contracts, vendors only in adapters) was
written for, and it is the first time that rule pays for itself.

## What Laya is NOT (read this before trusting it with anything)

The model card's *Honest Limits* section is unusually candid, and it constrains the plan:

| Limit (source: model card, *Honest Limits*) | What it forces us to do |
|---|---|
| Base checkpoints are **near chance zero-shot** on typed decisions: 0.362 (English) and 0.352 (multilingual) against **0.318 random and 0.461 majority-class**. The 0.766 figure belongs to a checkpoint fine-tuned on that benchmark's own training split. | Treat zero-shot Laya as a **plumbing instrument**, exactly like `qwen3:0.6b` (ADR-0004). No policy path may depend on its accuracy until we measure it on our own decisions. |
| **Ships over-confident**: mean ECE 0.466 → 0.081 only after refitting one temperature per (question type, option count) on your own data. | Calibration is a required step, not an optimisation (T-220..T-223). A confidence we have not calibrated is not a confidence. |
| **`noul` (yes/no) can follow its option labels instead of the state** ([#156](https://github.com/NandhaKishorM/laya/issues/156)). | Our adapter emits yes/no as a **two-option `choice`** with neutral keys, never `noul`, until we verify otherwise on our data. |
| **`action.act_probability` carries no usable signal** (reads 1.0 almost always; AUROC 0.30) ([#185](https://github.com/NandhaKishorM/laya/issues/185)). Gate on `confidence` instead (AUROC 0.77). | `DecisionResult.confidence` maps from `confidence`, never from `act_probability`. |
| Ordinal `score` questions are the weakest primitive (SST-5 0.372). | Prefer `choice` over `score` when expressing a decision. |
| High-cardinality (>20 options) degrades badly at default budgets: Banking77 0.425 vs Jev 0.870, because 77 options share a ~256-token head budget. | Keep option sets small, or split coarse-to-fine. Our `escalate/retry/complete/continue` space is 4 options — comfortably inside the good regime. |
| The Jev comparison numbers are **third-party published, never measured by the author** (no TypeSafe API access); sample sizes and prompts differ. | Quote them as vendor-reported, never as our own result. |

**Consequence for the roadmap**: Laya unblocks M3 *structurally* (a real provider behind the
contract) without unblocking it *behaviourally* (trustworthy decisions). Those are separate
milestones, and conflating them is how a system ends up routing production traffic on a coin flip.

## Integration paths

Three, in order of effort. The chosen path is (A); (B) is the fallback and (C) is the long game.

**What installing it actually costs** (PyPI metadata for `laya` 0.3.20, verified 2026-09-26):
Python ≥3.10, Apache-2.0, and the required dependencies are `torch>=2.0.0`, `transformers>=4.48.0`,
`safetensors`, `huggingface_hub`, `numpy` — so the first install pulls PyTorch (wheel size varies by platform and by CPU vs CUDA build — measure before quoting a number),
plus `fastapi`+`uvicorn` for the `serve` extra and `mcp>=2.2.0` for the `mcp` extra. Checkpoint
weights are separate: ModernBERT-large 421M total (English) and mmBERT-base 322M (multilingual).
This is the single biggest reason the sidecar stays optional and out of process.

**A. HTTP sidecar speaking the SystemOne protocol** — `pip install "laya[serve]"`, then
`laya-serve`. **It binds `0.0.0.0:8000` with no authentication unless `LAYA_API_KEY` is set**, so our
lifecycle command binds loopback where possible and always sets a key otherwise (T-211). Our side is one
`fetch` to `POST /v1/systemone`. No Python in *our* process, no new runtime in the harness, and the
same adapter works against Jev. Managed by the launcher exactly like the model engine
(`up`/`stats`/`down`, ADR-0007), as a second engine class.

**B. MCP server** — `laya[mcp]`. Verified against the substrate
(`docs/research/dsh-mcp-and-http-seams.md`): an MCP server is registered as a plain loader row in our
profile patch, its tools arrive as `mcp__<server>__<tool>`, and they pass through the *identical*
`tools/pre-execute` → guards → approval → `tools/execute` pipeline as native tools — no bypass. With
`failOnStartupError: false` (the default) a dead server degrades instead of breaking the session.
So path B costs almost no code.

It answers a different question, though. **MCP makes Laya something the model can call; path (A)
makes Laya something the harness consults before, around and instead of the model.** Only (A) can
veto a tool call or end a turn. They are complementary and a hybrid is cheap, so the plan is (A) for
control flow, (B) as an optional model-facing extra (T-240).

The precedent to imitate for (A) is already in the tree: `packages/experimental/auto-review` prepends
a classifier to `tools/pre-execute`, snapshots the pending call plus history, calls out, and parses a
strict allow/deny/ask protocol with the permission presets and approval flow. Our version swaps its
LLM call for one `POST /v1/systemone`. One notable gap: `mcp-client` has **no config-level allow/deny
for tools** — filtering needs a companion plugin calling `ctx.tools.restrict({allow, deny})`, which
is also the primitive the persona tool policy (M4) will need.

**C. `laya-ts` — no Python in the serving process.** Verified in
`docs/research/laya-model-digest.md`: the upstream repo contains `laya-ts/`, a from-scratch
TypeScript reimplementation for Node and the browser, driven by a split ONNX export
(`encoder.onnx` + `head.onnx`) whose export script checks torch-vs-ONNX agreement within 1e-4. It
ports `decide()`, the shortlist and per-language calibration, with `onnxruntime-node` as an optional
peer dependency.

This is the end state we actually want — a decision provider running *inside* a Cordis plugin, no
sidecar, no HTTP hop, no Python at run time. Two real blockers keep it out of phase 1: **`laya-ts` is
not published on npm** (checked: `registry.npmjs.org/laya-ts` returns 404), so it must be vendored or
built from the monorepo; and the ONNX export itself still requires a one-time Python run. Tracked as
T-241, and the `DecisionModel` contract is what makes swapping A for C a provider change rather than
a rewrite.

## Task block

See `docs/03-BACKLOG.md` T-200..T-232 for the authoritative list. Shape of the work:

1. **T-200..T-206 — protocol and provider.** Type the SystemOne request/response, implement
   `LayaDecisionProvider` against it behind the existing `DecisionModel` contract, plus a
   `RuleDecisionProvider` and the `CompositeDecisionModel` fallthrough (rules → decision model →
   LLM). No harness wiring yet.
2. **T-210..T-214 — lifecycle.** `./turn_on.sh decision up|stats|down`, mirroring the model engine:
   install the sidecar, start it, probe latency, shut it down and free memory. Python lives in the
   sidecar only, never in our process (ADR-0009).
3. **T-220..T-223 — calibration and evaluation.** A held-out set of *our own* decisions, a
   temperature refit, and a reported ECE/AUROC. **Gate**: no decision path may be enabled by default
   until its measured ECE beats the rule baseline it replaces.
4. **T-230..T-232 — the first two real uses**, both cheap to verify: the team task router, and the
   supervisor's continue/retry/complete/escalate decision.

## Suggested features this unlocks

Ordered by (value ÷ effort). Each is a separate proposal, not a commitment.

| # | Feature | Why it is worth doing | Depends on |
|---|---|---|---|
| 1 | **`/decide` quick-tool** — ask a typed question from the REPL, get answer + confidence, zero LLM tokens | The cheapest possible way to *feel* what the decision model is good and bad at, before trusting it anywhere | T-201 + T-140 (REPL dispatch) |
| 2 | **Team task router** — pick the persona that should own a task with one `choice` over persona ids | Improves the team runner once it works: today it is committed but unwired, its `--parallel` is a no-op, and on Windows `cmd.exe` truncates its multi-line prompts | T-201, T-144, T-145 |
| 3 | **Escalation gate in the supervisor** — continue / retry / complete / escalate as a 4-option choice | The core loop from TODO.md §13–21, and a 4-option space is Laya's strong regime | M7 + T-206 |
| 4 | **Tool-risk gate on `tools/pre-execute`** — score a tool call, map confidence bands to allow/ask/deny | Makes approvals proportional instead of all-or-nothing; the seam already exists | M9 + calibration |
| 5 | **Evaluator pre-filter** — Laya screens obvious pass/fail before an LLM evaluator is paid for | Generator ≠ evaluator (law 4) gets cheaper, so we can afford to always evaluate | M7 |
| 6 | **Progressive reduction for data work** — rank 100k candidates, send the top-k to the LLM | The 500M-row scenario in TODO.md §16–17, finally with a real ranker | M8 |
| 7 | **Decision accounting in `/cost`** — count decision calls separately and show LLM calls avoided | Turns "cheapest reliable computation first" from a slogan into a number on screen | T-136 (`/cost` wired) + T-142 |
| 8 | **Fine-tune on our own decisions** — the card's own advice (0.362 → 0.766 on its benchmark) | The only route to decisions we would actually trust; needs a labelled set we do not have yet | T-220..T-223 |
| 9 | **Guardrail/moderation pass** on inbound tasks, using the same sidecar | The model is explicitly trained for it; one more question in an existing call is ~free | T-206 |

## Answers to the questions this plan opened

From `docs/research/laya-model-digest.md` (sourced to the repo and model card; the live server
settles anything still ambiguous, T-200):

- **Per-option probabilities: yes.** A `choice` answer carries a `probabilities` map
  (`{"billing": 0.94, "technical": 0.05, ...}`) alongside `confidence` and `answer_confidence`, so
  the confidence bands feature 4 needs are available. `confidence` for choice/score is
  `1 − normalised entropy` over that distribution; `answer_confidence` is the Jev-portable field, so
  our adapter thresholds on it.
- **Binding is configurable**: `LAYA_HOST` (default `0.0.0.0`) and `LAYA_PORT` (default `8000`).
  T-211 therefore sets `LAYA_HOST=127.0.0.1` — loopback by construction, not by hope.
- **CPU latency is 193–464 ms per request**, against 32.8 ms on a T4. This matters: the ~33 ms figure
  everyone quotes is a GPU figure. On a developer laptop a decision costs a few hundred milliseconds
  — still one to two orders cheaper than an LLM turn, but not free, and batching is what recovers it
  (~10 ms → ~1 ms per decision when batched on GPU).
- **Checkpoint switching is expensive**: 7.4 s (CPU) / 10.3 s (T4) per reload, so a long-lived
  preloaded sidecar beats per-call loading, which is an argument for path (A) over naive in-process
  loading until (C) is ready.

Still open: cold-start download sizes per checkpoint and true offline operation after first pull;
Windows lifecycle management of the sidecar; and whether our own decisions land in Laya's strong
regime at all — which only T-220..T-223 can answer.
