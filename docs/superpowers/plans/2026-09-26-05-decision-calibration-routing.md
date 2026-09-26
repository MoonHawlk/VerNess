# WS-E — Decision layer: calibration, gate, routing, first uses: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Read
> `2026-09-26-00-master-plan.md`, `docs/08-DECISION-LAYER-LAYA.md` and
> `docs/09-HANDOFF-DECISION-ROUTING.md` first. Requires WS-A Task 1.

**Goal:** Turn the shadow log into measured evidence (accuracy, ECE, AUROC per question, before and
after temperature refit), encode the T-223 gate as code, and only then let decisions steer, one
question at a time, through a composite (rules → model → escalate) and a capability-based model
router.

**Architecture:** Everything stays in the launcher until WS-G M3 ports it into a plugin:
`scripts/lib/calibration.mjs` (pure metrics + refit), `scripts/lib/routing.mjs` (pure composite and
capability router), a `/decisions` command for labelling and reports, and `/routing` for recent
decisions. The live paths (`shadowRoute` in `scripts/verness.mjs`, the loop verdict) call one
function, `decideRouting()`, which returns the answer that is **applied** plus the shadow record.
Until the gate passes for a question, the applied answer is the rules' answer.

**Tech stack:** Node ESM, `node:test`. The SystemOne sidecar is optional; tests never call it.

**Spec:** `docs/08-DECISION-LAYER-LAYA.md` (provider, limits), `docs/09-HANDOFF-DECISION-ROUTING.md`
(the three questions, shadow mode, confidence bands), ADR-0009, `docs/research/laya-model-digest.md`.

## Global Constraints
Inherit the master plan. Also:
- Gate on `answer_confidence`, never `confidence` (entropy) and never `act_probability` (#185).
- Never ask the decision model for a model id. `tier` is an input to the router (09-HANDOFF §2).
- No question with more than 8 options. No `noul`. No `score` questions.
- Every fan-out bounds concurrency (≤ 4 in flight) and treats `503` as backpressure (already in `askDecision`).
- **Rules have no confidence, so they are scored as always fully confident (1.0).** Their ECE is
  therefore `1 − accuracy`. That makes the gate comparison meaningful: the model must be at least as
  accurate *and* better calibrated than a system that is always sure.
- Nothing is applied for a question until `decisionGate(question).pass === true` **and**
  `decisions.apply.<question> === true` in config. Both are required: the gate is evidence, the
  config flag is the operator's consent.

## Review Focus
1. Labels that disagree with both the model and the rules (a "none of the above" task). The labeller
   offers `skip` and never forces a choice. Task 2.
2. A question whose option set changed after records were logged (someone edits a criteria key).
   Records are keyed by `(question, option-set hash)`, and metrics never mix hashes. Task 1.
3. Too few labels: the report prints `n` and refuses to compute a gate below 50 labelled records per
   question (the gate says `insufficient data`). Task 4.
4. A sidecar that answers with an option not in the criteria (a provider bug). `readAnswer` treats
   it as no answer, and rules apply. Task 1.
5. A refit temperature from a tiny set that makes things worse. Refit only with ≥ 50 labels, and
   keep it only if held-out NLL improves. Task 3.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `scripts/lib/decisions.mjs` | modify | log full probabilities + option-set hash; validate answers; apply temperature |
| `scripts/lib/calibration.mjs` | create | `accuracy`, `ece`, `auroc`, `applyTemperature`, `fitTemperature`, `report`, `decisionGate` |
| `scripts/lib/labels.mjs` | create | shadow records ⋈ labels; the unlabelled queue |
| `scripts/commands/decisions-cmd.mjs` | create | `/decisions label | report | refit | gate` (the file name avoids a clash with `decision.mjs`) |
| `scripts/lib/routing.mjs` | create | `decideRouting` (composite + bands), `routeModel` (capability router) |
| `scripts/commands/routing.mjs` | create | `/routing` |
| `scripts/verness.mjs` | modify | `shadowRoute` → `decideRouting`; route overlay when applied |
| `scripts/commands/cost.mjs` | modify | decision accounting (T-232) |
| `scripts/loop-task.mjs` | modify | shadow the round verdict question (T-231, T-326) |
| `docs/research/decision-calibration.md` | create | published numbers |

---

### Task 1: Log what calibration needs (prerequisite for T-220..T-222)

**Files:** `scripts/lib/decisions.mjs`, `scripts/verness.mjs` (`shadowRoute`), `scripts/commands/decide.mjs`; test `scripts/test/decisions.log.test.mjs`

**Interfaces:**
- `optionHash(question): string`: first 8 hex characters of sha256 over `JSON.stringify(Object.keys(question.criteria).sort())`.
- `readAnswer(body, key, question?)`: when `question` is given and the returned choice is not one of
  its criteria keys, return `{invalid: true}`. It also returns `probabilities`, as it does today.
- Shadow records gain, per question: `probabilities` (the full map), `hash`; and at the top level:
  `id` (a random 12-char id, the label key), `v: 2`.

- [x] **Step 1: Failing tests**

```js
// scripts/test/decisions.log.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ROUTING_QUESTIONS, optionHash, readAnswer } from '../lib/decisions.mjs'

test('option hash is stable and order-independent', () => {
  const a = optionHash({ criteria: { x: '1', y: '2' } })
  assert.equal(a, optionHash({ criteria: { y: 'other text', x: '' } }))
  assert.match(a, /^[0-9a-f]{8}$/)
  assert.notEqual(a, optionHash({ criteria: { x: '', z: '' } }))
})

test('an answer outside the option set is invalid', () => {
  const body = { answers: { level: { choice: 'enormous', answer_confidence: 0.9 } } }
  assert.equal(readAnswer(body, 'level', ROUTING_QUESTIONS.level).invalid, true)
})

test('probabilities are passed through', () => {
  const body = { answers: { tier: { choice: 'frontier', answer_confidence: 0.6, probabilities: { local_small: 0.1, local_large: 0.3, frontier: 0.6 } } } }
  const a = readAnswer(body, 'tier', ROUTING_QUESTIONS.tier)
  assert.equal(a.answer, 'frontier')
  assert.equal(a.probabilities.frontier, 0.6)
})
```

- [x] **Step 2: Implement.** `optionHash` uses `node:crypto` `createHash('sha256')`. In `shadowRoute`
and `/decide`, store `model[k] = { answer, confidence, probabilities, hash: optionHash(ROUTING_QUESTIONS[k]) }`,
and add `id: randomBytes(6).toString('hex')` and `v: 2` to the record. Old `v`-less records stay
readable; Task 2 treats them as having no probabilities.
- [x] **Step 3: Tests, commit** — `feat(decisions): log probabilities and option hashes for calibration`

---

### Task 2: Labelling (T-220 / T-260)

**Files:** create `scripts/lib/labels.mjs`, `scripts/commands/decisions-cmd.mjs`; test `scripts/test/labels.test.mjs`

**Interfaces:**
- `readShadow(dir): Record[]`: every `.verness/decisions/<day>.jsonl` record, skipping bad lines.
  Records without `id` get a derived id `legacy-<at>` so they can still be labelled.
- `readLabels(dir): Map<string, Record<question, string|'skip'>>` from `labels.jsonl`. Later lines win.
- `appendLabel(dir, {id, question, label})`: one JSON line `{id, question, label, at}`.
- `unlabelled(records, labels, question): Record[]`, oldest first.
- `/decisions label [--question level|tier|pipeline] [--limit N]`, interactive (plain readline, no
  raw mode). For each record it prints the task text (≤ 500 chars), the rule answer and the model
  answer **in random order and unmarked** (to avoid anchoring on either), then prompts
  `label [1-5 | s=skip | q=quit]` with the question's options numbered. It writes each label as it
  is entered, so quitting loses nothing. Non-TTY: refuse with `labelling needs a terminal`.

- [x] **Step 1: Failing tests** for `readLabels` (later wins), `unlabelled` (a label for a different
question does not count; `skip` counts as labelled), and `readShadow` (a bad line is skipped,
legacy ids are derived). Use temp dirs as in the other plans.
- [x] **Step 2: Implement** the pure functions and the command. Register the command as
`name: 'decisions-data'`, alias `dd`, group `decisions`, usage
`'/decisions-data label | report | refit | gate'`. The existing `/decision` owns the name
`decisions` as an alias, and the registry test (WS-A Task 2) forbids the clash.
- [x] **Step 3: Commit** — `feat(decisions): /decisions-data label, a blind labelling loop (T-220, T-260)`

**Operator step (not code):** label at least 50 records per question. The handoff recommends ~200.
Record the count and date in `docs/04-PROGRESS.md`. Tasks 3–4 are code that works at any `n`; their
*results* only mean something after this.

---

### Task 3: Metrics and temperature refit (T-221, T-222 / T-261)

**Files:** create `scripts/lib/calibration.mjs`; test `scripts/test/calibration.test.mjs`

**Interfaces (all pure):**
- `accuracy(rows: {pred: string, label: string}[]): number`
- `ece(rows: {conf: number, correct: boolean}[], bins = 10): number`: equal-width bins over [0, 1].
  `ECE = Σ_b (n_b / N) · |acc_b − conf_b|`. Empty bins contribute 0. Returns `NaN` for no rows.
- `auroc(rows: {conf: number, correct: boolean}[]): number|null`: confidence as a score for
  "correct" (Mann–Whitney with ties counting ½); `null` when all rows are correct or all wrong.
- `applyTemperature(probs: Record<string, number>, T: number): Record<string, number>`: `p_i ∝ p_i^(1/T)`,
  renormalised. `T = 1` is the identity. Zero probabilities stay zero.
- `nll(rows: {probs, label}[], T): number`: mean `−log(max(p_label, 1e-12))` after temperature.
- `fitTemperature(rows: {probs, label}[], grid = 0.25..5 step 0.05): {T: number, nllBefore: number, nllAfter: number}`.
  Grid search, deterministic.
- `splitHoldout(rows, fraction = 0.3, seed = 42)`: deterministic split. A seeded LCG; no `Math.random`.
- `report(records, labels): {question, hash, n, model: {accuracy, ece, auroc}, modelRefit?: {...}, rules: {accuracy, ece}, T?: number}[]`.
  One row per `(question, hash)` with at least one label. Rules use `conf = 1`. The refit is fitted on
  the train split and **evaluated on the holdout**. It is included only when `n ≥ 50` and holdout NLL improved.

- [ ] **Step 1: Failing tests with hand-computed values**

```js
// scripts/test/calibration.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { accuracy, applyTemperature, auroc, ece, fitTemperature, nll } from '../lib/calibration.mjs'

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)

test('accuracy', () => {
  assert.equal(accuracy([{ pred: 'a', label: 'a' }, { pred: 'a', label: 'b' }]), 0.5)
})

test('ece: perfectly calibrated is 0, always-sure-and-half-right is 0.5', () => {
  close(ece([{ conf: 0.75, correct: true }, { conf: 0.75, correct: true }, { conf: 0.75, correct: true }, { conf: 0.75, correct: false }]), 0)
  close(ece([{ conf: 1, correct: true }, { conf: 1, correct: false }]), 0.5)
})

test('ece: two bins weighted by size', () => {
  // bin [0.2,0.3): conf 0.25, acc 0 -> gap .25, weight 1/3; bin [0.9,1]: conf .95 acc 1 -> gap .05, weight 2/3
  close(ece([{ conf: 0.25, correct: false }, { conf: 0.95, correct: true }, { conf: 0.95, correct: true }]), 0.25 / 3 + 0.05 * 2 / 3)
})

test('auroc', () => {
  assert.equal(auroc([{ conf: 0.9, correct: true }, { conf: 0.1, correct: false }]), 1)
  assert.equal(auroc([{ conf: 0.1, correct: true }, { conf: 0.9, correct: false }]), 0)
  assert.equal(auroc([{ conf: 0.5, correct: true }, { conf: 0.5, correct: false }]), 0.5)
  assert.equal(auroc([{ conf: 0.5, correct: true }]), null)
})

test('temperature: identity at 1, sharpens below 1, flattens above', () => {
  const p = { a: 0.6, b: 0.4 }
  assert.deepEqual(applyTemperature(p, 1), p)
  assert.ok(applyTemperature(p, 0.5).a > 0.6)
  assert.ok(applyTemperature(p, 2).a < 0.6)
  close(Object.values(applyTemperature(p, 3)).reduce((s, x) => s + x, 0), 1)
})

test('fit: an over-confident model gets T > 1 and lower NLL', () => {
  // Always 0.9 on the predicted option, right only 60% of the time.
  const rows = []
  for (let i = 0; i < 100; i++) rows.push({ probs: { a: 0.9, b: 0.1 }, label: i < 60 ? 'a' : 'b' })
  const f = fitTemperature(rows)
  assert.ok(f.T > 1)
  assert.ok(f.nllAfter < f.nllBefore)
  close(f.nllBefore, nll(rows, 1))
})
```

- [ ] **Step 2: Implement** exactly as the interface states. `ece` bin index is
`Math.min(bins − 1, Math.floor(conf * bins))`. `auroc` is O(P·N), which is fine at our sizes.
- [ ] **Step 3: Wire `report` into `/decisions-data report`.** Print a table per question:
`n | model acc | model ECE | AUROC | refit ECE | T | rules acc | rules ECE`. With `--write`, also write
`docs/research/decision-calibration.md`: date, machine, checkpoint, `n` per question, the table, and
a one-paragraph reading that follows the style of `08-DECISION-LAYER-LAYA.md`.
- [ ] **Step 4: `/decisions-data refit`** writes `.verness/decisions/temperatures.json` =
`{ "<question>:<hash>": {T, n, at} }` for the questions whose refit was kept. Make `readAnswer`
accept an optional `temperatures` map and, when an entry matches, apply it to `probabilities` and
recompute `confidence` as the (new) max probability. `shadowRoute` loads the file once per REPL
start. **Log both the raw and the refit confidence** (`confidenceRaw`, `confidence`).
- [ ] **Step 5: Commit** — `feat(decisions): accuracy, ECE, AUROC and a held-out temperature refit (T-221, T-222, T-261)`

---

### Task 4: The gate, as code (T-223)

**Files:** `scripts/lib/calibration.mjs` (add `decisionGate`), `/decisions-data gate`; test in `calibration.test.mjs`

**Interfaces:**
- `decisionGate(reportRow): {pass: boolean, why: string}`. It passes only if **all** hold:
  `n ≥ 50`; model accuracy (refit if present, otherwise raw) ≥ rules accuracy; model ECE < rules ECE;
  model ECE ≤ 0.15; `auroc ≥ 0.6` (confidence must actually separate right from wrong, or bands are
  meaningless). `why` names the first failing condition, e.g. `ECE 0.31 > 0.15`.
- `latestGate(dir): Record<question, {pass, why, hash}>` recomputes from the current logs and labels.
  It is called at REPL start and cached for the session.

- [ ] **Step 1: Failing tests** (one per condition, plus an all-pass row, plus `n = 49` →
`insufficient data (49 < 50)`).
- [ ] **Step 2: Implement; `/decisions-data gate` prints one line per question: `PASS` or `HOLD — <why>`.**
- [ ] **Step 3: Update `docs/08-DECISION-LAYER-LAYA.md`**: the gate paragraph now points at
`decisionGate` and lists the five conditions and their numbers.
- [ ] **Step 4: Commit** — `feat(decisions): the calibration gate as code (T-223)`

---

### Task 5: Composite decisions with confidence bands (T-204, T-205, T-262)

**Files:** create `scripts/lib/routing.mjs`; modify `scripts/verness.mjs` (`shadowRoute` → uses `decideRouting`), `DEFAULTS.decisions`; test `scripts/test/routing.composite.test.mjs`

**Interfaces:**
- Config (`DEFAULTS.decisions` additions): `apply: { pipeline: false, level: false, tier: false }`,
  `bands: { high: 0.8, low: 0.4 }` (placeholders: Task 3's report tells the operator what to set).
- `decideRouting({text, rules, model, gate, cfg}): {applied: {level, tier, pipeline}, per: Record<q, {source: 'rules'|'model', answer, confidence?, band: 'high'|'middle'|'low'|'none', escalate: boolean}>}`, pure.
  `rules = ruleRoute(text)`, and `model` is the per-question readout (or `undefined` when the sidecar
  is down). Per question:
  - no model answer or invalid → `source: 'rules'`, `band: 'none'`
  - gate not passed or `apply[q]` false → `source: 'rules'` (the model is still recorded)
  - `confidence ≥ high` → `source: 'model'`
  - `low < confidence < high` → `source: 'rules'`, `band: 'middle'`
  - `confidence ≤ low` → `source: 'rules'`, `band: 'low'`, `escalate: true` (logged only; the LLM
    escalation arrives in WS-G M3 `LlmDecisionProvider`)
- **T-205, Jev by construction:** add a test that builds `decisionConfig({ decisions: { baseURL: 'https://jev.example', apiKeyEnv: 'JEV_API_KEY' } })`
  and calls `askDecision` with a stubbed global `fetch`. Assert the URL is `https://jev.example/v1/systemone`
  and the bearer token comes from `JEV_API_KEY`. No new code may be needed. If it is, the abstraction
  is wrong: stop and report.
- Cost accounting: `decideRouting` itself is pure. The caller records the decision `ms` in the
  shadow record (already done), and Task 7 sums it.

- [ ] **Step 1: Failing tests**, one per bullet above, plus: "apply true but gate false → rules",
"rollout order is config-driven only: enabling tier alone applies tier alone".
- [ ] **Step 2: Implement; make `shadowRoute` return `applied`.** In `cmdRun`, keep behaviour
identical while every question uses rules (today). When `applied.tier` came from the model, Task 6's
router uses it.
- [ ] **Step 3: Rollout doc (T-262).** Add a "Turning a question on" section to
`docs/09-HANDOFF-DECISION-ROUTING.md` that lists the exact steps: label → report → refit → gate PASS
→ set `decisions.apply.pipeline: true` → watch `/routing` agreement for a week → next question. The
order `pipeline`, `level`, `tier` comes from the handoff.
- [ ] **Step 4: Commit** — `feat(decisions): composite rules → model with bands, gated per question (T-204, T-205, T-262)`

---

### Task 6: Capability router (T-253) and the `standard` pipeline executor (T-254)

**Files:** `scripts/lib/routing.mjs` (`routeModel`), `scripts/verness.mjs` (overlay when routing
applies), `verness.config.json` is **not** edited; document the new keys in
`docs/06-SETUP-AND-LAUNCHER.md`; test `scripts/test/routing.model.test.mjs`

**Interfaces:**
- Capability vocabulary, identical to WS-F `ModelCapabilities` (keep them in sync; WS-F Task 6 turns
  this into a shared validator): keys `code | reasoning | vision | structured_output | tool_calling`
  with levels `none < low < medium < high`, plus `context: number` (tokens).
- Route config gains `capabilities` (vocabulary above) plus `costPer1M: {input, output}` and
  `latencyMs` (typical first-token). Example to put in the docs:
  `"model": { ..., "capabilities": { "code": "low", "reasoning": "low", "tool_calling": "medium", "structured_output": "low", "context": 32768 }, "costPer1M": { "input": 0, "output": 0 }, "latencyMs": 300 }`.
- Persona `models.requirements` (WS-F T-162) uses the same vocabulary.
- `TIER_FLOOR = { local_small: {}, local_large: { reasoning: 'medium' }, frontier: { reasoning: 'high', code: 'high' } }`
- `routeModel({routes: Record<name, route>, requirements?: object, tier?: string, pin?: string, deny?: string[]}): {route?: string, reason: string, eligible: string[]}`
  1. `pin` set → return it if it exists (`reason: 'pinned'`) even if not eligible, but put
     `'pinned but below requirements: <gaps>'` in `reason`. A pin is an operator decision.
  2. Eligible = routes not in `deny` whose capabilities meet **every** requirement and the tier floor
     (the merge of both; the higher level wins per key; `context` compares numerically).
  3. None eligible → `{route: undefined, reason: 'no route meets <gaps of the closest route>', eligible: []}`.
  4. Tie-break: lowest `costPer1M.input + costPer1M.output`, then lowest `latencyMs`, then name.
- `/routing` shows the last decision's `reason` and eligible list (Task 7).
- Applying it: only when `routing.apply === true` (new config section, default false). `cmdRun` then
  passes a `--patch` overlay that sets `agent-default-model` to the chosen route, built like
  `writePersonaOverlay`. Otherwise the router runs in shadow and its choice is logged next to the
  routing decision as `router: {route, reason}`.
- **T-254:** `executePipeline(pipeline, run)`: `standard` runs today's single `dsh` call. `agent`,
  `decision` and `adaptive` log `pipeline <x> not implemented until M7; ran standard` and run
  standard. Pure dispatch plus that log line; the real executors are WS-G M7.

- [ ] **Step 1: Failing tests:** eligibility per key and level; `context` numeric; the tier floor
merges with the requirements; `deny`; tie-break order; pin below requirements; nothing eligible →
closest gaps; an unknown level string → treated as `none` with a warning in `reason`.
- [ ] **Step 2: Implement; wire it in shadow; commit** — `feat(routing): capability router and the standard pipeline executor (T-253, T-254)`

---

### Task 7: `/routing`, decision accounting in `/cost` (T-255, T-232)

**Files:** create `scripts/commands/routing.mjs`; modify `scripts/commands/cost.mjs`; tests.

- `/routing [--limit N]`: the last N (default 10) shadow records as a table
  `when | task (40 chars) | level r/m | tier r/m | pipeline r/m | applied | router`, then agreement
  per question over the whole log (`model == rules` share, with `n`), then the current gate line per
  question (from `latestGate`).
- `/cost` gains a `decisions` block: calls, total and p50 ms, and **LLM calls avoided**, defined
  conservatively as the number of records where an applied `pipeline` answer of `decision` came from
  the model (a deterministic loop ran instead of a generative turn). Until something is applied, this
  prints `0 (nothing applied yet: shadow mode)`. Never estimate money for the decision model.
- [ ] Tests for the agreement and "avoided" arithmetic (pure helpers in `routing.mjs`), then implement, then commit
  `feat(decisions): /routing and decision accounting in /cost (T-255, T-232)`.

---

### Task 8: Supervisor and loop verdict in shadow (T-231, T-326)

**Files:** `scripts/lib/decisions.mjs` (`VERDICT_QUESTION`), `scripts/loop-task.mjs`

- `VERDICT_QUESTION = { type: 'choice', instructions: 'Given the objective and what the last round did, what should happen next?', criteria: { continue: 'progress was made and the objective is not met yet', retry: 'the round failed for a reason another attempt could fix', complete: 'the objective is met and the evidence shows it', escalate: 'a human decision or missing access is needed' } }`
- In `runLoopTask`, after each round is classified, if decisions are enabled: ask `VERDICT_QUESTION`
  about `objective + digest + last answer (≤ 1500 chars)`, and log with `source: 'loop-verdict'` beside
  the rule verdict (`classifyRound`'s kind mapped: `done → complete`, `blocked → escalate`,
  `progress → continue`, `stall → retry`). **Never act on it** until the gate passes for `verdict`
  and `decisions.apply.verdict === true`. The gate and report already handle any question name.
- [ ] Test the mapping as a pure function; implement; commit
  `feat(loop): shadow the round verdict with the decision model (T-231, T-326)`.

---

### Task 9: Deferred items (T-240, T-241, T-242, T-243). Investigate, then decide

Each one ends in a short dated verdict in `docs/04-PROGRESS.md`, and either new concrete tasks in
the backlog or its removal from it.

- [ ] **T-243 (cheap, do first):** add a fourth routing question `guard: {allow, review, refuse}`
("Is this request safe to run with shell and file tools in a developer's workspace?") to the **same**
call. Shadow only. Measure the added latency (expect ~0: one forward pass). It gets its own gate.
- [ ] **T-240:** add a `laya-mcp` loader row to the profile patch behind `decisions.mcp: false`. Verify by
boot that the 5 tools appear in `/tools`. Document that this gives the *model* a tool; it is not
harness control flow.
- [ ] **T-242:** only after ≥ 500 labels. Follow the model card's fine-tune recipe in the sidecar venv.
Serve the result as a second checkpoint and compare reports. Never replace the base checkpoint in place.
- [ ] **T-241:** check whether `laya-ts` is on npm. If not, record what vendoring it would take (ONNX
runtime size, export steps) and stop. It becomes a WS-G M3 provider only if it removes the Python
sidecar without losing accuracy.
