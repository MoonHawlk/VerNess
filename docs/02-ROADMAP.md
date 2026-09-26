# 02 — Roadmap

Each milestone is small, independently verifiable, and ends with the system still runnable.
"Exit criteria" are literal commands/observations, not opinions.

| M | Name | Why now | Status |
|---|---|---|---|
| M0 | Foundation & plan | make the work resumable and the substrate pinned | **done** |
| M1 | Load-bearing spike | prove an out-of-tree plugin loads into `dsh` on Windows | **next** |
| M2 | Contracts | freeze the vocabulary before any behavior | todo |
| M3 | Decisions | the project's core conceptual contribution | todo |
| M4 | Personas | makes the system usable end-to-end | todo |
| M5 | Skills | procedural knowledge, Hermes-style | todo |
| M6 | Routing | capability-based model selection | todo |
| M7 | Evaluation & goal loop | generator ≠ evaluator, long-running tasks | todo |
| M8 | Data plane | volume without passing data through the LLM | todo |
| M9 | Governance | budgets, audit, policy, approvals | todo |

---

## M0 — Foundation & plan
**Deliverables:** docs (this set), ADRs 0001–0003, `.gitignore`, pinned `upstream/deepseek-harness`
submodule, `05-CONVENTIONS.md` working agreement, research digests.
**Exit:** `git submodule status` shows a pinned commit; `docs/03-BACKLOG.md` lists M1 tasks;
nothing inside `upstream/` is modified (`git -C upstream/deepseek-harness status` clean).
**Risk:** upstream `master` ≠ published npm version (source `0.1.7-rc.2`, npm `0.1.5-rc.3`) →
T-006 resolves which tag we pin.

## M1 — Load-bearing spike (most important milestone)
Prove the whole strategy with the least code: one out-of-tree package `@verness/spike` exporting
`name`/`apply`, registering one trivial tool, inserted into a profile patch.
**Deliverables:** `packages/spike/`, `profiles/verness/cordis.patch.yml`, `docs/RUNBOOK.md`
(exact Windows commands: install `dsh`, `DSH_HOME`, profile creation, `--dump-config`, run).
**Exit:** `dsh --profile verness --dump-config` prints our plugin row; the tool is callable in a
session; peer-version gate passes without a `compatibility.json` exemption.
**Risk (highest in the project):** peer-version gate, Windows/pnpm/corepack friction, profile
install path. If this milestone fails, re-evaluate ADR-0002 before writing any subsystem.

## M2 — Contracts (`@verness/contracts`)
Types + schemastery schemas only, zero runtime behavior: `Persona`, `Skill`, `DecisionModel`,
`DecisionRequest/Result`, `ModelCapabilities`, `Task`, `TaskState`, `Evaluator`, `Artifact`,
`Evidence`, `Budget`, `Policy`.
**Exit:** `tsc` clean; schema round-trip unit tests; no dependency on any vendor package.

## M3 — Decisions (`@verness/decisions`)
`ctx.decisions` service + `RuleDecisionProvider` (first) + `LlmDecisionProvider` (wraps `ctx.llm`)
+ `CompositeDecisionModel` (rules → decision model → LLM escalation) + `JevProvider` stub +
tool `decision.evaluate`.
**Exit:** rule-only decisions need no network; composite falls through on low confidence;
HMR-safety test (dispose fiber → registry clean); every result carries
`{decision, confidence, reason_code, provider}`.

## M4 — Personas (`@verness/personas`)
YAML loader + registry + `system-prompt/assemble` contribution + tool allow/deny/approval
enforcement on `tools/pre-execute`. First personas: `data-analyst`, `data-scientist`.
**Exit:** a denied tool is refused with a persona-attributed reason; `approval: human` triggers
one `ctx.approval` prompt; switching persona changes the assembled prompt and the tool set.

## M5 — Skills (`@verness/skills`)
`SKILL.md` + `metadata.yaml` format (3-tier progressive disclosure, per `docs/research/capability-sources-digest.md`),
loader, `ctx.skills.registerProvider` bridge, trigger-based activation, `requires: tools`.
First skills: `statistics`, `sql`, `evidence`.
**Exit:** a matching trigger injects only the skill summary (not the body) until viewed; a skill
whose required tool is denied by the persona is not offered.

## M6 — Routing (`@verness/routing`)
Capability declarations for models, requirement declarations on personas, `ctx.modelRouter`
resolving `requirements → capabilities → eligible → cost/latency/policy → model`, hooked on
`agent/request`.
**Exit:** zero hardcoded `if task == 'coding'`; routing decision is logged with its inputs;
policy can pin a model and the router obeys.

## M7 — Evaluation & goal loop (`@verness/evaluation`, `@verness/supervisor`)
Independent evaluator (fresh-context subagent via `ctx.subagents`, `PASS`/`NEEDS_WORK` contract),
evidence gate, continuation policy plugin on top of existing `ctx.goals`, then the four modes
`standard | agent | decision | adaptive`.
**Exit:** evaluator never shares the generator's context; `max_iterations` and `escalation.after`
respected; a failed evaluation produces retry with a reason_code, not a silent success.

## M8 — Data plane (`@verness/data`)
`ctx.dataEngines` + adapters (DuckDB first, then Postgres/Polars; Spark/warehouses later) +
tools `data.inspect|profile|sample|schema|aggregate`, `sql.query|explain|validate`, long scans via
`ctx.jobs`.
**Exit:** a 10M-row local dataset is profiled and aggregated with no raw rows entering the prompt;
engine choice is made by the planner from size/location/cost, not by the agent.

## M9 — Governance (`@verness/governance`)
RBAC/ABAC hooks, token/cost/time budgets, audit trail as session events, PII policy,
model/tool policy, `ctx.invariants` registrations.
**Exit:** exceeding a budget stops the task with `escalated`, not a crash; the audit log alone
reconstructs who/what/why for a completed task.
