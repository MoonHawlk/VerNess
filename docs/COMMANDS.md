# FiNess — common commands

A cheat sheet: the commands you will use most, grouped by what you want to do, each with a short
example. Everything starting with `/` is a quick-tool: it runs locally and costs no tokens unless
it says otherwise. Anything else you type at `finess>` is a task for the model.

`/help` lists every quick-tool; `/help <name>` explains one. This page covers the common ones; the
full design of each is in [07-COMMAND-LAYER.md](07-COMMAND-LAYER.md).

---

## Contents

- [Start and stop](#start-and-stop)
- [Talking to the model](#talking-to-the-model)
- [Context: files, pages, shell output, notes](#context-files-pages-shell-output-notes)
- [Working on another project](#working-on-another-project)
- [Conversations](#conversations)
- [Models: local and hosted](#models-local-and-hosted)
- [Personas](#personas)
- [Recipes: one-line task templates](#recipes-one-line-task-templates)
- [Delegation, teams and long work](#delegation-teams-and-long-work)
- [Cost, usage and telemetry](#cost-usage-and-telemetry)
- [Decision model (Laya)](#decision-model-laya)
- [Ness, the pet](#ness-the-pet)
- [Configuration and health](#configuration-and-health)
- [From the shell](#from-the-shell)
- [Keys in the prompt](#keys-in-the-prompt)

---

## Start and stop

| Do this | Type |
|---|---|
| Start FiNess (boots the local model) | `finess` · `./turn_on.sh` · `.\turn_on.ps1` · `.\turn_on.cmd` |
| Start without any model (commands only, instant) | `finess --no-model` |
| Open the browser chat instead of the terminal | `/web` · from the shell: `finess web` |
| End the prompt | `/exit`, an empty line, or ctrl+c |
| Turn everything off (web UI, decision sidecar, model) | `/off` |

```text
finess --no-model
finess> /help
finess> /exit
```

## Talking to the model

| Do this | Type |
|---|---|
| Ask anything / give a task | just type it: `summarize README.md in five bullets` |
| See what the next task will carry and how full the context is | `/context` |
| Limit how far the model's shell and file tools reach | `/access read-only` · `/access workspace` (default) · `/access full --yes` |
| See the tools the model was offered | `/tools` |
| See what the last task changed in your files (git workspaces) | `/diff` · `/diff --all` |
| Undo the last task's file changes (shows the plan first) | `/undo` then `/undo --yes` |
| The model's own plan for the current task | `/todos` |

## Context: files, pages, shell output, notes

| Do this | Type |
|---|---|
| Attach a file to a task | `explain @scripts/lib/notes.mjs` |
| Attach a file whose name has spaces | `review @"docs/my notes.md"` |
| Attach a folder listing | `what is in @docs/` |
| Attach a web page (fetched as text) | `summarize @https://example.com/article` |
| Run a shell command locally, nothing sent to the model | `!git status` |
| Run it and attach its output to the next task | `!!git diff` then `write a commit message for this` |
| Add a side note to the next task only | `/btw use metric units` · `/btw` shows · `/btw drop 1` · `/btw clear` |
| Add a line to the project brief every new session gets | `# amounts are in EUR` · `#` shows the brief · `##` sends a line starting with `#` as a task |

Attachments are capped (50,000 characters per item, 150,000 in total; `attach.maxChars` and `attach.maxTotal`) and binary files are refused.
`!` commands are refused under `/access read-only`.

## Working on another project

FiNess can work on any folder, not only this repository.

| Do this | Type |
|---|---|
| Point FiNess at another project | `/workspace C:\code\my-app` · `/workspace ~/code/my-app` |
| Show where tasks run now | `/workspace` (alias `/cwd`) |
| Come back to the FiNess repo | `/workspace reset` |
| Start directly in a project | `finess --workspace C:\code\my-app` |

Tasks, `!` commands and `@` files all resolve in the chosen folder. Switching starts a new
conversation. The brief, `/btw` notes and the dashboard stay with FiNess.

## Conversations

| Do this | Type |
|---|---|
| Start a fresh conversation | `/new` |
| List past conversations | `/sessions` · `/sessions --all` |
| Continue an earlier one | `/resume` (pick) · `/resume 3f9a` (id prefix) |
| Shrink a long conversation into a fresh one (costs one model turn) | `/compact` then `/compact --yes` |
| Save a conversation as Markdown | `/export` · `/export 3f9a --out notes/chat.md` |

## Models: local and hosted

| Do this | Type |
|---|---|
| Start the local engine and warm the model | `/up` |
| Free the model's memory | `/down` |
| Show the model, or switch | `/model` · `/model qwen3:4b` |
| Fall back to another route when the default is down | `"model": { "fallback": [{ "route": "anthropic", "id": "<model>" }] }` in `finess.config.json`; `/model` shows which would run |
| List, search, install, remove local models | `/models` · `/models search qwen coder` · `/models add Qwen/Qwen3-4B-GGUF:Q4_K_M --use` · `/models rm <ref>` |
| Use a hosted API instead | `/api` · `/api models openai` · `/api use anthropic <model>` · `/api local` (back to local) |
| Which key variable a provider needs, and whether it is set (keys go in `.env`) | `/api key anthropic` |
| Check a key and model with a one-token probe (costs a request) | `/api test anthropic --yes` |
| Engine speed and memory | `/stats` · from the shell, live: `node scripts/model.mjs stats --watch` |

`/models add` warns when a model will not fit your free RAM/VRAM and suggests a smaller quant.
`/doctor` and `/model` warn when a model is under 4B parameters (too small for reliable tool calls).

## Personas

A persona is a hat: a role prompt, a tool policy, its own commands and, optionally, its own model.

| Do this | Type |
|---|---|
| List personas, or switch | `/persona` · `/persona qa-engineer` (alias `/p`) |
| Describe one | `/persona show reviewer` |
| Validate every persona file | `/persona check` |
| Every persona and team at a glance | `/agents` |
| The tool policy enforced for the active persona | `/permissions` · `/tools` marks each tool allowed, denied or ask |

Give a persona its own model in its JSON file (for example a reviewer on a stronger model than the
worker): `"model": { "route": "anthropic", "id": "<model>" }`. A `/model` or `/api use` choice in
the session still wins.

Free checklists that come with a persona (no model involved): `/hypotheses` (data scientist) ·
`/testplan` (QA) · `/dotnet-check` (C#) · `/release-check` (DevOps) · `/threats` (security) ·
`/a11y` (frontend) · `/jd-check` (HR) · `/prd` (product) · `/release-notes` (writer) · `/raid`
(project manager) · `/triage` (support).

## Recipes: one-line task templates

| Do this | Type |
|---|---|
| List recipes | `/recipe` |
| Review a file | `/recipe code-review scripts/lib/attach.mjs` · `/recipe code-review src/app.ts focus=security` |
| Write tests for a file | `/recipe write-tests scripts/lib/recipes.mjs` |
| Explain a file or a topic | `/recipe explain how routing works` |
| Summarize a folder of docs | `/recipe summarize-docs docs/` |
| Commit message for your staged changes | `/recipe commit-message` |
| Plan any goal, not only code | `/recipe plan move to a new apartment deadline=December` |

Add your own: drop a `recipes/<name>.md` file with a small front-matter (`name`, `summary`,
optional `persona`, `args`) and a body with `{{arg}}` placeholders.

## Delegation, teams and long work

| Do this | Type |
|---|---|
| Run one task with a chosen persona | `/delegate reviewer check docs/COMMANDS.md for broken examples` |
| Recent delegated and team runs | `/task list` |
| Stop a running delegated, team or loop run (and every process it started) | `/task cancel 3f9a` |
| Teams: list, inspect, run, results | `/team list` · `/team show feature-delivery` · `/team run feature-delivery --dry-run` · `/team status` |
| Work on one goal over several rounds | `/loop-task make every test in scripts/test pass` · `/loop-task --rounds 5 --round-timeout 300 <goal>` |

Teams honour `onFailure: stop | skip | retry-once` per team and per task. A loop stops when the
goal is done or blocked, a round times out (`--round-timeout`, default 600 s), or the model repeats
the same tool call 8 times in a row. When a task, loop or team run takes longer than 30 s,
FiNess rings the bell and updates the terminal title; set `notify.desktop: true` for a desktop
notice.

## Cost, usage and telemetry

| Do this | Type |
|---|---|
| Money per route (needs a `pricing` entry; tokens only otherwise) | `/cost` · `/cost --all` |
| Spending limits: tokens per session or day, cost per day, seconds per task | `/budget` · `/budget allow once` · set `budget` in `finess.config.json` |
| Tokens per route, or per day | `/usage` · `/usage --by day` |
| The HTML dashboard: sessions, tool failures, latency, loops, backlog | `/dashboard` (alias `/dash`) |
| Rebuild the code map (no model calls) | `/graph` |

## Decision model (Laya)

Laya is a small local classifier that guesses how to route a task, whether a loop round is done
and whether a task needs review. It runs in shadow mode: its
guesses are logged and compared, never acted on.

| Do this | Type |
|---|---|
| Start, check or stop it | `/decision up` · `/decision stats` · `/decision down` |
| Laya vs the rules on one task | `/decide add a login page with tests` |
| Recent routing guesses and agreement | `/routing` |
| Which model the capability router would pick, with reasons (advisory only) | `/routing --router` |
| Grade, score and tune Laya | `/dd` · `/dd label` · `/dd report` · `/dd refit` |

## Ness, the pet

| Do this | Type |
|---|---|
| Ness's status: versions, workers, what needs attention | `/pet` (aliases `/ness`, `/status`) |
| Turn the pet off | `"pet": { "enabled": false }` in `finess.config.json`, or `FINESS_NO_PET=1` for one run |
| Keep her still | `"pet": { "animate": false }` |

## Configuration and health

| Do this | Type |
|---|---|
| What is installed and what is missing | `/doctor` |
| Why the local engine will not start (missing models drive, port taken, ...) | `/doctor` (with a fix line) · `.finess/run/engine.log` |
| The resolved configuration and which file owns each value | `/config` · `/config pet` |
| Apply edits to `finess.config.json` | `/sync` |

Settings live in `finess.config.json`; keys go in `.env` (see `.env.example`).

## From the shell

| Do this | Type |
|---|---|
| Link the `finess` command once | `npm link` (in the checkout) |
| First install or repair | `finess setup` · `./turn_on.sh setup` |
| One task, then exit | `finess "list the TODOs in scripts/"` |
| Health check | `finess doctor` |
| Model lifecycle | `finess up` · `finess down` · `npm run model:stats` |
| Browser UI | `finess web` |
| Everything off | `finess off` |
| Any quick-tool, without the prompt | `finess cost` · `finess dashboard --no-open` · `finess pet` |
| Tests | `npm test` · `node scripts/tools/tests.mjs` |

## Keys in the prompt

| Key | Does |
|---|---|
| `/` | opens the command list as you type |
| Up / Down | earlier inputs (kept across runs) or the highlighted suggestion |
| Tab or Right | accept the suggestion |
| Esc | close the suggestions |
| Enter | run |
| ctrl+c, or an empty line | leave the prompt |
