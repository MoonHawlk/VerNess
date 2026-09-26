# WS-A — Launcher, command layer and REPL: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Read
> `2026-09-26-00-master-plan.md` (Global Constraints, Orientation) before Task 1.

**Goal:** Close every open WS-A item in `docs/03-BACKLOG.md`: a real test runner, a registry
conformance test, prefix matching and the `//` escape, `/exit`, `/btw`, `#` briefs, `!` and `@`
input prefixes, `/config`, `/usage --by day`, editor line wrap, persisted history, hygiene hooks,
`stats --watch`, and the macOS/Linux lifecycle check.

**Architecture:** Parsing the REPL input moves out of the loop in `cmdRun()` into a new pure module
`scripts/lib/input.mjs`, so each prefix (`/`, `//`, `!`, `#`, plain task, with `@path` expansion)
can be unit-tested without a terminal. Operator context (`/btw` notes, the `#` brief) lives in
`scripts/lib/notes.mjs` and is prefixed onto the outgoing task by one function, `composeTask()`.
Every new command is one file in `scripts/commands/`.

**Tech stack:** Node ≥ 22.19 ESM, `node:test`, `node:assert/strict`, no dependencies.

**Spec:** `docs/07-COMMAND-LAYER.md` (command shape, `/btw` spec, challenges 1–11),
`docs/research/claude-code-capability-map.md` (what each Claude Code command does).

## Global Constraints
Inherit everything in the master plan. Also:
- `/btw` cap: default **2000** characters, warning at **80%** (1600). Configurable as `notes.maxChars`.
- `#` brief cap: default **4000** characters. Configurable as `notes.briefMaxChars`.
- `@path` expansion: at most **16 KiB per file** and **64 KiB per line**; paths resolve against the
  repo root; a path outside the repo is refused.
- `!<cmd>` runs through the existing `sh()` with `stdio: inherit`, costs zero tokens, and its
  output is **not** sent to the model.

## Design decision recorded here (changes `docs/07-COMMAND-LAYER.md`)
`07-COMMAND-LAYER.md` was written before session continuity existed and says `/btw` notes ride on
**every** turn. Since every REPL turn now continues one substrate session, the model already keeps
a note in its history after it has been sent once. Resending it every turn would duplicate it in
the log and grow the token bill. So: **a note is sent once, on the next task, then marked `sent`.**
It stays visible in `/btw` (as sent) until cleared. `/new` starts a new session, so on the first
task of a new session every note that is not dropped is sent again. The `#` brief works the same
way: it is sent on the first task of every new session. Task 5 updates `07-COMMAND-LAYER.md` to say
this.

## Review Focus
1. A task beginning with a POSIX path (`/usr/bin is missing`) must not be swallowed. `//usr/bin is
   missing` sends `/usr/bin is missing`. Covered in Task 3.
2. An ambiguous prefix (`/d` matches `/decide`, `/decision`, `/dashboard`, `/doctor`) must list the
   candidates and run nothing. Covered in Task 3.
3. `@` inside an e-mail address (`mail me at a@b.com`) must not be treated as a file reference.
   Covered in Task 7: only a token that *starts* with `@` and names an existing file expands.
4. A note written before the session exists (first turn) must survive the session-id capture.
   Covered in Task 5 (`moveNotes`).
5. Every new command prints plain text when piped. Each command task runs it once through `| cat`.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `package.json` | modify | `test` script → `node --test`; drop the dead `typecheck` script |
| `scripts/test/*.test.mjs` | create | one suite per module |
| `scripts/lib/commands.mjs` | modify | `resolveCommand()` with unique-prefix matching |
| `scripts/lib/input.mjs` | create | `classifyInput()`, `expandFileRefs()` (pure) |
| `scripts/lib/notes.mjs` | create | `/btw` notes and the `#` brief: storage, caps, `composeTask()` |
| `scripts/lib/config-view.mjs` | create | `explainConfig()`: flatten config layers with their owning source |
| `scripts/lib/history.mjs` | create | persisted REPL history (`.verness/history.jsonl`) |
| `scripts/commands/exit.mjs` | create | `/exit`, `/quit` |
| `scripts/commands/btw.mjs` | create | `/btw` |
| `scripts/commands/config.mjs` | create | `/config` |
| `scripts/commands/usage.mjs` | modify | `--by day` |
| `scripts/lib/sessions.mjs` | modify | `usageByDay()` |
| `scripts/verness.mjs` | modify | REPL loop uses `classifyInput` + `composeTask`; `makeCtx` gains `configLayers`, `requestExit`; `DEFAULTS.notes` |
| `scripts/lib/prompt.mjs` | modify | wrap long lines (T-302) |
| `scripts/check-clean-clone.mjs` | create | clone to temp dir and boot `help` (T-311) |
| `scripts/hooks/pre-push` | create | calls the check (T-311) |
| `scripts/model.mjs` | modify | `stats --watch`, probe history (T-123) |

---

### Task 1: Make `npm test` real (T-183)

**Files:**
- Modify: `package.json` (`scripts.test`, remove `scripts.typecheck`)
- Rename: `scripts/test/prompt.simulated-tty.mjs` → `scripts/test/prompt.simulated-tty.test.mjs`
- Create: `scripts/test/smoke.test.mjs`

**Interfaces:**
- Produces: `npm test` runs every `scripts/test/*.test.mjs` with Node's built-in runner. Every later task adds a `*.test.mjs` file.

`scripts/test/pet.render.mjs` is **not** renamed here: the pet is being redesigned in the working
tree and that test currently fails. WS-C T-338 updates it and renames it to `pet.render.test.mjs`.

- [ ] **Step 1: Write the smoke test**

```js
// scripts/test/smoke.test.mjs
/**
 * Every launcher module must import cleanly: a syntax error or a missing export in any of them
 * breaks the REPL at boot, and nothing else would catch it before a user does.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { REPO } from '../lib/util.mjs'

for (const dir of ['scripts/lib', 'scripts/commands']) {
  for (const f of readdirSync(join(REPO, dir)).filter(n => n.endsWith('.mjs'))) {
    test(`${dir}/${f} imports`, async () => {
      const mod = await import(pathToFileURL(join(REPO, dir, f)).href)
      assert.ok(mod !== undefined)
    })
  }
}
```

- [ ] **Step 2: Rename the prompt test**

```bash
git mv scripts/test/prompt.simulated-tty.mjs scripts/test/prompt.simulated-tty.test.mjs
```

- [ ] **Step 3: Point `npm test` at the runner**

In `package.json`, replace the two lines

```json
    "typecheck": "tsc -b tsconfig.json",
    "test": "vitest run",
```

with

```json
    "test": "node --test \"scripts/test/*.test.mjs\"",
```

The quotes matter: Node (≥ 21) expands the glob itself, so the same script works in `cmd.exe`,
PowerShell and POSIX shells. WS-F adds `typecheck` back when a `tsconfig.json` exists.

- [ ] **Step 4: Run it**

Run: `npm test`
Expected: `# pass` equal to the number of `.mjs` files in `scripts/lib` + `scripts/commands` + 1 (the prompt test), `# fail 0`.
If a module fails to import, that is a real bug. Fix it before continuing.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/test/
git commit -m "test: run launcher tests with node --test (T-183)"
```

---

### Task 2: Registry conformance test (T-135)

**Files:**
- Create: `scripts/test/commands.registry.test.mjs`

**Interfaces:**
- Consumes: `loadCommands(): Promise<Map<string, Command>>` from `scripts/lib/commands.mjs`.

- [ ] **Step 1: Write the test**

```js
// scripts/test/commands.registry.test.mjs
/**
 * Registry discipline (07-COMMAND-LAYER challenge #1): every command file has the uniform shape,
 * and no two commands claim the same name or alias. A collision silently shadows a command.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { commandsDir, loadCommands } from '../lib/commands.mjs'

const GROUPS = new Set(['core', 'model', 'decisions', 'personas', 'teams', 'telemetry', 'other'])

test('every command has the uniform shape', async () => {
  const cmds = new Set((await loadCommands()).values())
  assert.ok(cmds.size > 0)
  for (const c of cmds) {
    assert.equal(typeof c.name, 'string', 'name')
    assert.match(c.name, /^[a-z][a-z0-9-]*$/, `name "${c.name}" is lowercase kebab`)
    assert.equal(typeof c.summary, 'string', `${c.name}: summary`)
    assert.ok(c.summary.length > 0 && c.summary.length <= 90, `${c.name}: summary 1..90 chars`)
    assert.equal(typeof c.run, 'function', `${c.name}: run`)
    if (c.group !== undefined) assert.ok(GROUPS.has(c.group), `${c.name}: group "${c.group}" is known`)
    if (c.usage !== undefined) assert.ok(c.usage.startsWith(`/${c.name}`), `${c.name}: usage starts with /${c.name}`)
    for (const a of c.aliases ?? []) assert.match(a, /^[a-z?][a-z0-9-]*$|^\?$/, `${c.name}: alias "${a}"`)
  }
})

test('no two commands share a name or alias', async () => {
  const owner = new Map()
  for (const f of readdirSync(commandsDir()).filter(n => n.endsWith('.mjs')).sort()) {
    const mod = await import(pathToFileURL(join(commandsDir(), f)).href)
    const found = [...new Set([mod.default, ...Object.values(mod)])]
      .filter(c => c?.name !== undefined && typeof c?.run === 'function')
    for (const c of found) {
      for (const key of [c.name, ...(c.aliases ?? [])]) {
        const prev = owner.get(key)
        assert.ok(prev === undefined || prev === c, `"${key}" is claimed twice (${f})`)
        owner.set(key, c)
      }
    }
  }
})
```

- [ ] **Step 2: Run it**

Run: `node --test scripts/test/commands.registry.test.mjs`
Expected: PASS. If it FAILS, the failure names a real collision or shape problem. Fix the command
file, not the test.

- [ ] **Step 3: Commit**

```bash
git add scripts/test/commands.registry.test.mjs
git commit -m "test: registry conformance, shape and name collisions (T-135)"
```

---

### Task 3: Input classification, unique-prefix match and the `//` escape (T-182)

**Files:**
- Create: `scripts/lib/input.mjs`
- Modify: `scripts/lib/commands.mjs` (add `resolveCommand`, use it in `runCommand`)
- Modify: `scripts/verness.mjs` (REPL loop in `cmdRun`, and `dispatch`)
- Test: `scripts/test/input.test.mjs`, `scripts/test/commands.resolve.test.mjs`

**Interfaces:**
- Produces:
  - `classifyInput(line: string): {kind: 'empty'|'command'|'task'|'shell'|'brief', text: string}`.
    Later tasks add behaviour for `shell` (Task 7) and `brief` (Task 6); this task already
    classifies them.
  - `resolveCommand(commands: Map<string, Command>, word: string): {cmd?: Command, ambiguous?: string[]}`
  - `runCommand(input, ctx)` now returns `{handled: boolean, code?: number, ambiguous?: string[]}`

- [ ] **Step 1: Write the failing tests**

```js
// scripts/test/input.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyInput } from '../lib/input.mjs'

test('empty and whitespace', () => {
  assert.deepEqual(classifyInput(''), { kind: 'empty', text: '' })
  assert.deepEqual(classifyInput('   '), { kind: 'empty', text: '' })
})
test('a leading slash is a command', () => {
  assert.deepEqual(classifyInput('/model reset'), { kind: 'command', text: '/model reset' })
})
test('a double slash is a literal task that starts with one slash', () => {
  assert.deepEqual(classifyInput('//usr/bin is missing'), { kind: 'task', text: '/usr/bin is missing' })
})
test('bang is a shell command, hash is a brief note', () => {
  assert.deepEqual(classifyInput('!git status'), { kind: 'shell', text: 'git status' })
  assert.deepEqual(classifyInput('# prefer DuckDB'), { kind: 'brief', text: 'prefer DuckDB' })
})
test('anything else is a task, trimmed', () => {
  assert.deepEqual(classifyInput('  count the files  '), { kind: 'task', text: 'count the files' })
})
test('a lone bang or hash is a task, not an empty command', () => {
  assert.deepEqual(classifyInput('!'), { kind: 'task', text: '!' })
  assert.deepEqual(classifyInput('#'), { kind: 'task', text: '#' })
})
```

```js
// scripts/test/commands.resolve.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveCommand } from '../lib/commands.mjs'

const mk = (name, aliases = []) => ({ name, aliases, summary: name, run: () => 0 })
const reg = () => {
  const m = new Map()
  for (const c of [mk('model'), mk('decide'), mk('decision', ['decisions']), mk('doctor'), mk('persona', ['p'])]) {
    m.set(c.name, c)
    for (const a of c.aliases) m.set(a, c)
  }
  return m
}

test('exact name and exact alias win', () => {
  assert.equal(resolveCommand(reg(), 'decide').cmd.name, 'decide')
  assert.equal(resolveCommand(reg(), 'p').cmd.name, 'persona')
})
test('a unique prefix resolves', () => {
  assert.equal(resolveCommand(reg(), 'mo').cmd.name, 'model')
  assert.equal(resolveCommand(reg(), 'doc').cmd.name, 'doctor')
})
test('an ambiguous prefix lists candidates and resolves nothing', () => {
  const r = resolveCommand(reg(), 'dec')
  assert.equal(r.cmd, undefined)
  assert.deepEqual(r.ambiguous, ['decide', 'decision'])
})
test('prefix matching through an alias counts once per command', () => {
  // "decisions" is an alias of "decision": "decisio" must resolve, not be ambiguous with itself.
  assert.equal(resolveCommand(reg(), 'decisio').cmd.name, 'decision')
})
test('unknown is neither', () => {
  assert.deepEqual(resolveCommand(reg(), 'zzz'), {})
})
test('case-insensitive', () => {
  assert.equal(resolveCommand(reg(), 'MODEL').cmd.name, 'model')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test scripts/test/input.test.mjs scripts/test/commands.resolve.test.mjs`
Expected: FAIL (`Cannot find module '../lib/input.mjs'`; `resolveCommand` is not exported).

- [ ] **Step 3: Implement `scripts/lib/input.mjs`**

```js
/**
 * REPL input classification. Pure on purpose: every prefix rule is tested without a terminal.
 *
 * | Input            | kind      | text sent on                      |
 * |------------------|-----------|-----------------------------------|
 * | ``               | empty     | (exits the REPL, as today)        |
 * | `/cmd args`      | command   | the whole line, to the registry   |
 * | `//text`         | task      | `/text`: a task that starts with a slash (a POSIX path) |
 * | `!cmd`           | shell     | `cmd`, run locally, zero tokens   |
 * | `#note`          | brief     | `note`, appended to the brief     |
 * | anything else    | task      | trimmed text, to the model        |
 * @module scripts/lib/input
 */

/**
 * @param {string} line - raw input.
 * @returns {{kind: 'empty'|'command'|'task'|'shell'|'brief', text: string}} what the line is.
 */
export function classifyInput(line) {
  const t = String(line ?? '').trim()
  if (t === '') return { kind: 'empty', text: '' }
  if (t.startsWith('//')) return { kind: 'task', text: t.slice(1) }
  if (t.startsWith('/')) return { kind: 'command', text: t }
  if (t.startsWith('!') && t.length > 1) return { kind: 'shell', text: t.slice(1).trim() }
  if (t.startsWith('#') && t.length > 1) return { kind: 'brief', text: t.slice(1).trim() }
  return { kind: 'task', text: t }
}
```

- [ ] **Step 4: Add `resolveCommand` to `scripts/lib/commands.mjs` and use it**

Add after `loadCommands`:

```js
/**
 * Find the command a typed word means: an exact name or alias first, then a unique prefix of a
 * name or alias. Ambiguity is reported, never guessed (challenge #8).
 * @param {Map<string, object>} commands - the registry (names and aliases as keys).
 * @param {string} word - the typed word, without the slash.
 * @returns {{cmd?: object, ambiguous?: string[]}} the match, the candidates, or neither.
 */
export function resolveCommand(commands, word) {
  const w = String(word).toLowerCase()
  const exact = commands.get(w)
  if (exact !== undefined) return { cmd: exact }
  const hits = new Set()
  for (const [key, cmd] of commands) if (key.startsWith(w)) hits.add(cmd)
  if (hits.size === 1) return { cmd: [...hits][0] }
  if (hits.size > 1) return { ambiguous: [...hits].map(c => c.name).sort() }
  return {}
}
```

Replace the body of `runCommand` after the `words` line with:

```js
  if (words.length === 0) return { handled: false }
  const { cmd, ambiguous } = resolveCommand(ctx.commands, words[0])
  if (cmd === undefined) return { handled: false, ambiguous }
  const code = await cmd.run(ctx, words.slice(1))
  return { handled: true, code: code ?? 0 }
```

Update the JSDoc `@returns` of `runCommand` to `{handled: boolean, code?: number, ambiguous?: string[]}`.

- [ ] **Step 5: Run the unit tests**

Run: `node --test scripts/test/input.test.mjs scripts/test/commands.resolve.test.mjs`
Expected: PASS.

- [ ] **Step 6: Wire the REPL loop in `scripts/verness.mjs`**

Add `import { classifyInput } from './lib/input.mjs'` beside the other `./lib` imports.

In `cmdRun`, replace the block that starts at `const line = answer.trim()` and runs through the
`continue` that ends the slash-command branch with:

```js
    const input = classifyInput(answer)
    if (input.kind === 'empty') break
    history.push(answer.trim())
    if (input.kind === 'command') {
      // Re-read the config: an earlier command may have switched persona or model.
      const ctx = makeCtx(loadConfig(), commands, convo)
      const { handled, ambiguous } = await runCommand(input.text, ctx)
      if (!handled) {
        const typed = input.text.split(/\s+/)[0].replace(/^\//, '').toLowerCase()
        if (ambiguous !== undefined && ambiguous.length > 0) {
          warn(`/${typed} is ambiguous: ${ambiguous.map(n => `/${n}`).join(', ')}`)
        } else {
          const near = [...new Set([...commands.values()].map(c => c.name))]
            .filter(n => n.startsWith(typed.slice(0, 2)) || n.includes(typed))
            .slice(0, 4)
          warn(`no such command: /${typed}${near.length > 0 ? ` - did you mean ${near.map(n => `/${n}`).join(', ')}?` : ''}`)
          if (near.length === 0) info('press tab on an empty slash to list every command, or run /help')
          info('to send a task that starts with a slash, begin it with //')
        }
      }
      continue
    }
    if (input.kind === 'shell' || input.kind === 'brief') {
      warn(`${input.kind === 'shell' ? '!' : '#'} is not wired yet`)
      continue
    }
    const line = input.text
```

Leave the rest of the loop (`shadowRoute`, the `dsh` call) unchanged: it already uses `line`.
Tasks 6 and 7 replace the `not wired yet` stub.

- [ ] **Step 7: Honour `//` on the command line too**

In `dispatch`, the condition `first.startsWith('/')` also catches `//`. Change it to
`(first.startsWith('/') && !first.startsWith('//'))`, and before `cmdRun(cfg, [first, ...rest])`
(the fallthrough that runs a task) strip one slash when the task starts with `//`:

```js
  if (first !== undefined && first.startsWith('//')) { await cmdRun(cfg, [first.slice(1), ...rest]); return }
```

Place that line as the first statement of `dispatch` after `const commands = await loadCommands()`.

- [ ] **Step 8: Manual check**

```bash
printf '/mo\n/dec\n//usr is a path\n' | node scripts/verness.mjs 2>&1 | cat
```

Expected (piped, so no colours): `/mo` prints the model status; `/dec` prints
`/dec is ambiguous: /decide, /decision`; the third line reaches the model as `/usr is a path`
(needs the engine up; with the engine down, the error must mention the task, not a missing command).

- [ ] **Step 9: Run all tests and commit**

```bash
npm test
git add scripts/lib/input.mjs scripts/lib/commands.mjs scripts/verness.mjs scripts/test/input.test.mjs scripts/test/commands.resolve.test.mjs
git commit -m "feat(repl): unique-prefix commands and the // literal escape (T-182)"
```

---

### Task 4: `/exit` (T-148)

**Files:**
- Create: `scripts/commands/exit.mjs`
- Modify: `scripts/verness.mjs` (`makeCtx` adds `requestExit`; the loop checks it)
- Test: `scripts/test/commands.exit.test.mjs`

**Interfaces:**
- Consumes: `resolveCommand` (Task 3).
- Produces: `ctx.requestExit(): void` sets `ctx.exitRequested = true`. The REPL breaks after the command when it is set.

- [ ] **Step 1: Write the failing test**

```js
// scripts/test/commands.exit.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import exit from '../commands/exit.mjs'

test('/exit asks the REPL to stop and succeeds', () => {
  const ctx = { requestExit() { this.exitRequested = true } }
  assert.equal(exit.run(ctx, []), 0)
  assert.equal(ctx.exitRequested, true)
})
test('/exit outside the REPL is harmless', () => {
  assert.equal(exit.run({}, []), 0)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/test/commands.exit.test.mjs` → FAIL (module missing).

- [ ] **Step 3: Implement**

```js
// scripts/commands/exit.mjs
/**
 * `/exit` — leave the REPL. An empty line and ctrl+c already do this; the command exists so that
 * `/help` lists a way out and so muscle memory from other shells works.
 * @module scripts/commands/exit
 */

export default {
  name: 'exit',
  aliases: ['quit'],
  group: 'core',
  summary: 'leave the REPL (an empty line or ctrl+c also works)',
  usage: '/exit',
  /**
   * @param {object} ctx - command context; `requestExit` exists only inside the REPL.
   * @returns {number} exit code.
   */
  run(ctx) {
    ctx.requestExit?.()
    return 0
  },
}
```

In `makeCtx` add to the returned object:

```js
    requestExit() { this.exitRequested = true },
```

In the REPL loop's command branch (Task 3, Step 6), after `runCommand` returns, add:

```js
      if (ctx.exitRequested === true) break
```

- [ ] **Step 4: Run tests, then commit**

```bash
npm test
git add scripts/commands/exit.mjs scripts/verness.mjs scripts/test/commands.exit.test.mjs
git commit -m "feat(commands): /exit and /quit (T-148)"
```

---

### Task 5: `/btw` operator side notes (T-130)

**Files:**
- Create: `scripts/lib/notes.mjs`, `scripts/commands/btw.mjs`
- Modify: `scripts/verness.mjs` (`DEFAULTS.notes`; the REPL composes the task; `/new` clears pending notes)
- Modify: `docs/07-COMMAND-LAYER.md` (the `/btw` section: send-once rule)
- Test: `scripts/test/notes.test.mjs`

**Interfaces:**
- Produces (all take an explicit `dir` so tests use a temp directory; the REPL passes `RUN_DIR`):
  - `notesFile(dir: string, key: string): string` → `<dir>/notes-<key>.json`. `key` is the session identity, or `'new'` before the first turn.
  - `readNotes(dir, key): Note[]` where `Note = {text: string, at: string, sent: boolean}`
  - `addNote(dir, key, text, maxChars): {notes: Note[], total: number, warn: boolean, refused: boolean}`
  - `dropNote(dir, key, index1: number): boolean` (1-based, as printed)
  - `clearNotes(dir, key): void`
  - `moveNotes(dir, from, to): void`
  - `pendingNotes(notes: Note[]): Note[]` (not yet sent)
  - `markSent(dir, key): void`
  - `composeTask(task: string, {notes?: Note[], brief?: string}): string`
- Task 6 adds the brief functions to the same module and reuses `composeTask`.

- [ ] **Step 1: Write the failing tests**

```js
// scripts/test/notes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addNote, clearNotes, composeTask, dropNote, markSent, moveNotes, pendingNotes, readNotes,
} from '../lib/notes.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'verness-notes-'))

test('add, read, drop, clear', () => {
  const d = tmp()
  addNote(d, 's1', 'use the staging db', 2000)
  addNote(d, 's1', 'numbers in EUR', 2000)
  assert.deepEqual(readNotes(d, 's1').map(n => n.text), ['use the staging db', 'numbers in EUR'])
  assert.equal(dropNote(d, 's1', 1), true)
  assert.deepEqual(readNotes(d, 's1').map(n => n.text), ['numbers in EUR'])
  assert.equal(dropNote(d, 's1', 9), false)
  clearNotes(d, 's1')
  assert.deepEqual(readNotes(d, 's1'), [])
})

test('cap: warn at 80%, refuse past 100%', () => {
  const d = tmp()
  const a = addNote(d, 'k', 'x'.repeat(79), 100)
  assert.equal(a.warn, false)
  const b = addNote(d, 'k', 'y', 100) // 80 chars total
  assert.equal(b.warn, true)
  const c = addNote(d, 'k', 'z'.repeat(21), 100) // would be 101
  assert.equal(c.refused, true)
  assert.equal(readNotes(d, 'k').length, 2)
})

test('empty note is refused', () => {
  const d = tmp()
  assert.equal(addNote(d, 'k', '   ', 100).refused, true)
})

test('send once: pending until marked sent', () => {
  const d = tmp()
  addNote(d, 'k', 'a', 100)
  assert.equal(pendingNotes(readNotes(d, 'k')).length, 1)
  markSent(d, 'k')
  assert.equal(pendingNotes(readNotes(d, 'k')).length, 0)
  assert.equal(readNotes(d, 'k').length, 1)
})

test('notes written before the session exists follow it', () => {
  const d = tmp()
  addNote(d, 'new', 'early note', 100)
  moveNotes(d, 'new', 'session-abc')
  assert.deepEqual(readNotes(d, 'new'), [])
  assert.equal(readNotes(d, 'session-abc')[0].text, 'early note')
})

test('composeTask delimits context from the task', () => {
  const out = composeTask('count the files', { notes: [{ text: 'skip node_modules', at: '', sent: false }] })
  assert.equal(out, [
    'Side notes from the operator (context, not tasks):',
    '- skip node_modules',
    '',
    '---',
    '',
    'count the files',
  ].join('\n'))
})

test('composeTask with nothing to add returns the task unchanged', () => {
  assert.equal(composeTask('hi', {}), 'hi')
  assert.equal(composeTask('hi', { notes: [], brief: '' }), 'hi')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/test/notes.test.mjs` → FAIL (module missing).

- [ ] **Step 3: Implement `scripts/lib/notes.mjs`**

```js
/**
 * Operator context that steers a task without being one: `/btw` side notes (per session) and, from
 * T-147, the `#` project brief (durable).
 *
 * A note is sent ONCE, on the next task, then marked `sent`: every REPL turn continues one substrate
 * session, so the model keeps it in its own history. Resending would duplicate it in the log and
 * grow the bill. A new session (`/new`) gets every kept note again on its first task.
 * @module scripts/lib/notes
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** @typedef {{text: string, at: string, sent: boolean}} Note */

/** @param {string} dir - run dir. @param {string} key - session identity or 'new'. @returns {string} the file. */
export const notesFile = (dir, key) => join(dir, `notes-${String(key).replace(/[^\w.-]+/g, '_')}.json`)

/** @param {string} dir - run dir. @param {string} key - session key. @returns {Note[]} the notes. */
export function readNotes(dir, key) {
  try { return JSON.parse(readFileSync(notesFile(dir, key), 'utf8')) } catch { return [] }
}

/** @param {string} dir @param {string} key @param {Note[]} notes */
function writeNotes(dir, key, notes) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(notesFile(dir, key), `${JSON.stringify(notes, null, 2)}\n`, 'utf8')
}

/** @param {Note[]} notes - notes. @returns {number} total characters. */
const total = notes => notes.reduce((n, x) => n + x.text.length, 0)

/**
 * Append a note, refusing past the cap.
 * @param {string} dir - run dir.
 * @param {string} key - session key.
 * @param {string} text - the note.
 * @param {number} maxChars - the cap.
 * @returns {{notes: Note[], total: number, warn: boolean, refused: boolean}} the outcome.
 */
export function addNote(dir, key, text, maxChars) {
  const notes = readNotes(dir, key)
  const t = String(text).trim()
  if (t === '' || total(notes) + t.length > maxChars) {
    return { notes, total: total(notes), warn: total(notes) >= 0.8 * maxChars, refused: true }
  }
  notes.push({ text: t, at: new Date().toISOString(), sent: false })
  writeNotes(dir, key, notes)
  return { notes, total: total(notes), warn: total(notes) >= 0.8 * maxChars, refused: false }
}

/** @param {string} dir @param {string} key @param {number} index1 - 1-based. @returns {boolean} whether one was removed. */
export function dropNote(dir, key, index1) {
  const notes = readNotes(dir, key)
  if (!Number.isInteger(index1) || index1 < 1 || index1 > notes.length) return false
  notes.splice(index1 - 1, 1)
  writeNotes(dir, key, notes)
  return true
}

/** @param {string} dir @param {string} key */
export function clearNotes(dir, key) {
  rmSync(notesFile(dir, key), { force: true })
}

/** Move notes written before the session id was known onto the session. @param {string} dir @param {string} from @param {string} to */
export function moveNotes(dir, from, to) {
  const src = notesFile(dir, from)
  if (!existsSync(src) || from === to) return
  const merged = [...readNotes(dir, to), ...readNotes(dir, from)]
  writeNotes(dir, to, merged)
  rmSync(src, { force: true })
}

/** @param {Note[]} notes @returns {Note[]} notes not yet sent. */
export const pendingNotes = notes => notes.filter(n => n.sent !== true)

/** @param {string} dir @param {string} key */
export function markSent(dir, key) {
  const notes = readNotes(dir, key)
  if (notes.length === 0) return
  writeNotes(dir, key, notes.map(n => ({ ...n, sent: true })))
}

/** Mark every note unsent, so a fresh session receives them again. @param {string} dir @param {string} key */
export function markUnsent(dir, key) {
  const notes = readNotes(dir, key)
  if (notes.length === 0) return
  writeNotes(dir, key, notes.map(n => ({ ...n, sent: false })))
}

/**
 * Prefix operator context onto a task, clearly delimited so the model reads it as context.
 * @param {string} task - the task text.
 * @param {{notes?: Note[], brief?: string}} extra - what to prepend.
 * @returns {string} the composed task.
 */
export function composeTask(task, extra) {
  const blocks = []
  const brief = String(extra.brief ?? '').trim()
  if (brief !== '') blocks.push(['Project brief from the operator (standing context):', brief].join('\n'))
  const notes = extra.notes ?? []
  if (notes.length > 0) blocks.push(['Side notes from the operator (context, not tasks):', ...notes.map(n => `- ${n.text}`)].join('\n'))
  if (blocks.length === 0) return task
  return [...blocks, '', '---', '', task].join('\n').replace(/\n\n\n+/g, '\n\n')
}
```

Note on the last line: two blocks are joined by the single `'\n'` between array items, then the
separator. The regex only collapses accidental triple newlines; the expected string in the test
has exactly one blank line before and after `---`.

- [ ] **Step 4: Run the tests**

Run: `node --test scripts/test/notes.test.mjs` → PASS. If `composeTask delimits…` fails on
whitespace, fix the join so the output equals the test's expected string exactly.

- [ ] **Step 5: The `/btw` command**

```js
// scripts/commands/btw.mjs
/**
 * `/btw` — "by the way": a side note that steers the next task without being one. Sent once, on the
 * next task; kept (marked sent) until cleared. Zero tokens by itself.
 * @module scripts/commands/btw
 */

import { addNote, clearNotes, dropNote, readNotes } from '../lib/notes.mjs'
import { head, info, ok, RUN_DIR, warn } from '../lib/util.mjs'

/** @param {object} ctx - command context. @returns {string} the notes key for this conversation. */
const keyOf = ctx => ctx.conversation?.id() ?? 'new'

export default {
  name: 'btw',
  group: 'core',
  summary: 'side notes for the next task: /btw <note> | clear | drop <n>',
  usage: '/btw [<note> | clear | drop <n>]',
  details: [
    'a note is sent once, on your next task, clearly marked as context rather than a task',
    'notes are kept per conversation; /new sends the kept ones again on its first task',
    'the total is capped (notes.maxChars, default 2000) with a warning at 80%',
  ],
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - the note, or a subcommand.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const key = keyOf(ctx)
    const max = Number(ctx.cfg?.notes?.maxChars ?? 2000)
    if (args.length === 0) {
      const notes = readNotes(RUN_DIR, key)
      head(`side notes (${notes.length})`)
      if (notes.length === 0) info('none - add one with /btw <note>')
      notes.forEach((n, i) => info(`${i + 1}. ${n.text}${n.sent ? '  (sent)' : ''}`))
      return 0
    }
    if (args[0] === 'clear' && args.length === 1) { clearNotes(RUN_DIR, key); ok('notes cleared'); return 0 }
    if (args[0] === 'drop' && args.length === 2) {
      if (dropNote(RUN_DIR, key, Number(args[1]))) { ok(`note ${args[1]} dropped`); return 0 }
      warn(`no note ${args[1]}`); return 1
    }
    const r = addNote(RUN_DIR, key, args.join(' '), max)
    if (r.refused) {
      warn(r.total + args.join(' ').length > max ? `notes are capped at ${max} characters (${r.total} used) - /btw clear or /btw drop <n>` : 'empty note')
      return 1
    }
    ok(`note ${r.notes.length} saved - ${r.total}/${max} characters`)
    if (r.warn) warn('notes are above 80% of their cap')
    return 0
  },
}
```

- [ ] **Step 6: Wire it into the REPL**

In `scripts/verness.mjs`:
1. Add `notes: { maxChars: 2000, briefMaxChars: 4000 }` to `DEFAULTS`.
2. Import: `import { composeTask, markSent, markUnsent, moveNotes, pendingNotes, readNotes } from './lib/notes.mjs'`.
3. In the REPL loop, after `const line = input.text` and after `await shadowRoute(cfg, line)`
   (shadow routing classifies the operator's task, not the notes), replace the `dsh(...)` call with:

```js
    const noteKey = convo.id() ?? 'new'
    const pending = pendingNotes(readNotes(RUN_DIR_LOCAL, noteKey))
    const outgoing = composeTask(line, { notes: pending })
    dsh([...args, ...(prior === undefined ? [] : ['--session-id', prior]), outgoing], { env })
    markSent(RUN_DIR_LOCAL, noteKey)
    if (before !== undefined) {
      convo.capture(before)
      if (convo.id() !== undefined) {
        moveNotes(RUN_DIR_LOCAL, 'new', convo.id())
        info(`session ${shortSession(convo.id())} - following turns continue it`)
      }
    }
```

   and delete the old `dsh(...)` line and the old `if (before !== undefined) { … }` block it replaces.
4. In `scripts/commands/conversation.mjs`, in the `/new` command's `run`, **before** it resets the
   conversation, carry kept notes to the new conversation unsent:

```js
    const old = ctx.conversation.id()
    if (old !== undefined) { moveNotes(RUN_DIR, old, 'new'); markUnsent(RUN_DIR, 'new') }
```

   (import `moveNotes`, `markUnsent` from `../lib/notes.mjs` and `RUN_DIR` from `../lib/util.mjs`).

- [ ] **Step 7: Update the spec**

In `docs/07-COMMAND-LAYER.md`, in the `/btw` section, replace the bullet
"The next dispatched task is prefixed…" with:

```markdown
- A note is sent **once**, prefixed onto the next task as a delimited block
  (`Side notes from the operator (context, not tasks):`), then marked `sent`. Every REPL turn
  continues one substrate session, so the model already has it in history; resending would duplicate
  it. `/new` sends the kept notes again on the new session's first task.
```

Also change the status banner at the top of that file from "design only. Nothing in this document
is implemented." to "partly built: see `docs/03-BACKLOG.md` WS-A for what is open."

- [ ] **Step 8: Manual check**

```bash
printf '/btw use metric units\n/btw\n' | node scripts/verness.mjs | cat
```

Expected: `note 1 saved - 19/2000 characters`, then the list with `1. use metric units`.

- [ ] **Step 9: Tests and commit**

```bash
npm test
git add scripts/lib/notes.mjs scripts/commands/btw.mjs scripts/commands/conversation.mjs scripts/verness.mjs scripts/test/notes.test.mjs docs/07-COMMAND-LAYER.md
git commit -m "feat(commands): /btw side notes, sent once per session (T-130)"
```

---

### Task 6: `#` project brief (T-147)

**Files:**
- Modify: `scripts/lib/notes.mjs` (brief functions)
- Modify: `scripts/verness.mjs` (the `brief` input kind; send the brief on a session's first turn)
- Test: extend `scripts/test/notes.test.mjs`

**Interfaces:**
- Produces: `briefFile(root: string): string` → `<root>/.verness/brief.md`; `readBrief(root): string`;
  `appendBrief(root, text, maxChars): {total: number, refused: boolean}`.
- Consumes: `composeTask` (Task 5).

- [ ] **Step 1: Failing test (append to `notes.test.mjs`)**

```js
import { appendBrief, readBrief } from '../lib/notes.mjs'

test('brief appends lines and is capped', () => {
  const root = tmp()
  assert.equal(readBrief(root), '')
  appendBrief(root, 'prefer DuckDB for local data', 100)
  appendBrief(root, 'amounts are in EUR', 100)
  assert.equal(readBrief(root), '- prefer DuckDB for local data\n- amounts are in EUR')
  assert.equal(appendBrief(root, 'x'.repeat(100), 100).refused, true)
})

test('composeTask puts the brief before the notes', () => {
  const out = composeTask('go', { brief: '- a', notes: [{ text: 'b', at: '', sent: false }] })
  assert.ok(out.indexOf('Project brief') < out.indexOf('Side notes'))
  assert.ok(out.endsWith('---\n\ngo'))
})
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement (append to `notes.mjs`)**

```js
/** @param {string} root - repo root. @returns {string} the brief file. */
export const briefFile = root => join(root, '.verness', 'brief.md')

/** @param {string} root - repo root. @returns {string} the brief, trimmed ('' when none). */
export function readBrief(root) {
  try { return readFileSync(briefFile(root), 'utf8').trim() } catch { return '' }
}

/**
 * Append one line to the durable brief (`#<note>` in the REPL).
 * @param {string} root - repo root.
 * @param {string} text - the line.
 * @param {number} maxChars - cap for the whole brief.
 * @returns {{total: number, refused: boolean}} the outcome.
 */
export function appendBrief(root, text, maxChars) {
  const cur = readBrief(root)
  const next = [cur, `- ${String(text).trim()}`].filter(s => s !== '').join('\n')
  if (String(text).trim() === '' || next.length > maxChars) return { total: cur.length, refused: true }
  mkdirSync(join(root, '.verness'), { recursive: true })
  writeFileSync(briefFile(root), `${next}\n`, 'utf8')
  return { total: next.length, refused: false }
}
```

- [ ] **Step 4: REPL wiring in `scripts/verness.mjs`**

Replace the Task 3 stub for `brief`:

```js
    if (input.kind === 'brief') {
      const max = Number(cfg.notes?.briefMaxChars ?? 4000)
      const r = appendBrief(REPO, input.text, max)
      if (r.refused) warn(`the brief is capped at ${max} characters - edit .verness/brief.md`)
      else ok(`brief updated (${r.total}/${max}) - sent on the first task of every new session`)
      continue
    }
```

and in the task path, include the brief only on a session's first turn:

```js
    const outgoing = composeTask(line, { notes: pending, brief: prior === undefined ? readBrief(REPO) : '' })
```

(import `appendBrief`, `readBrief`).

- [ ] **Step 5: Tests, manual check (`printf '# amounts in EUR\n' | node scripts/verness.mjs | cat`), commit**

```bash
npm test
git add scripts/lib/notes.mjs scripts/verness.mjs scripts/test/notes.test.mjs
git commit -m "feat(repl): # appends to a durable project brief (T-147)"
```

---

### Task 7: `!` shell prefix and `@path` expansion (T-181)

**Files:**
- Modify: `scripts/lib/input.mjs` (`expandFileRefs`)
- Modify: `scripts/verness.mjs` (the `shell` input kind; expand `@` in tasks)
- Test: `scripts/test/input.test.mjs`

**Interfaces:**
- Produces: `expandFileRefs(text: string, opts: {root: string, perFile?: number, perLine?: number}): {text: string, included: string[], missing: string[], refused: string[]}`

- [ ] **Step 1: Failing tests (append to `input.test.mjs`)**

```js
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandFileRefs } from '../lib/input.mjs'

const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'verness-at-'))
  mkdirSync(join(d, 'docs'))
  writeFileSync(join(d, 'docs', 'a.md'), 'hello\n')
  return d
}

test('@path appends the file as a delimited block', () => {
  const r = expandFileRefs('summarise @docs/a.md please', { root: root() })
  assert.deepEqual(r.included, ['docs/a.md'])
  assert.equal(r.text, 'summarise @docs/a.md please\n\n--- file: docs/a.md ---\nhello\n--- end of docs/a.md ---')
})
test('an e-mail address is not a file reference', () => {
  const r = expandFileRefs('mail a@b.com', { root: root() })
  assert.equal(r.text, 'mail a@b.com')
  assert.deepEqual(r.included, [])
})
test('a missing file is reported and left as typed', () => {
  const r = expandFileRefs('see @nope.md', { root: root() })
  assert.deepEqual(r.missing, ['nope.md'])
  assert.equal(r.text, 'see @nope.md')
})
test('a path outside the root is refused', () => {
  const r = expandFileRefs('see @../../etc/passwd', { root: root() })
  assert.deepEqual(r.refused, ['../../etc/passwd'])
})
test('per-file cap truncates with a marker', () => {
  const d = root()
  writeFileSync(join(d, 'big.txt'), 'x'.repeat(50))
  const r = expandFileRefs('@big.txt', { root: d, perFile: 10 })
  assert.match(r.text, /x{10}\n\[truncated: 50 bytes, showing 10\]/)
})
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement (append to `input.mjs`)**

```js
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * Expand `@path` tokens into delimited file blocks appended after the text. Only a whitespace-
 * separated token that STARTS with `@` counts, so `a@b.com` is left alone. Paths resolve against
 * `root` and must stay inside it.
 * @param {string} text - the task text.
 * @param {{root: string, perFile?: number, perLine?: number}} opts - root and byte caps.
 * @returns {{text: string, included: string[], missing: string[], refused: string[]}} the result.
 */
export function expandFileRefs(text, opts) {
  const perFile = opts.perFile ?? 16 * 1024
  const perLine = opts.perLine ?? 64 * 1024
  const included = []
  const missing = []
  const refused = []
  const blocks = []
  let budget = perLine
  for (const m of String(text).matchAll(/(?:^|\s)@([^\s]+)/g)) {
    const ref = m[1].replace(/[,.;:!?)]+$/, '')
    const abs = resolve(opts.root, ref)
    const rel = relative(opts.root, abs)
    if (rel.startsWith('..') || isAbsolute(rel)) { refused.push(ref); continue }
    if (!existsSync(abs) || !statSync(abs).isFile()) { missing.push(ref); continue }
    if (included.includes(ref)) continue
    const buf = readFileSync(abs)
    const take = Math.min(buf.length, perFile, Math.max(0, budget))
    let body = buf.subarray(0, take).toString('utf8').replace(/\n$/, '')
    if (take < buf.length) body += `\n[truncated: ${buf.length} bytes, showing ${take}]`
    budget -= take
    blocks.push(`--- file: ${ref} ---\n${body}\n--- end of ${ref} ---`)
    included.push(ref)
  }
  return { text: blocks.length === 0 ? text : `${text}\n\n${blocks.join('\n\n')}`, included, missing, refused }
}
```

(Merge the new imports with the file header; `input.mjs` had none before.)

- [ ] **Step 4: REPL wiring**

Replace the Task 3 stub for `shell`:

```js
    if (input.kind === 'shell') {
      // Local and free: the output goes to the terminal, never to the model.
      const r = sh(WIN ? 'cmd' : 'sh', WIN ? ['/d', '/s', '/c', input.text] : ['-c', input.text])
      if (r.code !== 0) warn(`exit ${r.code}`)
      continue
    }
```

In the task path, before `composeTask`:

```js
    const ex = expandFileRefs(line, { root: REPO })
    for (const f of ex.included) info(`attached ${f}`)
    for (const f of ex.missing) warn(`@${f}: no such file, sent as typed`)
    for (const f of ex.refused) warn(`@${f}: outside the repo, not attached`)
    const outgoing = composeTask(ex.text, { notes: pending, brief: prior === undefined ? readBrief(REPO) : '' })
```

`shadowRoute(cfg, line)` keeps using the unexpanded `line`.

- [ ] **Step 5: Windows check.** On Windows run `!echo 10%` in the REPL. Expected output `10%`,
not `10%^`. If it prints the caret, run the shell line through `spawnSync(process.env.ComSpec, ['/d','/s','/c', text], {stdio:'inherit', windowsVerbatimArguments: true})` instead of `sh()`.

- [ ] **Step 6: Tests and commit**

```bash
npm test
git add scripts/lib/input.mjs scripts/verness.mjs scripts/test/input.test.mjs
git commit -m "feat(repl): ! runs a local shell command, @path attaches a file (T-181)"
```

---

### Task 8: `/config` (T-180)

**Files:**
- Create: `scripts/lib/config-view.mjs`, `scripts/commands/config.mjs`
- Modify: `scripts/verness.mjs` (`makeCtx` exposes `configLayers`; add `readRawConfig`)
- Test: `scripts/test/config-view.test.mjs`

**Interfaces:**
- Produces: `explainConfig(layers: {defaults: object, file: object, state: object}): {path: string, value: string, source: 'default'|'verness.config.json'|'.verness/state.json'}[]`
- `ctx.configLayers: {defaults, file, state}`; the persona source is printed separately from `loadPersonas(cfg).get(active).source`.

- [ ] **Step 1: Failing test**

```js
// scripts/test/config-view.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { explainConfig } from '../lib/config-view.mjs'

test('each leaf names the layer that set it', () => {
  const rows = explainConfig({
    defaults: { model: { id: 'qwen3:0.6b', maxTokens: 4096 }, pet: { enabled: true } },
    file: { model: { id: 'hf.co/x' } },
    state: { model: 'override-id', persona: 'data-scientist' },
  })
  const by = Object.fromEntries(rows.map(r => [r.path, r]))
  assert.equal(by['model.id'].value, 'hf.co/x')
  assert.equal(by['model.id'].source, 'verness.config.json')
  assert.equal(by['model.maxTokens'].source, 'default')
  assert.equal(by['pet.enabled'].value, 'true')
  assert.equal(by['state.model'].source, '.verness/state.json')
  assert.equal(by['state.persona'].value, 'data-scientist')
})

test('secrets are masked', () => {
  const rows = explainConfig({ defaults: { model: { apiKeyValue: 'sk-123' } }, file: {}, state: {} })
  assert.equal(rows.find(r => r.path === 'model.apiKeyValue').value, '***')
})

test('arrays print as one value', () => {
  const rows = explainConfig({ defaults: { tips: ['a', 'b'] }, file: {}, state: {} })
  assert.equal(rows.find(r => r.path === 'tips').value, '["a","b"]')
})
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement**

```js
// scripts/lib/config-view.mjs
/**
 * Where each configuration value comes from. The config merges shallowly per top-level section
 * (built-in defaults, then `verness.config.json`), and a few values are overridden at run time from
 * `.verness/state.json`. Printing the owner of every value answers "why is it using that?".
 * @module scripts/lib/config-view
 */

const SECRET = /key|token|secret|password/i

/**
 * @param {object} obj - a nested object.
 * @param {string} [prefix] - path so far.
 * @returns {[string, any][]} leaf paths and values (arrays are leaves).
 */
function leaves(obj, prefix = '') {
  const out = []
  for (const [k, v] of Object.entries(obj ?? {})) {
    const p = prefix === '' ? k : `${prefix}.${k}`
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...leaves(v, p))
    else out.push([p, v])
  }
  return out
}

/** @param {string} path @param {any} v @returns {string} a printable value. */
const show = (path, v) => (SECRET.test(path.split('.').pop()) && v !== undefined && v !== '' ? '***'
  : typeof v === 'string' ? v : JSON.stringify(v))

/**
 * @param {{defaults: object, file: object, state: object}} layers - the three layers.
 * @returns {{path: string, value: string, source: string}[]} one row per leaf, sorted by path.
 */
export function explainConfig(layers) {
  const fileLeaves = new Map(leaves(layers.file))
  const rows = new Map()
  for (const [p, v] of leaves(layers.defaults)) rows.set(p, { path: p, value: show(p, v), source: 'default' })
  for (const [p, v] of fileLeaves) rows.set(p, { path: p, value: show(p, v), source: 'verness.config.json' })
  for (const [k, v] of Object.entries(layers.state ?? {})) {
    if (v !== undefined) rows.set(`state.${k}`, { path: `state.${k}`, value: show(k, v), source: '.verness/state.json' })
  }
  return [...rows.values()].sort((a, b) => a.path.localeCompare(b.path))
}
```

Section-level merge note for the implementer: `loadConfig` replaces a section's *keys* shallowly,
so a nested object inside a section (for example `personas.definitions`) comes wholly from the file
when the file sets it. `leaves()` of the file layer reflects that correctly because the file's leaf
wins wherever it exists.

```js
// scripts/commands/config.mjs
/**
 * `/config` — the resolved configuration and the layer that owns each value.
 * @module scripts/commands/config
 */

import { explainConfig } from '../lib/config-view.mjs'
import { activePersonaId, loadPersonas, readState } from '../lib/personas.mjs'
import { head, info, table } from '../lib/util.mjs'

export default {
  name: 'config',
  group: 'core',
  summary: 'resolved configuration, and which file owns each value',
  usage: '/config [<filter>]',
  details: ['filter is a substring of the dotted path, e.g. /config model'],
  /**
   * @param {object} ctx - command context (needs `configLayers`).
   * @param {string[]} args - optional path filter.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const rows = explainConfig({ ...ctx.configLayers, state: readState() })
      .filter(r => args.length === 0 || r.path.includes(args[0]))
    head(`configuration (${rows.length} values)`)
    for (const l of table(['path', 'value', 'from'], rows.map(r => [r.path, r.value.length > 60 ? `${r.value.slice(0, 57)}...` : r.value, r.source]))) console.log(`  ${l}`)
    const id = activePersonaId(ctx.cfg)
    info(`active persona ${id} is defined in ${loadPersonas(ctx.cfg).get(id)?.source ?? '(missing!)'}`)
    return 0
  },
}
```

In `scripts/verness.mjs` add:

```js
/** @returns {object} the config file as written (no defaults), or {} when absent or invalid. */
function readRawConfig() {
  try { return parseJsonc(readFileSync(join(REPO, 'verness.config.json'), 'utf8')) } catch { return {} }
}
```

and in `makeCtx`'s returned object: `configLayers: { defaults: structuredClone(DEFAULTS), file: readRawConfig() },`

- [ ] **Step 4: Tests, `node scripts/verness.mjs config model | cat`, commit**

```bash
npm test
git add scripts/lib/config-view.mjs scripts/commands/config.mjs scripts/verness.mjs scripts/test/config-view.test.mjs
git commit -m "feat(commands): /config shows each value and its owner (T-180)"
```

---

### Task 9: `/usage --by day` (T-137)

**Files:**
- Modify: `scripts/lib/sessions.mjs` (add `usageByDay`), `scripts/commands/usage.mjs`
- Test: `scripts/test/sessions.usage.test.mjs`

**Interfaces:**
- Produces: `usageByDay(sessions: Summary[]): {day: string, route: string, sessions: number, calls: number, inputTokens: number, outputTokens: number}[]`, sorted by day descending then route. `day` is `YYYY-MM-DD` of the session's **last activity** (`s.at`, the log's mtime). A session spanning midnight counts on its last day. Say so in the command's `details`.

- [ ] **Step 1: Failing test**

```js
// scripts/test/sessions.usage.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { usageByDay } from '../lib/sessions.mjs'

const s = (iso, rows) => ({ at: new Date(iso), routes: new Map(rows.map(r => [`${r.provider}/${r.model}`, r])) })
const r = (provider, model, calls, i, o) => ({ provider, model, calls, inputTokens: i, outputTokens: o })

test('groups by day and route, newest day first', () => {
  const out = usageByDay([
    s('2026-09-25T10:00:00Z', [r('ollama-local', 'q', 2, 10, 5)]),
    s('2026-09-26T09:00:00Z', [r('ollama-local', 'q', 1, 1, 1), r('deepseek', 'v4', 3, 100, 50)]),
    s('2026-09-26T11:00:00Z', [r('ollama-local', 'q', 4, 4, 4)]),
  ])
  assert.deepEqual(out.map(x => [x.day, x.route, x.sessions, x.calls, x.inputTokens]), [
    ['2026-09-26', 'deepseek/v4', 1, 3, 100],
    ['2026-09-26', 'ollama-local/q', 2, 5, 5],
    ['2026-09-25', 'ollama-local/q', 1, 2, 10],
  ])
})
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement (in `sessions.mjs`)**

```js
/**
 * Usage per day per route. A session is attributed to the day of its last activity (the log's
 * modification time), so a session spanning midnight counts once, on its last day.
 * @param {object[]} sessions - summaries from {@link listSessions}.
 * @returns {object[]} rows sorted by day (newest first), then route.
 */
export function usageByDay(sessions) {
  const rows = new Map()
  for (const s of sessions) {
    const day = new Date(s.at).toISOString().slice(0, 10)
    for (const [route, r] of s.routes) {
      const k = `${day} ${route}`
      const row = rows.get(k) ?? { day, route, sessions: 0, calls: 0, inputTokens: 0, outputTokens: 0 }
      row.sessions++
      row.calls += r.calls
      row.inputTokens += r.inputTokens
      row.outputTokens += r.outputTokens
      rows.set(k, row)
    }
  }
  return [...rows.values()].sort((a, b) => b.day.localeCompare(a.day) || a.route.localeCompare(b.route))
}
```

- [ ] **Step 4: Command flag.** In `scripts/commands/usage.mjs`: update `usage` to
`'/usage [--all] [--limit N] [--by day]'`, add the detail line
`'--by day: one row per day and route; a session counts on the day of its last activity'`, and in
`run`, right after the sessions are listed, add:

```js
    if (args.includes('--by') && args[args.indexOf('--by') + 1] === 'day') {
      const rows = usageByDay(sessions)
      head(`usage by day (${rows.length} rows)`)
      for (const l of table(['day', 'route', 'sessions', 'calls', 'in', 'out'],
        rows.map(r => [r.day, r.route, r.sessions, r.calls, num(r.inputTokens), num(r.outputTokens)]))) console.log(`  ${l}`)
      return 0
    }
```

Use the variable name the file already uses for the session list (read the file first; it is
62 lines). Import `usageByDay`. Also add `'--by'` and `'day'` to the `usage` entry of
`makeArgsSupplier` in `scripts/verness.mjs`.

- [ ] **Step 5: Tests, `node scripts/verness.mjs usage --by day | cat`, commit**

```bash
npm test
git add scripts/lib/sessions.mjs scripts/commands/usage.mjs scripts/verness.mjs scripts/test/sessions.usage.test.mjs
git commit -m "feat(usage): --by day breakdown (T-137)"
```

---

### Task 10: Wrap long input lines in the editor (T-302)

**Files:**
- Modify: `scripts/lib/prompt.mjs` (the render/erase path inside `readLineWithSuggestions`)
- Test: `scripts/test/prompt.wrap.test.mjs` (simulated TTY, same harness as `prompt.simulated-tty.test.mjs`)

**Interfaces:**
- Produces: exported pure helper `layout(promptWidth: number, buffer: string, cursor: number, columns: number): {rows: number, cursorRow: number, cursorCol: number}`, used by render and erase.

**Why:** today, when `prompt + buffer` is wider than the terminal, the dropdown is suppressed
because `drawnLines` counts one row for the input. The fix is to count the wrapped rows.

- [ ] **Step 1: Failing test for the pure helper**

```js
// scripts/test/prompt.wrap.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { layout } from '../lib/prompt.mjs'

test('fits on one row', () => {
  assert.deepEqual(layout(9, 'hello', 5, 80), { rows: 1, cursorRow: 0, cursorCol: 14 })
})
test('wraps exactly at the edge', () => {
  // 9 + 71 = 80 columns: the cursor sits at the start of row 2 (terminals defer the wrap).
  assert.deepEqual(layout(9, 'x'.repeat(71), 71, 80), { rows: 2, cursorRow: 1, cursorCol: 0 })
})
test('long buffer, cursor in the middle', () => {
  assert.deepEqual(layout(9, 'x'.repeat(200), 100, 80), { rows: 3, cursorRow: 1, cursorCol: 29 })
})
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement and export**

```js
/**
 * Where the input sits once the terminal wraps it.
 * @param {number} promptWidth - visible width of the prompt.
 * @param {string} buffer - the typed text.
 * @param {number} cursor - cursor index in the buffer.
 * @param {number} columns - terminal width.
 * @returns {{rows: number, cursorRow: number, cursorCol: number}} rows used and the cursor position.
 */
export function layout(promptWidth, buffer, cursor, columns) {
  const total = promptWidth + buffer.length
  const at = promptWidth + cursor
  return {
    rows: Math.floor(total / columns) + 1,
    cursorRow: Math.floor(at / columns),
    cursorCol: at % columns,
  }
}
```

- [ ] **Step 4: Use it in render and erase.** Read `readLineWithSuggestions` fully (lines 38–205).
In its `render` function:
  1. Compute `const L = layout(promptPlain.length, buffer, cursor, width())`.
  2. Remove the condition that suppresses the dropdown when the input is wider than the terminal.
  3. After writing the prompt, buffer and ghost, the terminal cursor is at the end of the input. Draw
     the dropdown below the **last** input row, then move the cursor back up by
     `(L.rows - 1 - L.cursorRow) + dropdownRows` rows and to column `L.cursorCol`
     (`\u001b[<n>A` then `\r\u001b[<col>C`, omitting `C` when `col` is 0).
  4. Set `drawnLines` to `L.cursorRow` (rows above the cursor that belong to this drawing), so
     `erase()` moves up exactly that far before clearing with `\u001b[J`.
  5. Ghost text counts toward the last row. If the ghost would wrap, do not draw it (keep the fix small).

- [ ] **Step 5: Simulated-terminal regression.** Add to `prompt.wrap.test.mjs` a test in the style of
`prompt.simulated-tty.test.mjs` with `columns = 40`: type `/` then 45 `x` characters, then `return`,
and assert (a) the resolved line is `'/' + 'x'.repeat(45)`, (b) the captured output contains no
`\u001b[0A`, (c) the number of `\u001b[<n>A` moves never exceeds 3. That harness stubs global
`process.stdout.write`, so run this simulated test **last** in the file and restore
`process.stdout.write` in a `finally`.

- [ ] **Step 6: Manual check** in a real terminal narrowed to ~50 columns: type a 120-character
`/team run analysis-review ...` line. The dropdown stays below the input and backspace across the
wrap redraws cleanly.

- [ ] **Step 7: Commit**

```bash
npm test
git add scripts/lib/prompt.mjs scripts/test/prompt.wrap.test.mjs
git commit -m "fix(repl): long input wraps instead of hiding the dropdown (T-302)"
```

---

### Task 11: Persisted history and task suggestions (T-303)

**Files:**
- Create: `scripts/lib/history.mjs`
- Modify: `scripts/lib/prompt.mjs` (`makeSuggester` gains an optional `recent` supplier), `scripts/verness.mjs`
- Test: `scripts/test/history.test.mjs`

**Interfaces:**
- Produces: `loadHistory(file: string, max?: number): string[]` (oldest first, deduplicated keeping
  the newest), `appendHistory(file, line, max?): void` (keeps the last `max`, default 500),
  `makeSuggester(commands, argsFor, recent?: () => string[])`. When the buffer does not start with
  `/` and has ≥ 3 characters, suggest recent lines that start with it (case-insensitive), newest
  first, at most 6, with `replace: buffer.length` and hint `'recent'`.

Source decision: the backlog says "from the session log". Reading every log on each keystroke is too
slow, and the log also holds composed tasks (notes, briefs, attached files). The REPL's own input
history is the right source: what the operator typed, stored at `.verness/history.jsonl`.

- [ ] **Step 1: Failing tests**

```js
// scripts/test/history.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendHistory, loadHistory } from '../lib/history.mjs'
import { makeSuggester } from '../lib/prompt.mjs'

const file = () => join(mkdtempSync(join(tmpdir(), 'verness-hist-')), 'history.jsonl')

test('append, dedupe (newest wins), cap', () => {
  const f = file()
  for (const l of ['a', 'b', 'a', 'c']) appendHistory(f, l, 3)
  assert.deepEqual(loadHistory(f), ['b', 'a', 'c'])
})
test('missing file is empty history', () => {
  assert.deepEqual(loadHistory(file()), [])
})
test('suggester offers recent tasks for plain text', () => {
  const s = makeSuggester(new Map(), () => ({}), () => ['count the json files', 'count lines', 'deploy'])
  assert.deepEqual(s('cou').map(c => c.value), ['count lines', 'count the json files'])
  assert.deepEqual(s('co'), [])
})
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement**

```js
// scripts/lib/history.mjs
/**
 * The REPL's input history, persisted so Up/Down and task suggestions survive a restart.
 * JSON lines, one string each, oldest first, capped.
 * @module scripts/lib/history
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** @param {string} file @param {number} [max] @returns {string[]} history, oldest first. */
export function loadHistory(file, max = 500) {
  let raw = []
  try { raw = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] }
  const seen = new Set()
  const out = []
  for (let i = raw.length - 1; i >= 0; i--) if (!seen.has(raw[i])) { seen.add(raw[i]); out.unshift(raw[i]) }
  return out.slice(-max)
}

/** @param {string} file @param {string} line @param {number} [max] */
export function appendHistory(file, line, max = 500) {
  const next = [...loadHistory(file, max).filter(l => l !== line), line].slice(-max)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${next.map(l => JSON.stringify(l)).join('\n')}\n`, 'utf8')
}
```

In `makeSuggester`, add the third parameter and at the top of the returned function:

```js
    if (!buffer.startsWith('/')) {
      if (recent === undefined || buffer.trim().length < 3) return []
      const b = buffer.toLowerCase()
      return [...recent()].reverse()
        .filter(l => l.toLowerCase().startsWith(b) && l !== buffer)
        .slice(0, 6)
        .map(l => ({ value: l, hint: 'recent', replace: buffer.length }))
    }
```

In `cmdRun`: `const histFile = join(REPO, '.verness', 'history.jsonl')`,
`const history = loadHistory(histFile)`, pass `() => history` as the third argument to
`makeSuggester`, and after `history.push(...)` call `appendHistory(histFile, answer.trim())`.
**Do not** record lines of kind `shell` that contain `password`, `token` or `secret`
(case-insensitive).

- [ ] **Step 4: Tests and commit**

```bash
npm test
git add scripts/lib/history.mjs scripts/lib/prompt.mjs scripts/verness.mjs scripts/test/history.test.mjs
git commit -m "feat(repl): persisted history and recent-task suggestions (T-303)"
```

---

### Task 12: Repo hygiene hooks (T-311, T-312)

**Files:**
- Create: `scripts/check-clean-clone.mjs`, `scripts/hooks/pre-push`
- Modify: `scripts/verness.mjs` (a startup check), `package.json` (`"hooks:install"`), `docs/05-CONVENTIONS.md`
- Test: `scripts/test/tracked-imports.test.mjs`

**Interfaces:**
- Produces: `untrackedImports(root: string): string[]`, exported from `scripts/check-clean-clone.mjs`:
  the relative `./lib/*.mjs` / `../lib/*.mjs` imports of `scripts/*.mjs` and `scripts/commands/*.mjs`
  whose target is not in `git ls-files`.

- [ ] **Step 1: Failing test**

```js
// scripts/test/tracked-imports.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { untrackedImports } from '../check-clean-clone.mjs'
import { REPO } from '../lib/util.mjs'

test('every launcher import is tracked by git', () => {
  assert.deepEqual(untrackedImports(REPO), [])
})
```

- [ ] **Step 2: Implement `scripts/check-clean-clone.mjs`**

```js
#!/usr/bin/env node
/**
 * Two guards against the 2026-09-26 near-miss (an ignored `scripts/lib/` meant a clone could not
 * start while everything worked locally):
 *   untrackedImports(root) - fast, runs at REPL start and in tests
 *   main - clones the repo into a temp dir and boots `help` there (pre-push hook)
 * @module scripts/check-clean-clone
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @param {string} root - repo root. @returns {string[]} imported launcher files git does not track. */
export function untrackedImports(root) {
  const ls = spawnSync('git', ['ls-files', 'scripts'], { cwd: root, encoding: 'utf8' })
  if (ls.status !== 0) return [] // not a git checkout (e.g. an npm tarball): nothing to compare
  const tracked = new Set(ls.stdout.split('\n').filter(Boolean).map(p => p.replaceAll('\\', '/')))
  const missing = new Set()
  for (const dir of ['scripts', 'scripts/commands', 'scripts/lib']) {
    for (const f of readdirSync(join(root, dir)).filter(n => n.endsWith('.mjs'))) {
      const src = readFileSync(join(root, dir, f), 'utf8')
      for (const m of src.matchAll(/from\s+'(\.{1,2}\/[^']+\.mjs)'/g)) {
        const rel = relative(root, resolve(root, dir, m[1])).replaceAll('\\', '/')
        if (!tracked.has(rel)) missing.add(rel)
      }
    }
  }
  return [...missing].sort()
}

/** Clone HEAD into a temp dir and run `help` there. @returns {number} exit code. */
function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const dir = mkdtempSync(join(tmpdir(), 'verness-clone-'))
  try {
    const clone = spawnSync('git', ['clone', '--quiet', '--no-recurse-submodules', root, join(dir, 'r')], { stdio: 'inherit' })
    if (clone.status !== 0) return 1
    const help = spawnSync(process.execPath, ['scripts/verness.mjs', 'help'], { cwd: join(dir, 'r'), encoding: 'utf8' })
    if (help.status !== 0) { console.error(help.stdout + help.stderr); return 1 }
    console.log('clean clone boots')
    return 0
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = main()
```

- [ ] **Step 3: The hook**

```sh
#!/bin/sh
# scripts/hooks/pre-push: refuse to push a commit that a fresh clone cannot start (T-311).
exec node scripts/check-clean-clone.mjs
```

`chmod +x scripts/hooks/pre-push`. Add to `package.json` scripts:
`"hooks:install": "git config core.hooksPath scripts/hooks"`. Add one line to
`docs/05-CONVENTIONS.md` under "Verify from a clean clone": `npm run hooks:install` enables the
pre-push check.

- [ ] **Step 4: Startup warning (T-312).** In `cmdRun`, before loading commands:

```js
  const untracked = untrackedImports(REPO)
  if (untracked.length > 0) warn(`not tracked by git (a clone would not start): ${untracked.join(', ')}`)
```

(import from `./check-clean-clone.mjs`). This costs one `git ls-files` (≈10 ms).

- [ ] **Step 5: Verify and commit**

```bash
npm test && node scripts/check-clean-clone.mjs
git add scripts/check-clean-clone.mjs scripts/hooks/pre-push scripts/verness.mjs package.json docs/05-CONVENTIONS.md scripts/test/tracked-imports.test.mjs
git commit -m "chore: clean-clone pre-push hook and an untracked-import warning (T-311, T-312)"
```

---

### Task 13: `stats --watch` and a probe history (T-123)

**Files:**
- Modify: `scripts/model.mjs` (`modelStats(cfg, opts)`), `scripts/verness.mjs` (pass flags; the `stats` builtin)
- Test: `scripts/test/model.probe-history.test.mjs`

**Interfaces:**
- Produces: `appendProbe(dir: string, record: {at: string, model: string, tokPerSec: number, promptEvalMs: number, loadMs: number}): void`
  → `<dir>/probes.jsonl`; `probeTrend(records, n = 10): {last: number, median: number, deltaPct: number}`
  over `tokPerSec`. Both exported from `scripts/model.mjs`.
- `modelStats(cfg, {watch?: number})`: with `watch`, it redraws every `watch` seconds (default 5)
  until ctrl+c, re-reading `/api/ps` only. **The probe (a real generation) runs once, not every
  tick**, because it loads the model.

- [ ] **Step 1: Failing test**

```js
// scripts/test/model.probe-history.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { probeTrend } from '../model.mjs'

test('trend compares the last probe to the median of the previous ones', () => {
  const rs = [50, 60, 55, 58, 30].map(t => ({ tokPerSec: t }))
  assert.deepEqual(probeTrend(rs), { last: 30, median: 56.5, deltaPct: -47 })
})
test('a single probe has no trend', () => {
  assert.deepEqual(probeTrend([{ tokPerSec: 60 }]), { last: 60, median: 60, deltaPct: 0 })
})
```

Importing `scripts/model.mjs` must not run its CLI. Check the bottom of that file: if it runs
`main()` unconditionally, guard it with the same `process.argv[1]` check `verness.mjs` uses before
writing the test.

- [ ] **Step 2: Implement**

```js
/**
 * @param {{tokPerSec: number}[]} records - probes, oldest first.
 * @param {number} [n] - window size.
 * @returns {{last: number, median: number, deltaPct: number}} last value, median of the window before it, and the change in %.
 */
export function probeTrend(records, n = 10) {
  const xs = records.slice(-n - 1).map(r => r.tokPerSec)
  const last = xs.at(-1)
  const prev = xs.length > 1 ? xs.slice(0, -1).sort((a, b) => a - b) : [last]
  const mid = Math.floor(prev.length / 2)
  const median = prev.length % 2 === 0 ? (prev[mid - 1] + prev[mid]) / 2 : prev[mid]
  return { last, median, deltaPct: median === 0 ? 0 : Math.round(((last - median) / median) * 100) }
}

/** @param {string} dir - run dir. @param {object} record - one probe. */
export function appendProbe(dir, record) {
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, 'probes.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
}
```

In `modelStats`, where the probe result is printed today, call `appendProbe(RUN_DIR, {...})`, then
read `probes.jsonl` back and print `trend: <last> tok/s vs median <median> (<deltaPct>%)`,
coloured yellow when `deltaPct <= -20`. For `--watch N`, wrap the `/api/ps` section in a loop that
clears the screen (`\u001b[2J\u001b[H`) only on a TTY, sleeps `N` seconds, and stops on `SIGINT`
(restore the default handler afterwards). Piped (not a TTY), `--watch` prints one block per tick
with a timestamp header and no clearing.

- [ ] **Step 3: Commit**

```bash
npm test
git add scripts/model.mjs scripts/verness.mjs scripts/test/model.probe-history.test.mjs
git commit -m "feat(model): stats --watch and probe history with a trend line (T-123)"
```

---

### Task 14: Verify `up`/`down` on macOS and Linux (T-124)

This is a manual verification task. There is no code unless it finds a bug.

- [ ] **Step 1 (macOS, this machine is darwin):** `./turn_on.sh doctor`, `./turn_on.sh up`,
`./turn_on.sh stats`, `./turn_on.sh down`, `./turn_on.sh stats`. Record the output of each in
`docs/04-PROGRESS.md`: warm time, resident memory, tok/s, and whether `down` released memory (the
second `stats` shows `nothing loaded`).
- [ ] **Step 2:** Repeat with the engine **not** running beforehand (`pkill ollama`), so `up` has to
start it (`startedByUs: true`), then `down` must stop it. Confirm with `pgrep ollama` (empty after
`down`).
- [ ] **Step 3 (Linux):** same two runs in a Linux VM or container with Ollama installed
(`docker run --rm -it -v "$PWD":/w -w /w node:24 bash`, then install Ollama with its install
script). If a step fails, write the failing command and output into `docs/04-PROGRESS.md`, open a
task in `03-BACKLOG.md`, and fix it with a test.
- [ ] **Step 4:** Move T-124 to `03-BACKLOG-DONE.md` with the measured numbers and commit
`docs: verify model lifecycle on macOS and Linux (T-124)`.

---

## Self-review checklist (run after the last task)
- [ ] `npm test` passes; `node scripts/check-clean-clone.mjs` prints `clean clone boots`.
- [ ] `printf '/help\n' | node scripts/verness.mjs | cat` lists `/btw`, `/config`, `/exit`.
- [ ] `docs/07-COMMAND-LAYER.md` no longer claims nothing is implemented.
- [ ] Every WS-A line in `03-BACKLOG.md` is moved to `03-BACKLOG-DONE.md` with evidence.
