# 13 — FiNess, explained simply

> For a curious 12-year-old, or anyone who has used a chatbot but never written code.
> Every claim here matches what the code does today. When something is only planned, this page says so.

---

## 1. What is FiNess, in one paragraph

FiNess is an AI helper that runs on your own computer. You type a job, like "list the biggest
files in this folder", and an AI does it. The big idea is to **save effort**. Most jobs do not
need a giant, expensive AI brain. A simple rule, a small quick helper or a plain calculation is
often enough. FiNess wants to try the cheapest way that works first, and only call a big AI when
it has to. **That is the goal, not today's reality.** Today FiNess is a launcher (the place you
type), a set of AI "job hats", lots of free quick-commands, and a small helper called Laya that is
still *practising* how to judge a job. FiNess is built on top of another program, the
**DeepSeek Harness** (people call it `dsh`). The Harness does the heavy lifting: talking to the
AI, running tools, saving conversations. FiNess adds its own pieces on top without changing the
Harness.

```
   you type a job
        |
        v
   +-----------+    free quick-commands (/help, /cost, ...) never touch the AI
   |  FiNess  | -------------------------------------------------------------> answer
   | launcher  |
   +-----------+
        |  a real task
        v
   Laya practises a guess (logged, never used yet)
        |
        v
   +----------------------+
   | DeepSeek Harness     |  talks to the model, runs tools, saves the session
   +----------------------+
        |
        v
      the model (the AI brain) writes the answer
```

---

## 2. The main parts

| Part | What it really is | Think of it as... |
|---|---|---|
| **Launcher / REPL** | The text prompt `finess>` where you type. *REPL* means "Read, Evaluate, Print, Loop": it reads what you type, does it, prints the result, and waits again. Started with `./turn_on.sh` (Mac/Linux) or `.\turn_on.cmd` (Windows). | The front desk of a school. You walk up, say what you need, and get sent to the right place. |
| **The model** | The AI brain that writes answers. It can be **local** (it runs on your computer through a free program called *Ollama*; the default is a small one, Qwen3 0.6B) or **hosted** (a bigger AI on a company's servers, reached over the internet with a secret key). | The student who actually does the homework. A local one is a classmate at your desk; a hosted one is a tutor you phone, and each call costs money. |
| **Personas** | A file in `personas/` that gives the AI a job: data scientist, QA engineer (a tester), HR specialist, and 14 more. Switching persona changes the instructions the AI reads before every task. | A job hat. Same student, but wearing the "tester" hat they think like a tester. |
| **Persona-scoped commands** | Small commands that only appear while one persona is active, like `/testplan` for the QA engineer. They print a checklist or template and cost nothing. | A tool that hangs on one hat. Put on the tester hat and the test-plan checklist appears in your pocket; take it off and it is gone. (It is hidden, not locked: anyone can still open the file.) |
| **Teams** | A file in `teams/` that lists several personas and a list of tasks. Each task runs under its own persona, one after another. The one team today is "analyse then review": one persona makes a table, a different persona checks it. | A group project where one person writes and a different person checks. The writer never grades their own work. |
| **Laya, the decision helper** | A small, fast model that **never writes text**. It only answers multiple-choice questions. For every task you type, it guesses three things: how hard the job is (5 choices, from *trivial* to *research*), how strong a brain it needs (3 choices), and what way to work (4 choices). It runs in **shadow mode**: its guess is saved next to what simple hand-written rules would guess, and **nothing is changed**. Right now neither Laya nor the rules actually pick anything. | A trainee referee who watches the match from the stands and writes down calls in a notebook. Nobody listens to those calls yet. They are for practice. |
| **Labelling and calibration** | You look at old tasks and pick the right answer for each question yourself. You do not see Laya's guess while you pick ("blind"). Then FiNess measures how often Laya was right and how honest its confidence was. *Calibration* means fixing its confidence, so "90% sure" really means right 9 times out of 10. | You are the teacher grading a quiz. Laya gets a report card. |
| **The gate** | A rule: Laya may only start deciding a question once its measured score beats the simple rules. It needs at least 50 graded tasks per question (200 is better). So far 20 are graded. **The gate itself is not built yet.** | A driving test. No licence until you beat the instructor's score, and the test centre is still being built. |
| **Dashboard** | `/dashboard` builds a web page on your computer (no internet needed) showing the to-do list, past sessions, Laya's shadow guesses and team results. | The school noticeboard with the timetable, the homework list and everybody's scores. |
| **The pet (Ness)** | A small text-art face that greets you when you start. It shows versions and which helpers are running. Its mood tells you the health: *happy* (all good), *sleepy* (engine on, no model warmed up), *worried* (something is wrong). | A school mascot that frowns when the lights are off in the gym. |
| **Web UI** | `web` opens a chat window in your browser instead of the terminal. It uses the same model, persona and plugins. It still shows the DeepSeek Harness logo. | The same school, reached through the front door instead of the side door. |

**Two honest notes about job hats.** Each persona file *lists* which tools the AI may use (for
example, the reviewer may not edit files). Those lists are **written down but not enforced yet**:
that arrives in milestone M4. And the commands on each hat are **checklists and templates**, not
magic. They print text; the AI is not involved.

---

## 3. Every functionality

Anything you type that is **not** a command is sent to the model as a task. Commands start with
`/`. Most commands are free: they run inside the launcher and cost zero *tokens* (see the glossary).
Here they are, grouped the way `/help` groups them. Other names that also work (aliases) are in
brackets.

### core: the basics

| Command | What it does, and when you would use it |
|---|---|
| `/help` | Lists every command. Add a name (`/help cost`) for details. Use it when you forget. |
| `/doctor` | Checks what is installed and what is missing. Use it when something will not start. |
| `/new` (`/clear`, `/reset`) | Starts a fresh conversation, so the next task has no memory of the old one. Use it when switching topics. |
| `/resume` (`/continue`) | Picks up an older conversation by the start of its id. Use it to finish yesterday's work. |
| `/loop-task` (`/loop`) | Works on one goal over several rounds until it is done, stuck, repeating itself, or out of rounds. A fresh check confirms "done". Use it for a bigger job that needs several tries. |
| `/pet` (`/ness`, `/status`) | Redraws Ness with fresh checks: versions, running helpers, what needs attention. |
| `/sync` | Rewrites the settings file the Harness reads, from `finess.config.json`. Use it after you edit the config. |
| `/web` (`/ui`) | Opens the browser chat window. It also ends the terminal prompt, because they share the window. |
| `/off` | Turns everything off: web UI, Laya and the local model. Add `--force` to also stop servers FiNess did not start. Use it when you are done for the day. |

### model: the AI brain

| Command | What it does, and when you would use it |
|---|---|
| `/up` | Starts the engine, downloads the model if needed, and warms it up. |
| `/down` | Unloads the model and frees memory. The default model takes about 5 GB of memory while loaded. |
| `/model` | Shows which model is in use, or switches to another one you already have. |
| `/models` | Installs, lists, searches and removes local models from Hugging Face (a big online library of AI models). Example: `/models search qwen3`. |
| `/api` | Switches to a hosted AI company's model (`/api use <provider> <model>`), or back with `/api local`. The secret key goes in a file called `.env`, never on the command line. Nobody has recorded a successful hosted task yet. |
| `/access` | Sets how far the AI's file and shell tools can reach: `read-only` (look, don't touch), `workspace` (the default; change files only in this project folder) or `full --yes` (anything your account can do, with no questions asked). |

### decisions: Laya

| Command | What it does, and when you would use it |
|---|---|
| `/decision` (`/decisions`) | Laya's on/off switch: `up` installs and starts it, `stats` shows its speed and a sample answer, `down` stops it. |
| `/decide <task>` | Asks Laya and the rules about one task and shows both answers side by side, with Laya's confidence. Nothing is applied; the result is logged. Use it to see what Laya is good and bad at. |
| `/decisions-data` (`/dd`) | The grading desk. `status` counts graded tasks against the 50 needed. `label` shows you old tasks one by one so you can pick the right answers. `report` prints Laya's score against the rules. `refit` adjusts Laya's confidence once there are 50+ grades. `gate` says, per question, whether Laya has earned the right to decide (`PASS`) or not yet (`HOLD`, and why). |

### personas: job hats

| Command | What it does, and when you would use it |
|---|---|
| `/persona` (`/p`) | Lists personas grouped by family (data, engineering, business, research), or switches with `/persona qa-engineer`. `/persona check` looks for mistakes in the persona files. |
| `/agents` (`/roster`) | A table of every persona and team, with the active one marked. |

**Commands that come with one job hat.** They show up only while that hat is on. All are free
checklists or templates, with no AI involved.

| Hat | Command | What it gives you |
|---|---|---|
| data-scientist | `/hypotheses <question>` | Steps to turn a vague question into ideas you can actually test. |
| qa-engineer | `/testplan <feature>` | A test-plan checklist: normal use, edge cases, bad input, errors. |
| csharp-developer | `/dotnet-check` | The steps to check a C# (.NET) project builds and passes its tests. It **prints** the steps; it does not run them. |
| devops-engineer | `/release-check` | A checklist for before a release, and for undoing one if it goes wrong. |
| security-engineer | `/threats <part>` | A checklist of ways something could be attacked, plus leaked-password and outdated-package checks. |
| frontend-developer | `/a11y` | A quick accessibility checklist, so people with disabilities can use a web page. |
| hr-specialist | `/jd-check` | A checklist for writing a fair, clear job advert. |
| product-manager | `/prd [title]` | A blank outline for a product plan (a PRD: what to build and why). |
| technical-writer | `/release-notes` | A blank template for "what's new in this version". |
| project-manager | `/raid` | An empty table for Risks, Assumptions, Issues and Dependencies. |
| customer-support | `/triage` | How to sort customer problems by how serious they are, and when to pass them on. |

Five personas have no command of their own yet: data-analyst, data-engineer, software-engineer,
researcher and reviewer. The "generalist" (the plain, no-hat mode) has none either.

### teams

| Command | What it does, and when you would use it |
|---|---|
| `/team` (`/teams`) | Lists teams, shows one, or runs one: `/team run analysis-review`. `--dry-run` shows the plan without running it. The results are saved in `.finess/runs/`. |

### telemetry: looking at what happened

| Command | What it does, and when you would use it |
|---|---|
| `/cost` | Money spent per model route. You write the prices in the config. A local model shows zero, and a route with no price is marked "unpriced" instead of guessed. |
| `/usage` | Work done and tokens used per route. Local models usually do not report tokens, so this can be empty. |
| `/sessions` (`/session`, `/ls`) | Recent conversations: title, number of turns, tools used, size. |
| `/tools` | Which tools the AI was offered in the last conversation. |
| `/stats` | Live engine numbers: memory used, speed in tokens per second, delay. |
| `/dashboard` (`/dash`) | Builds and opens the dashboard page (see section 2). You can give to-do items a priority P0–P3; your browser remembers it. |
| `/graph` | Rebuilds a map of the project's code with a separate tool called Engram, for AI assistants to search. No AI calls. |

### Launcher words: typed after `./turn_on.sh` (or `.\turn_on.cmd` on Windows)

| Word | What it does |
|---|---|
| *(nothing)* | Starts FiNess and opens the `finess>` prompt. |
| `"a task in quotes"` | Runs one task and exits. Add `--continue` to carry on from the last one. |
| `setup` | Installs or repairs everything. Safe to run twice. |
| `doctor` | Same as `/doctor`. |
| `up` / `stats` / `down` | Start the model / show its numbers / stop it. |
| `off` (or `stop`) | Turn everything off. |
| `web` (or `ui`) | Open the browser chat. |
| `sync` | Same as `/sync`. |
| `graph` | Same as `/graph`. |
| `decision up` / `decision stats` / `decision down` | Laya's switch. This works because any single command name can be typed here too, like `models add ...`, `api use ...` or `access workspace`. |
| `help` | The launcher's own help text. |

---

## 4. A day with FiNess

Mia wants to test a new login page.

1. **Start.** She types `.\turn_on.cmd`. Ness pops up looking *happy*: the model is warm and Laya is
   running. The `finess>` prompt appears with the list of commands.
2. **Put on a hat.** `/persona qa-engineer`. The command bar changes: `/testplan` appears, and
   `/hypotheses` (the data scientist's) disappears.
3. **Free checklist first.** `/testplan login page` prints a checklist. No AI, no cost.
4. **Ask the AI.** She types *write test cases for the login form in src/login*. Before the model
   starts, a grey line shows Laya's practice guess next to the rules' guess, something like
   `model simple/local_small/standard vs rules standard/local_large/standard (1/3 agree, logged)`.
   Nothing changes because of it. Then the model reads the files and writes the tests.
5. **Check the cost.** `/cost` says zero, because she is on a local model. `/usage` may show no
   tokens, because local models usually do not report them. That is honest, not broken.
6. **Grade Laya.** `/dd label` shows her today's task and asks "how hard was this really?" She
   picks an answer without seeing Laya's guess. One more graded task toward the 50.
7. **Look at the board.** `/dashboard` opens a page with the to-do list, her session and Laya's
   guesses beside the rules'.
8. **Turn it off.** `/off` stops the web UI (if open), Laya and the model, and frees the memory.

---

## 5. What is not built yet

From `docs/02-ROADMAP.md` and `docs/03-BACKLOG.md`. Milestones M0 to M2 are done; M3 is next.

- **Choosing the cheapest way is still a plan.** Nothing picks a model or a method automatically
  yet. You pick the model with `/model` or `/api`. (The "decision" system is M3, model routing is
  M6, and the SQL/data engines that do big jobs without the AI are M8.)
- **Laya does not decide anything.** It only practises in shadow mode. **The gate** (T-223) now
  checks whether it could, but only reports: it needs at least 50 graded tasks per question first.
- **Tool rules on job hats are written down but not enforced** until M4 (T-042). The reviewer
  "may not edit" today only because its instructions say so.
- **Skills** (step-by-step know-how the AI loads when needed) are M5. **An independent checker**
  that grades every answer is M7. **Budgets and an audit log** are M9.
- **Web UI:** the FiNess logo and name are planned (T-398); today it shows the DeepSeek Harness
  branding. The quick-commands do not appear in the web UI's `/` menu yet (T-374..T-378). After
  switching persona, model or access, you must restart it (`off`, then `web`).
- **Commands that are planned, not built:** `/btw` (side notes for the next task), `/exit`,
  `/config`, `/workspace`, `/api test`, `/team status`, `/task`, `/delegate`, `/permissions`,
  `/goal`, `/todos`, `/export`, plus typing `/mo` as a shortcut for `/model`.
- **Teams** run one task after another (`--parallel` exists, but nobody has measured whether it
  helps on one computer). Team failure rules (stop, skip, retry) are not finished.
- **Ness's animations** (blinking, a drifting "z" when sleepy) are planned.
- **A first real task on a hosted model** has not been recorded yet (T-357).

---

## 6. Tiny glossary

| Word | Meaning |
|---|---|
| **Model** | The AI brain that writes answers. |
| **Local / hosted** | Local runs on your computer, for free. Hosted runs on a company's servers and usually costs money. |
| **Ollama** | The free program that runs local models on your computer. |
| **Prompt** | The text given to the model: your task plus the persona's instructions. |
| **Token** | A small piece of a word. Models read and write in tokens, and hosted ones charge per token. |
| **Persona** | A job hat: instructions (and later, rules) that make the AI act as a certain kind of worker. |
| **Command** | A word starting with `/` that the launcher handles itself, usually for free. |
| **Plugin** | An add-on that plugs into the DeepSeek Harness without changing it, like a new app on a phone. |
| **Harness** | The program underneath FiNess that runs the AI, its tools and its conversations. |
| **Session** | One saved conversation with the AI. |
| **Shadow mode** | Watching and writing down guesses without being allowed to act on them. |
| **Label** | The right answer a human picks for a past task, used to grade Laya. |
| **Calibration** | Making "I'm 90% sure" actually mean right 90% of the time. |
| **Gate** | The test Laya must pass before it may decide anything for real. |
| **Backlog** | The to-do list of planned work (`docs/03-BACKLOG.md`). |
| **Milestone (M0–M9)** | A numbered stage of the project. Each one ends with something working. |
