# VerNess — Documentation Index

VerNess is a model-agnostic, plugin-native AI execution harness. It is **not** a new runtime:
it is a capability layer (personas, skills, decisions, routing, evaluation, governance, data)
built on top of the DeepSeek Harness (`dsh`) / Cordis substrate, using only public plugin seams.

Read in this order:

| Doc | Purpose |
|---|---|
| [00-OVERVIEW.md](00-OVERVIEW.md) | Vision, scope, non-goals, the 5 project laws |
| [01-ARCHITECTURE.md](01-ARCHITECTURE.md) | Layers, contracts, and the exact `dsh` seam each one uses |
| [02-ROADMAP.md](02-ROADMAP.md) | Milestones M0–M9, exit criteria, risks |
| [03-BACKLOG.md](03-BACKLOG.md) | Open work only, grouped by workstream (stable task IDs) |
| [03-BACKLOG-DONE.md](03-BACKLOG-DONE.md) | Archive of completed tasks, with evidence |
| [superpowers/plans/](superpowers/plans/) | **Implementation plans** per workstream; start with `2026-09-26-00-master-plan.md` |
| [04-PROGRESS.md](04-PROGRESS.md) | Append-only log: what was done, when, in which commit |
| [05-CONVENTIONS.md](05-CONVENTIONS.md) | Repo/commit/doc/test conventions and how to resume work |
| [06-SETUP-AND-LAUNCHER.md](06-SETUP-AND-LAUNCHER.md) | The setup file and the cross-platform launcher (start here to run it) |
| [07-COMMAND-LAYER.md](07-COMMAND-LAYER.md) | Command layer, personas-as-files and teams (largely built; open items in the backlog, WS-A/WS-B) |
| [08-DECISION-LAYER-LAYA.md](08-DECISION-LAYER-LAYA.md) | The decision layer: the SystemOne protocol, Laya as first provider, and what it cannot yet be trusted with |
| [09-HANDOFF-DECISION-ROUTING.md](09-HANDOFF-DECISION-ROUTING.md) | **Start here for the next session**: decision-driven routing, the three questions, shadow mode |
| [10-THOUGHT-GRAPH.md](10-THOUGHT-GRAPH.md) | Ephemeral and persistent working memory: node shape, what reaches the prompt, and the poisoning guard |
| [RUNBOOK.md](RUNBOOK.md) | Manual commands behind the launcher, and every gotcha we hit |
| [adr/](adr/) | Architecture Decision Records (one file per irreversible choice) |
| [research/](research/) | Read-only digests of upstream repos (source of truth for seam names) |

**How to resume work at any time:** read `superpowers/plans/2026-09-26-00-master-plan.md` (order and
rules), pick the first open task of a workstream in `03-BACKLOG.md`, open that workstream's plan, and
follow `05-CONVENTIONS.md`. Move finished tasks to `03-BACKLOG-DONE.md`.
