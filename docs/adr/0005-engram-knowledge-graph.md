# ADR-0005 — Engram (ex-graphifyy) as the token-cost reduction layer

- Status: accepted, adopted with a caveat
- Date: 2026-09-25

## Context
The repo owner asked for `graphifyy` to be installed "so it can be used to reduce inference and API
cost". Two renames have happened since: `graphifyy` (npm 0.10.0) is a forwarding shim to
`@sentropic/graphify` (0.19.0), which is itself a deprecated shim to **`@sentropic/engram`**
(0.19.0, published 2026-09-24, MIT, `github.com/rhanka/engram`). Both shims only re-export and
re-run engram.

## Decision
Install **`@sentropic/engram` directly** (globally, CLI `engram`), not the deprecated shims, and use
it as the corpus/knowledge-graph layer: an assistant queries a compact graph instead of re-reading
raw files, which is where the token savings come from.

The graph is built **code-only (`engram update`), which runs on AST parsing with no LLM call at
all** — zero inference cost. Semantic (doc/image) extraction is opt-in and, when we want it, can run
against our local Ollama route (`engram extract --backend ollama`, `OLLAMA_BASE_URL`), so it stays
free too (ADR-0004).

## Honest caveat (measured, not assumed)
On this repo today the graph is **not yet worth querying**: 14 nodes / 20 edges / 3 communities, and
engram's own report says `Corpus is ~15.673 words - fits in a single context window. You may not
need a graph.` That matches the upstream README's own benchmark table (~1× savings on tiny
corpora). We adopt the tool now because:
1. it costs nothing to keep updated (`engram update`, no LLM), and
2. the payoff arrives exactly where our cost actually is — see next step.

## Next step where the payoff is real
Our expensive corpus is not our own code, it is **`upstream/deepseek-harness` (~13,850 files)**,
which we currently navigate by grep. A code-only graph of it would replace repeated greps with graph
queries. It must be built **outside** the submodule (`engram` writes `.engram/` next to the analyzed
path, and ADR-0002 forbids touching `upstream/`) — `engram clone <url>` builds a graph in its own
location. Tracked as T-102.

## Consequences
- `engram install` writes **user-level** integration, not project-level:
  `~/.claude/skills/engram/SKILL.md` and `~/.claude/CLAUDE.md`. Nothing in this repo was modified by
  it. Uninstall with `engram uninstall`.
- `.engram/` is generated and gitignored for now. When `packages/*` holds real TypeScript we
  revisit committing `graph.json` + `GRAPH_REPORT.md` so a fresh session can query without a rebuild.
- `engram update` emits *instruction files* (`.engram/description-instructions/`,
  `.engram/label-instructions/`) for an assistant to fill in node descriptions and community names.
  Filling them costs session tokens, so we skip it while the corpus is trivially small.
- Keep the graph's freshness in mind: `GRAPH_REPORT.md` records the commit it was built from.
