# ADR-0007 — Local model: Hugging Face GGUF weights through an Ollama engine

- Status: accepted
- Date: 2026-09-25

## Context
We need a small model (Qwen3 0.6B) that boots on Windows, macOS and Linux with no per-OS work, is
observable, and can be shut down cleanly. The obvious Hugging Face route is `transformers` — which
means Python, a virtualenv, and PyTorch wheels that differ per OS and accelerator.

## Decision
Weights come **from Hugging Face**; the runner is **Ollama**, used as an engine:

```
model.source = "hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0"
```

Ollama pulls any published GGUF straight from a Hugging Face repo, ships native builds for all three
platforms, and exposes an OpenAI-compatible endpoint — which is exactly what the harness route
already speaks. So one code path (`scripts/model.mjs`) covers every platform, with no Python.

`./turn_on.sh up | stats | down` are the three lifecycle commands:
- **up** — install the engine if missing (winget / brew / install.sh), start the server, pull the
  GGUF from Hugging Face, warm it into memory, record run state.
- **stats** — engine version, what is resident and how much memory it holds (GPU vs CPU split),
  expiry, the catalogue, and a live latency probe (round trip, tok/s, prompt-eval and load time).
- **down** — evict the weights (`keep_alive: 0`, which is what actually frees RAM/VRAM), stop the
  server **only if VerNess started it**, and clear run state. `--force` overrides that last rule.

## Why not transformers / llama.cpp directly
- `transformers`: adds a Python toolchain and per-OS wheels — the opposite of plug and play, for a
  0.6B model we only use to exercise plumbing.
- `llama.cpp` server: would work and is OpenAI-compatible, but we would own fetching and updating a
  prebuilt binary per OS and architecture. Ollama already does that, and can still serve the exact
  same GGUF files.

## Consequences
- Quant tags are not free-form: only quants actually published in the Hugging Face repo are valid
  (`Qwen/Qwen3-0.6B-GGUF` publishes `Q8_0` only; `Q4_K_M` fails with `400 ... tag is not available`).
  Check the repo's file list before changing `model.source`.
- `ollama pull` can print `Error: ...` and still **exit 0** — another case where the exit code is not
  the signal. `up` verifies the outcome through `/api/tags`.
- A server VerNess adopted (already running, or the OS-managed menu-bar/service app) is never killed
  by `down` without `--force`; on Windows the app may relaunch itself regardless.
- `/api/ps` reports resident size including the context allocation, so a 610 MiB GGUF can show as
  ~5 GiB in memory. That is real memory held, not a reporting error — it is why `down` matters.
- Swapping to a bigger model is one field (`model.source` + `model.id`), no code change.
