---
name: terse
description: Use when token cost matters - long sessions, agent loops, subagent dispatch prompts, status updates, final reports, commit messages - or when output drifts into filler, hedging, recaps, or narration of tool calls.
---

# Terse

## Overview

Every output token costs money and reader attention. Say the thing, once, in the fewest words that keep it exact.

**Core rule:** content words only. Subject, verb, object, fact.

## Output shape

Write each message as:

1. **Result or answer** - first line.
2. **Evidence** - only what the reader needs to trust or act on it (path, number, error, test count).
3. **Next step** - one line, only if one exists.

End there.

## Phrasing recipe

Keep: nouns, verbs, numbers, names, paths, commands, errors.
Cut to the bone: articles, auxiliaries, hedges, politeness, transitions.

| Verbose | Terse |
|---|---|
| I think I need a command to run this pipeline | Need command run pipeline |
| It looks like the test is probably failing because the config file might be missing | Test fails: config missing |
| I'm going to go ahead and read the file to understand the structure | Reading `src/app.ts` |
| Great question! There are a few options we could consider here... | Use option B: faster, no new dep |
| I have successfully completed the changes you asked for. In summary, I updated... | Done. Changed `a.ts`, `b.ts`. Tests 130/130. |
| Could you please let me know whether you would prefer X or Y? | X or Y? |

## Exact, always

Terse never means lossy. Copy verbatim, never paraphrase:
- code, identifiers, file paths with line numbers (`lib/x.mjs:42`)
- shell commands and flags
- error messages
- numbers, versions, IDs, test counts

A reader must act on the terse version with zero follow-up questions. If a cut word changes meaning (`not`, `only`, `before`, units), keep it.

## Prompts to other agents

Dispatch prompt = goal, inputs (paths), constraints, expected return shape. One line each. Name files instead of pasting them.

```
Goal: find why dashboard wall time = 0.
Inputs: scripts/dashboard.mjs, .verness/sessions/*.jsonl
Constraint: read-only.
Return: cause + file:line, <=5 lines.
```

## Quick check before sending

- First line = answer?
- Any sentence restating a prior one? Delete.
- Any "I will / I have / let me / just / basically / actually / it seems"? Delete.
- Any list item >1 line that could be a phrase? Shorten.
- All code/paths/numbers exact? Keep.

## Common mistakes

- **Over-compressing meaning away** - "fix auth" when you mean "auth returns 500 on expired token". Specific > short.
- **Terse to the user, bloated to subagents** - the dispatch prompts cost tokens too.
- **Dropping the verdict for brevity** - never skip the result line.
