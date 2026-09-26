# teams/

A team is several personas working one task list. Each task runs as its own substrate run wearing
its member's persona, applied as a `--patch` overlay — the shared profile is never mutated, so two
tasks can wear different personas without interfering.

```
/team list            /team show <id>            /team run <id> [--parallel N] [--only a,b] [--dry-run]
```

## Shape

```jsonc
{
  "id": "example",
  "name": "Human-readable name",
  "concurrency": 1,                 // default; --parallel overrides
  "members": [
    { "role": "analyst", "persona": "data-scientist" }   // role -> persona in personas/
  ],
  "tasks": [
    { "id": "gather",  "member": "analyst", "prompt": "..." },
    { "id": "report",  "member": "writer",  "prompt": "...", "dependsOn": ["gather"] }
  ]
}
```

- `member` names a role from `members` (or a persona id directly). Omitted, the task uses the
  active persona.
- `dependsOn` both orders the work and feeds the upstream task's output into the dependent task's
  prompt, under a delimited "context from upstream tasks" block (last 4000 characters).
- Transcripts and a summary table land in `.verness/runs/<team>/<timestamp>/` — gitignored.

## Before you trust a fan-out

`--parallel N` runs up to N independent tasks at once (T-144); dependencies still order the work.
Measure before relying on it: one local model serving several sessions contends for the same
weights, so parallel can be slower than sequential on one machine. Concurrency also has to respect
the decision sidecar's `LAYA_MAX_CONCURRENT` (default 16, excess returns 503) once routing is wired.

Each task is a *fresh* session with no shared history — only what `dependsOn` passes forward. That
is deliberate (it is the Hermes `delegate_task` contract: a subagent gets the goal and its context,
not the parent's transcript), and it is what keeps a team cheap.
