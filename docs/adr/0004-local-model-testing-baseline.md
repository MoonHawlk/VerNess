# ADR-0004 — Local Ollama model as the default testing baseline

- Status: accepted
- Date: 2026-09-25

## Context
Every harness test that reaches the agent loop costs money and needs a network round trip. We need
a zero-cost, offline-capable baseline for plumbing tests (does the plugin mount, does the tool
dispatch, does the seam fire) — behavior quality is not what these tests measure.

## Decision
Testing runs against **Ollama** (`http://localhost:11434/v1`) with a very small model
(`qwen3:0.6b`, 522 MB) declared as a hand-written `pi-ai` route named `ollama-local`.
No adapter of ours is needed: `@deepseek-ai/dsh-llm-pi-ai` already supports OpenAI-compatible
self-hosted gateways, so the whole integration is configuration in
`profiles/verness/cordis.patch.yml`.

Frontier providers stay available by switching `agent-default-model` back to `deepseek-official`
(or any other configured route) — one patch row.

## Why
- Zero marginal cost and no credential needed for the majority of our tests (mount, registration,
  dispatch, policy, routing decisions).
- It exercises the *real* agent loop, not a mock, so it catches integration faults a unit test
  cannot (it already caught a module-identity bug — see Consequences).
- It keeps the vendor-neutrality law honest: if the harness only works with one provider, we would
  not have noticed.

## Consequences
- `qwen3:0.6b` is a plumbing instrument, not a quality instrument: it leaks reasoning, echoes the
  system prompt, and calls tools unreliably. Never assert output *quality* against it.
- A keyless route is refused (`PI_AI_ERROR: No API key`), so the route declares
  `apiKeyEnv: OLLAMA_API_KEY` and any non-empty value is exported; Ollama ignores bearer auth.
- Tool-calling capability is required of the chosen model. Models without it can still test
  mounting and prompt assembly, nothing further.
- Anything asserting real model behavior must run on a frontier route and be marked as such.
