# Laya decision model — digest for a `DecisionModel` provider

Sources: HF model card [raw README](https://huggingface.co/convaiinnovations/laya/raw/main/README.md);
GitHub [raw README](https://raw.githubusercontent.com/NandhaKishorM/laya/main/README.md) (1131 lines);
source files fetched at HEAD (2026-09-25): `laya/agent.py`, `laya/router.py`, `laya/onnx_agent.py`,
`laya/serve.py`, `laya/mcp/server.py`, `laya-ts/README.md`, `laya-ts/package.json`. Note: two initial
`WebFetch` passes over the same URLs produced mutually-inconsistent paraphrases (invented fields,
wrong shapes) — everything below is checked against raw markdown or actual source, not a summarizer.

## 1. Python API

`Router` (`laya/router.py`): `Router(preload=True, device="cuda", max_loaded=2, default="english",
lang_guess=None)`; `router.preload([...])`, `router.attach(name, agent)`, `router.route(...)` (no
forward pass), `router.route_batch(requests)`, `router.predict_batch(requests, batch_size=8)`.

Exact `predict()` (`router.py:551`) and `system_one()` (`agent.py:1059`, `Agent.predict` is a plain
alias of it):
```python
def predict(self, state, questions, model=None, task=None, lang=None, lang_guess=None,
            hooks=None, on_predict_start=None, on_predict_end=None,
            hooks_raise=None, hooks_timeout=None, max_len=None, head_max_len=None) -> Dict[str, Any]
def system_one(self, state, questions, lang=None, hooks=None, on_predict_start=None,
                on_predict_end=None, hooks_raise=None, hooks_timeout=None,
                max_len=None, head_max_len=None) -> Dict[str, Any]
```
`system_one` calls `self.predict_batch([state], questions, ...)[0]` — **every question type in one
`predict()` call runs in ONE forward pass** ("Evaluate typed questions across state in a single,
parallel forward pass", confirmed by implementation). `Router.predict_batch` further groups multiple
*states* by (checkpoint, question schema) so N states sharing a schema also share one pass.

**Question types** — complete vocabulary, exact schema (`agent.py:1070-1078`):
```python
{"type": "choice", "instructions": "...", "criteria": {"optA": "desc", "optB": "desc"}}
{"type": "score",  "instructions": "...", "criteria": ["level0", "level1", "level2"]}
{"type": "noul",   "instructions": "...", "criteria": {"false": "...", "true": "..."},  # optional
 "labels": {"false": "B", "true": "A"}}                                                  # optional
```
**Exact answer shape** (`agent.py:759-814`, `_decode_answers`):
```python
{"type": "choice", "choice": "billing",
 "probabilities": {"billing": 0.94, "technical": 0.05, "other": 0.01},
 "confidence": 0.92, "answer_confidence": 0.92, "action": {"act_probability": 1.0}}
{"type": "score", "score": 1.84, "legend": {"0": "not urgent", "1": "soon", "2": "critical"},
 "probabilities": {"0": 0.1, "1": 0.6, "2": 0.3}, "confidence": 0.85, "answer_confidence": 0.85}
{"type": "noul", "noul": 0.892, "confidence": 0.892, "answer_confidence": 0.892}  # noul = P(true)
```
Two confidence fields exist and **differ**: `confidence` for `choice`/`score` is `1 − normalised
entropy`; `answer_confidence` is the calibrated quantity temperature-scaling fits and ECE measures,
reported uniformly for all three types (`agent.py:776-781`). **Gate on `answer_confidence`**, not
`confidence`, never on `action.act_probability` (§9). Whole call:
`{"answers": {...}, "routing": {"model", "reason"}, "usage": {"input_tokens", "output_tokens"}}`
(`routing` only from `Router`). Empty `questions` → `{"answers": {}, "usage": {"input_tokens": 0}}`,
no tokenization, no forward pass.

## 2. Checkpoints

| Checkpoint | Backbone | Params | Context | Measured file size (HTTP HEAD, `resolve/main`) |
|---|---|---|---|---|
| `convaiinnovations/laya` (root) | ModernBERT-large | 421,293,830 (HF API) | 512 (`head_max_len=192`) | `model.safetensors` 842,609,210 B (~843 MB); tokenizer 3.58 MB |
| `.../laya-multilingual` (`subfolder="multilingual"`) | mmBERT-base, 22L, 256k vocab | 322M (README) | 1024, up to 8192 (RoPE) | `model.safetensors` 643,835,514 B (~644 MB); tokenizer 34,363,188 B (~34 MB, matches README's own callout) |
| `.../laya-typed-decisions` (`subfolder="typed-decisions"`) | ModernBERT-large | 421M | 1024 | `model.safetensors` 842,609,220 B (~843 MB) |

One HF repo; non-English checkpoints are subfolders downloaded independently. Load:
`laya.load("convaiinnovations/laya", subfolder=...)`; pin via `Router.predict(..., model="typed-decisions")`
or `Router(default="multilingual")`. **Auto-routing**: pure-Python, dependency-free script/function-word
detector (`laya.lang.analyse`, <0.5 ms) runs *before* any forward pass, sending non-Latin/non-English
to `multilingual`; `typed-decisions` is never auto-selected. Rationale: "the English checkpoint
collapses on non-Latin scripts (Khmer scores 0.000 accuracy at 0.952 confidence)" — confidence
gating alone cannot catch this. `max_loaded` default 2 (LRU); `max_loaded=1` reload cost 7.4 s
(CPU) / 10.3 s (T4) per switch. **`max_len`**: 512 default (English), 1024 default
(multilingual/typed-decisions, up to 8192 via `max_len=8192`); long-doc accuracy 16-18/20 correct
to ~4000 tokens, 8-17/20 beyond (vendor-measured, script cited).

## 3. `laya[serve]` HTTP server — own schema (Jev wire-compatible), NOT OpenAI-compatible

```bash
pip install "laya[serve]"
LAYA_DEVICE=cuda LAYA_PRELOAD=1 laya-serve   # 0.0.0.0:8000
```
Only two routes: `GET /health`, `POST /v1/systemone`:
```json
{"state": {"body": "billed twice, refund please or we cancel"},
 "questions": {"dept": {"type": "choice", "instructions": "which team?",
               "criteria": {"billing": "refunds", "tech": "bugs"}}}}
```
Response = same `{"answers", "usage"}` shape as §1. Env vars (exact, `serve.py`): `LAYA_HOST`
(0.0.0.0), `LAYA_PORT` (8000), `LAYA_DEVICE`, `LAYA_PRELOAD` (1), `LAYA_MODELS`, `LAYA_THREADS`,
`LAYA_AUTO_TASK` (0), `LAYA_API_KEY` (none — sets `Authorization: Bearer <key>` requirement, else
401), `LAYA_LOG_LEVEL`, **`LAYA_MAX_CONCURRENT`** (default 16, excess → 503 "server busy" —
undocumented in either README, found only in source). Malformed question → 422; unknown fields
ignored; oversized body → 413. Designed wire-compatible with TypeSafe Jev's `POST /v1/systemone`
(an existing Jev client works by repointing `baseUrl`) with 3 documented differences: option-count
ceiling is `head_max_len`-bound (~126-254 options, not Jev's flat 255); `null` score levels rejected
(422) not scored; `confidence`'s formula differs from Jev's — use `answer_confidence` for a
portable threshold.

## 4. `laya[mcp]` MCP server — stdio only, no HTTP/SSE

```bash
pip install "laya[mcp]"
laya-mcp-server        # or: python -m laya.mcp.server
```
Docstring: "Speaks MCP over stdio"; `server.run()` takes no transport arg (stdio default).
Tools (`mcp/server.py:159-247`): `laya_status()`; `laya_route(state: dict, questions: dict)` (no
forward pass); `laya_predict(state: dict, questions: dict, model: str = "auto")`;
`laya_shortlist(state: dict, questions: dict, model: str = "auto", k: int = 20)`;
`laya_preset(preset: str, state: dict)` (`guard|moderation|triage|model_router`). `LAYA_MODELS`
empty preloads only `english,multilingual` under MCP vs "every checkpoint" under `laya-serve`
(deliberate, documented difference). Windows: `main()` sets `HF_HUB_DISABLE_SYMLINKS=1`
automatically on `os.name == "nt"` — "Windows without Developer Mode cannot create HF cache
symlinks (WinError 1314)".

## 5. `laya[onnx]` and the Node path — the real answer is `laya-ts`

- **`laya[onnx]`** (Python): `ONNXAgent` (`laya/onnx_agent.py`) loads an exported `.onnx` + original
  tokenizer/config, CPU-only. Only `system_one`/`decide` exist — **no `predict_batch`, no
  `predict_long`, no GPU fast-path**. Still Python.
- **`laya-ts/`** (in-repo dir `laya-ts/`): from-scratch TypeScript port for Node/browser via split
  ONNX export (`encoder.onnx` + `head.onnx`). One-time export (still needs Python):
  `python laya-ts/scripts/export_onnx.py --model-dir <ckpt> --out-dir ./model` (writes
  `encoder.onnx`, `head.onnx`, copies tokenizer/config; verifies torch-vs-ONNX match within 1e-4).
  Then pure Node:
  ```ts
  import { Agent, Router } from "laya-ts";
  const agent = await Agent.load("./model");   // or {device:"cuda"}, falls back to CPU + warning
  const router = new Router(); router.attach("english", agent);
  const out = await router.predict({ body: "..." }, { intent: { type: "choice", ... } });
  ```
  `onnxruntime-node`/`onnxruntime-web` are optional peer deps; browser path is WebGPU→WASM fallback.
  Ports hooks, `decide()`/JSON-schema, shortlist, per-language calibration from the Python SDK.

**Verified caveats**: not on npm (`registry.npmjs.org/laya-ts` → 404, checked directly) — must be
vendored from the GitHub monorepo. README's own "Packaging" note, quoted verbatim: *"ponytail:
CJS/browser-field dual build + tsconfig tests-include deferred — Task 7 verified ESM-only; CJS
needs second tsc config + export-map change, untested."* Version `0.1.0`; last commit touching
`laya-ts/` and the repo's last push both landed 2026-09-25 (today) — a same-day, effectively
unreleased addition. No parity claims for `predict_long` or fast-path; not benchmarked against
Python numbers anywhere.

## 6. Performance & hardware

Vendor-measured on Tesla T4 only ("every checkpoint answered byte-identical questions in the same
run"); no independent reproduction found.

| | `laya` | `laya-multilingual` |
|---|---|---|
| 1 question | 39.5 ms | 32.8 ms |
| 10 questions batched | 158.6 ms (15.9 ms/q) | 72.3 ms (7.2 ms/q) |
| 50 questions | 771 ms | 337 ms (6.8 ms/q) |

Throughput 103-332 q/s batched (T4). **CPU**: only figure is aggregate preload latency,
"193-464 ms (CPU)" per request vs 32.8 ms GPU — no per-checkpoint/per-count CPU breakdown exists.
GPU batching: "RTX 5060 Ti, ~10 ms one-by-one → ~1 ms batched (~9-10×)"; CPU batching gives little
benefit without length-sorting. `max_loaded=2` keeps english+multilingual resident; multilingual
tokenizer (34 MB) parsed once per process, reused. Platform: Python 3.10+, torch 2.14+, CUDA/MPS/XPU
supported with explicit recipes; **Windows PowerShell install is documented** (`py -3.11 -m venv
.venv`, etc.) alongside macOS/Linux. GPU not required; CPU works but is only roughly quantified.

## 7. Accuracy claims — read skeptically

Provenance discipline is unusually explicit but everything favorable is self-reported. README
states outright: "Jev figures are third-party published, never measured here (no TypeSafe API
access); sample sizes and prompts differ" — the vendor admitting its own comparison table compares
apples to a different orchard.

- **0.362 (English zero-shot) → 0.766 (fine-tuned `laya-typed-decisions`)**: benchmark is
  "typed-decisions" (2,000 decisions, 400 cases, 4 workflows) **built and evaluated by the vendor**;
  the 0.766 checkpoint was **fine-tuned on that benchmark's own training split**. Random baseline
  0.318, majority-class 0.461 — both zero-shot checkpoints (0.362, 0.352) sit *below*
  majority-class. This is "our model can be taught this specific benchmark," not a zero-shot
  capability claim, despite how the headline pairing reads.
- **vs "Jev" (TypeSafe Jev 1.13.0)**: a competing closed, paid decision-model API ($0.042/1M
  tokens). Claims of +0.039 accuracy, 3× better ECE, 6-8× lower latency are all against Jev's *own
  published* numbers, not a live comparison. Vendor is candid where Jev wins: high-cardinality
  choice (Banking77: Jev 0.870 vs Laya 0.425, an architectural token-budget limit), soft-distribution
  matching (0.580 vs 0.471), raw pre-calibration ECE.
- Only figures not authored by the Laya team: Jev's 236-276 ms p50 latency, attributed to two
  third-party GitHub benchmark repos (AbdelStark/jev-benchmarks, nibzard/decision-model-benchmark) —
  not independently re-verified by this digest either.
- Flag, not verified: HF card shows 3,689 likes and a large Spaces fan-out on a repo created
  2026-09-18, one week before this digest — consistent with genuine rapid adoption or coordinated
  promotion; **could not determine which**.

## 8. Licensing

Code: Apache 2.0 (`LICENSE` at repo root). Weights: Apache 2.0 per HF card YAML (`license:
apache-2.0`, tagged `commercial-use`); no separate weights license found. Attribution: none beyond
standard Apache-2.0 (no CLA or field-of-use restriction spotted).

## 9. Limitations / integrator failure modes (vendor-admitted, quoted precisely)

- Base checkpoints near/below chance zero-shot on typed decisions — don't trust unfine-tuned
  probabilities for real decisions (§7).
- Ships over-confident: raw ECE 0.466 (English) / 0.314 (multilingual), drops to 0.081/0.106 only
  after fitting one temperature per (question-type, option-count) bucket **on your own held-out
  data**; multilingual "ships with no fitted temperatures at all."
- `noul` can follow its `false:`/`true:` labels instead of state content, worst on English (#156) —
  workaround: two-option `choice` with neutral keys, or the `labels` override.
- Semantic labels don't fix negation: #377 — on 5 cancellation examples, `laya` selected
  `cancel_account` for all 4 negated requests despite clean semantic keys (one at p=0.9998).
  Vendor: "narrow examples, not evidence every negated state fails" — not claimed fixed.
- `action.act_probability` carries no usable signal (near-1.0 always, AUROC 0.30 vs `confidence`'s
  0.77, #185) — adapters must ignore it, gate on `answer_confidence`.
- High-cardinality choice degrades past ~20 options at default budgets (architectural, shared
  `head_max_len`) — needs overrides or `predict_shortlist` for 50+ options.
- `laya-multilingual` has a position bias on `score` (#131): rarely picks the first-listed level.
- Cold start/offline: lazy `Router()` downloads on first use (needs network); CLI routing-only mode
  "works offline, no download." `laya.load()` can hang if `transformers` probes TensorFlow — fix
  is `USE_TF=0`.
- Concurrency: `laya-serve`'s `LAYA_MAX_CONCURRENT` (16) returns 503 past that; a recent release
  fixed "concurrent calls could overwrite each other's CUDA-graph buffers" on the GPU fast path —
  a real, recently-patched bug; treat `laya[fast]` as less battle-tested under concurrency.
- Windows: HF cache symlinks fail without Developer Mode (WinError 1314) — auto-worked-around via
  `HF_HUB_DISABLE_SYMLINKS=1`; a real PowerShell install path is documented step by step.
- Tokenizer downloads: multilingual tokenizer is 34 MB (confirmed via HTTP HEAD), parsed once per
  process — non-trivial cold-start cost on constrained hosts.

## Integration implications for a Node/TypeScript harness

1. **HTTP sidecar via `laya[serve]`** (least effort). `pip install "laya[serve]"` + `laya-serve`,
   one `fetch("http://host:8000/v1/systemone", ...)` from Node (§1/§3 shapes).
   **Blocker**: still a supervised Python process (install, `GET /health` check, restart,
   ~843 MB-1.6 GB downloads on first run); no first-class Windows *service* story (only a
   Nix/NixOS systemd module + manual PowerShell install) — the launcher must build this itself.

2. **MCP stdio server via `laya[mcp]`** (comparable effort, wrong shape for gating). 5 named tools
   (§4), stdio, easy to wire into an MCP-aware harness.
   **Blocker**: makes Laya something the *model* can choose to call, not something the harness
   consults *before* an expensive call — cannot veto a tool call or gate a turn the way
   `DecisionModel` needs for routing/retry/escalate. Still a supervised Python process.

3. **`laya-ts` — no Python at request time** (most Node-native, least mature). Native TypeScript,
   `onnxruntime-node`/`onnxruntime-web` optional peer deps, ports hooks/`decide()`/shortlist/
   per-language calibration (§5).
   **Blocker**: not on npm (confirmed 404) — must vendor from the monorepo; own README flags
   CJS/browser packaging "untested"; version `0.1.0`, pushed the same day as this research
   (effectively unreleased); still needs one offline, one-time Python step (`export_onnx.py`) to
   produce the ONNX weights — "no Python" is true only for the serving process, not the full
   pipeline from a fresh checkpoint.
