# 11 — Models: install local ones, or run on an API

> Status: **built** (T-350..T-356). Open follow-ups are T-357..T-365 in `docs/03-BACKLOG.md`.
> Decision record: `docs/adr/0010-catalog-routes-and-route-state.md`.

Two things used to take a config edit, a `sync` and some luck:

- **a new local model** — edit `model.source`, know which quant the Hugging Face repo actually
  publishes, and accept that `/model <id>` would fail with `UNKNOWN_MODEL` because the profile patch
  declared exactly one model per route;
- **a hosted model** — hand-write an `extraRoutes` entry, then edit `activeRoute` in the commented
  config file, and discover that the REPL froze its route at boot.

Now both are one command, and the choice is state (`.verness/state.json`), never a config rewrite.

## Quick start

```text
/models search qwen3                         GGUF repos on Hugging Face, most downloaded first
/models add Qwen/Qwen3-1.7B-GGUF --use       fetch, register, warm, and switch to it
/model qwen3:0.6b                            switch between registered local models

/api                                         every provider the route adapter knows, key found or not
/api models <provider> [filter]              that provider's models
/api use <provider> <model>                  the agent now runs there
/api local                                   back to the local model

/access                                      how far shell and file tools reach (default: workspace)
```

The same verbs work from the shell: `.\turn_on.cmd api use <provider> <model>`, `./turn_on.sh models add …`.

### Keys

Put keys in `.env` at the repo root — it is gitignored and loaded by the launcher at startup
(a variable already set in your shell wins). `/api key <provider>` prints the exact variable name.

```text
# .env
SOME_PROVIDER_API_KEY=...
```

Never pass a key on a command line: it lands in shell and REPL history. The generated patch holds
only the variable **name** (`apiKeyEnv`); the adapter resolves it per request.

## How it works

### Three kinds of route (`scripts/lib/routes.mjs`)

| Kind | Where it comes from | What the patch declares |
|---|---|---|
| `local` | the `model` block of the config | `api`, `baseURL`, and **every registered local model** |
| `catalog` | `/api use`, or an `extraRoutes` entry with no `api`/`baseURL` | only `apiKeyEnv` — endpoint, protocol and models come from the adapter's installed catalog |
| `declared` | an `extraRoutes` entry with `api` + `baseURL` | as before: a hand-declared OpenAI-compatible gateway |

A catalog route's key **must** be the adapter's own provider id (what `/api` lists); any other name
turns it into a hand-declared route that needs `api`, `baseURL` and `models`. And the patch must not
write a `models:` list for it: that list *replaces* the catalog instead of narrowing it.

### One resolver, one precedence

Before this change five places computed "the active route" separately, and they disagreed as soon as
anything but the config chose it. `effectiveRoute(cfg)` is now the only answer, used by the patch,
the run loop, `/doctor`, `/model` and the prompt status line:

1. an explicit `/api use` or `/model` choice (state) — **bound to the route it was made for**, so a
   local model id is never sent to a hosted provider;
2. the active persona's `model` (its `route`, or the local route if it names none);
3. `activeRoute` in the config;
4. the local route.

### The run loop re-resolves every turn

`/api use` mid-session takes effect on the next task: each turn re-reads the route, checks the key
(refusing with the exact `.env` line to add), and brings a local model up once per process.

### Environment access (`/access`)

An API model gets the same tools as the local one — `pwsh`/`bash`, `read`/`write`/`edit`, `glob`,
`grep`, `web_fetch`, `web_search`, subagents, jobs. The substrate confines them through its sandbox,
chosen by `DSH_PERMISSION_MODE`; `/access` only sets that variable for the runs it launches.

| Mode | Effect | Approval |
|---|---|---|
| `read-only` | reads anywhere, writes nothing | escalation **refused** |
| `workspace` (default) | writes under the working directory and temp | escalation **refused** |
| `full --yes` | unconfined, anything your account can do | never asked |

"Refused" is deliberate substrate behaviour: in this headless surface no approval answerer exists,
so an escalation fails closed rather than hanging. On Windows the sandbox restricts **writes only**;
reads and network stay open in every mode (`packages/sandbox/sandbox-windows-acl`, "partial
enforcement").

## Verified on this machine (2026-09-26)

| Check | Result |
|---|---|
| `/api use <provider> <bad-model>` | refused, with the catalog hint |
| `/api use <provider> <model>` | state + patch written; `dsh --dump-config` composes `agent-default-model` on that route |
| task with the key unset | launcher refuses before the substrate runs, naming the variable and the `.env` line |
| task with a deliberately invalid key | request reached the provider: `AUTH: 401 authentication_error` |
| `/models add <org/repo>:<missing quant>` | refused, listing the quants the repo publishes |
| `/models add <hugging face URL>` | quant chosen from the repo's files, pulled, warmed, registered |
| `/models add <registry-name> --use`, then a task | the turn ran on the new model (previously `UNKNOWN_MODEL`) |
| `/access read-only` / `workspace` | session log records `sandbox/mode` accordingly; a write under read-only was denied |

**Not verified**: a successful API turn, and an API model completing a tool call — no provider key
exists on this machine. The 0.6B local model *did* emit a `pwsh` call but omitted a required
argument (`missing required property "description"`), which is a model-capability failure, not a
wiring one, and precisely why a stronger hosted model is the route to real environment access.
First thing to do with a key: T-357.

## Limits, stated plainly

- Cost: VerNess reports provider-reported tokens (`/usage`, `/cost`) and never estimates dollars.
- The catalog is whatever adapter version the profile installed; a newer model id appears after the
  substrate pin moves (ADR-0002). Until then an `extraRoutes` entry can declare it by hand.
- A conversation that switches provider mid-session keeps its history, but provider-specific replay
  state (signatures, native response ids) degrades to neutral content — the adapter's documented
  behaviour.
- `/models add` needs the engine; it starts it if needed, but only the engine VerNess started is
  stopped by `/down`.
