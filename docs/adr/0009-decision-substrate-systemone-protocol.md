# ADR-0009 — The decision substrate is a wire protocol, not a model; Laya is its first provider

- Status: accepted (design); implementation tracked as T-200..T-232
- Date: 2026-09-26

## Context

`DecisionModel` is the project's central contract (BRAINSTORM.md §11–13): classify, route, score, rank,
retry, stop, escalate — the work an LLM should not be paid to do. Until now it had no real provider.
The reference implementation everyone points at, TypeSafe's Jev, is a paid API with no local option,
so the plan (M3/T-034) was a stub.

`convaiinnovations/laya` (Apache-2.0, Hugging Face) is a non-autoregressive System-1 decision model:
typed questions in, typed answers with calibrated probabilities out, every question in a call
answered in one forward pass. Critically, its `laya-serve` HTTP server implements **the same
`POST /v1/systemone` request/response shape as Jev**.

## Decision

1. **We adopt the SystemOne wire protocol as the decision substrate's interface**, not any one model.
   `DecisionModel` maps onto it; providers are `laya-local` (self-hosted), `jev` (hosted), a
   fine-tuned Laya, or anything else that speaks it. This is ADR-0003 applied: the contract is
   capability-shaped, the vendor lives in an adapter.
2. **Laya runs as an out-of-process HTTP sidecar**, never inside our runtime. The launcher manages
   it as a second engine class alongside the generative engine (`decision up|stats|down`).
3. **Zero-shot Laya is a plumbing instrument, not a decision authority.** Its own model card reports
   0.362 zero-shot on typed decisions against a 0.461 majority-class baseline. No decision path ships
   enabled by default until its measured ECE beats the rule baseline it replaces (T-220..T-223).

## Why an HTTP sidecar, when ADR-0007 refused Python

ADR-0007 rejected a Python toolchain for the *generative* engine, where GGUF + Ollama gave us
native builds on all three platforms. That reasoning does not transfer: Laya ships as
`transformers` + safetensors with no GGUF, and no amount of preference makes it a Node library.

The distinction that matters is **where the Python lives**. A sidecar keeps it behind an HTTP
boundary we already know how to speak, so:

- our runtime keeps zero Python dependencies, and a broken sidecar degrades the decision layer
  instead of breaking the harness;
- the same adapter works against a hosted Jev with no code change;
- the sidecar is independently restartable, observable and killable — the `up`/`stats`/`down`
  lifecycle we already built for the model engine (ADR-0007) generalises to it.

`laya[onnx]` may later remove the sidecar entirely; that is a strictly better end state and is
tracked, not assumed.

## Consequences

- A second engine class exists. The launcher's engine vocabulary must generalise from "the model" to
  "engines", and `doctor` must report both.
- **Calibration becomes a first-class duty.** The card measures mean ECE 0.466 → 0.081 only after
  refitting a temperature per (question type, option count) on your own data. Reporting an
  uncalibrated probability as a confidence would be the most dangerous thing this layer could do.
- Two documented model bugs shape the adapter, not the caller: yes/no goes on the wire as a
  two-option `choice` (never `noul`, issue #156), and confidence comes from `confidence` (never
  `act_probability`, issue #185). The contract stays clean; the workarounds stay in the adapter.
- Every Laya-vs-Jev number we cite is vendor-published and third-party sourced. We may repeat it
  with attribution; we may not present it as measurement of ours.
- **The sidecar must never be started open.** `laya-serve` binds `0.0.0.0` with no authentication
  unless `LAYA_API_KEY` is set (model card, *Self-hosting*). Our lifecycle command binds loopback
  where the server allows it and otherwise generates a key every time — a decision service reachable
  from the LAN is an unauthenticated classifier anyone can drive.
- Python becomes a *development* prerequisite for anyone who wants the decision layer — the first
  dependency in this project that is not Node. `doctor` must say so plainly, and the harness must
  stay fully usable without it.
