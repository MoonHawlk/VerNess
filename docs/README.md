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
| [03-BACKLOG.md](03-BACKLOG.md) | The operational task list (checkboxes, stable task IDs) |
| [04-PROGRESS.md](04-PROGRESS.md) | Append-only log: what was done, when, in which commit |
| [05-CONVENTIONS.md](05-CONVENTIONS.md) | Repo/commit/doc/test conventions and how to resume work |
| [06-SETUP-AND-LAUNCHER.md](06-SETUP-AND-LAUNCHER.md) | The setup file and the cross-platform launcher (start here to run it) |
| [RUNBOOK.md](RUNBOOK.md) | Manual commands behind the launcher, and every gotcha we hit |
| [adr/](adr/) | Architecture Decision Records (one file per irreversible choice) |
| [research/](research/) | Read-only digests of upstream repos (source of truth for seam names) |

**How to resume work at any time:** open `03-BACKLOG.md`, pick the first unchecked task of the
current milestone in `02-ROADMAP.md`, and follow `05-CONVENTIONS.md`.
