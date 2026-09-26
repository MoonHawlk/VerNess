#!/usr/bin/env node
/**
 * `/loop-task` — drive one objective to completion over several bounded rounds.
 *
 * Each round is a **separate substrate invocation on one session**, so the accumulated state lives
 * in the durable log rather than inside the small model's context. Between rounds the driver reads
 * that log and decides what happens next; the model is never asked to police itself, because a model
 * that is looping is precisely the one whose self-report cannot be trusted.
 *
 * Four layered defences against the failure this was built for (a small model asking the same thing
 * forever), in increasing cost:
 *  1. a state digest injected every round, naming the tool calls already run;
 *  2. identical-call detection, which escalates from advisory to a hard stop;
 *  3. a no-progress counter over tool *diversity*, not just identical calls;
 *  4. an optional fresh-context verification round before `DONE` is believed.
 * @module scripts/loop-task
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyRound, detectStall, observeSession, renderDigest, roundPrompt } from './lib/loop.mjs'
import { listSessions } from './lib/sessions.mjs'
import { REPO, head, info, ok, paint, step, table, warn } from './lib/util.mjs'

/** Rounds allowed before the driver stops regardless of progress. */
const DEFAULT_MAX_ROUNDS = 8

/**
 * Run one objective to completion, or to a limit.
 *
 * @param {object} ctx - command context (`cfg`, `dsh`, `routeEnv`, `conversation`).
 * @param {string} objective - the objective, restated verbatim every round.
 * @param {{maxRounds?: number, constraints?: string[], verify?: boolean, fresh?: boolean}} [opts] - options.
 * @returns {Promise<{outcome: string, rounds: number, detail: string}>} the result.
 */
export async function runLoopTask(ctx, objective, opts = {}) {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS
  const constraints = opts.constraints ?? []
  const profile = ctx.cfg.profile.name
  const run = ctx.dsh ?? ((a, o) => ctx.sh('dsh', a, o))
  const workspace = REPO.replace(/[\\/:]+/g, '-').replace(/^-+|-+$/g, '')

  // A loop gets its own session unless explicitly told to continue the current conversation: mixing
  // an autonomous run into an interactive one makes both histories harder to reason about.
  let identity = opts.fresh === false ? ctx.conversation?.id() : undefined

  head(`loop-task: ${objective}`)
  info(`at most ${maxRounds} rounds${constraints.length > 0 ? `, ${constraints.length} extra constraint(s)` : ''}`
    + `, verification ${opts.verify === false ? 'off' : 'on'}`)

  const log = []
  const tokens = { input: 0, output: 0 }
  let previous
  let stalls = 0
  let outcome = 'exhausted'
  let detail = `no conclusion after ${maxRounds} rounds`

  for (let round = 1; round <= maxRounds; round++) {
    const state = identity === undefined
      ? { turns: 0, calls: [], answers: [], errors: [] }
      : observeSession(sessionDirFor(identity, workspace))
    const digest = renderDigest(state)
    const prompt = roundPrompt({ objective, digest, round, maxRounds, constraints })

    step(`round ${round}/${maxRounds}`)
    const args = ['--profile', profile, '--json', ...(identity === undefined ? [] : ['--session-id', identity]), prompt]
    const t0 = Date.now()
    const r = run(args, { capture: true, env: ctx.routeEnv })
    const seconds = (Date.now() - t0) / 1000
    const parsed = parseRound(r.out)

    // The stream reports the identity directly, so no directory diffing is needed.
    if (identity === undefined) {
      identity = parsed.sessionId
      if (identity === undefined) { warn('the round produced no session event; stopping'); break }
      info(`session ${identity.replace(/^session-/, '').slice(0, 8)}`)
    }

    const after = observeSession(sessionDirFor(identity, workspace))
    const stall = detectStall(after, previous)
    const verdict = classifyRound(parsed.answer)
    tokens.input += parsed.usage.input
    tokens.output += parsed.usage.output
    log.push({ round, seconds, kind: verdict.kind, newCalls: stall.newCalls, detail: verdict.detail.slice(0, 120) })
    info(`${verdict.kind}${verdict.detail === '' ? '' : `: ${verdict.detail.slice(0, 100)}`}`
      + `  (${stall.newCalls} new tool call(s), ${parsed.usage.output} out tok, ${seconds.toFixed(1)}s)`)

    if (verdict.kind === 'blocked') { outcome = 'blocked'; detail = verdict.detail; break }

    if (verdict.kind === 'done') {
      if (opts.verify === false) { outcome = 'done'; detail = verdict.detail; break }
      const check = await verifyRound(ctx, objective, verdict.detail, run, profile)
      if (check.pass) { outcome = 'done'; detail = verdict.detail; ok(`verified: ${check.detail.slice(0, 120)}`); break }
      warn(`verification rejected the claim: ${check.detail.slice(0, 160)}`)
      if (check.detail !== '') constraints.push(`A previous round claimed completion and an independent check rejected it: ${check.detail.slice(0, 200)}`)
      continue
    }

    // Defences 2 and 3: identical calls, and churning the same tool with varied arguments.
    if (stall.repeated.length > 0) { outcome = 'repeating'; detail = `identical tool call repeated: ${stall.repeated.join(', ')}`; warn(detail); break }
    if (stall.churning.length > 0) warn(`churning: ${stall.churning.join(', ')} - the digest now says so explicitly`)
    // In a task loop, prose is not progress: a round that ran no tool and reached no verdict has
    // moved nothing, however much text it produced. That is the loop this command exists to break.
    if (stall.newCalls === 0) {
      stalls++
      warn(`no tool call this round (${stalls} in a row)`)
      if (stalls >= 2) {
        outcome = 'stalled'
        detail = 'two consecutive rounds ran no tool and reached no verdict - the model is talking, not working'
        break
      }
    } else stalls = 0
    previous = after
  }

  head('loop finished')
  for (const l of table(['round', 'outcome', 'new calls', 'seconds', 'detail'],
    log.map(x => [String(x.round), x.kind, String(x.newCalls), x.seconds.toFixed(1), x.detail]))) console.log(`  ${l}`)
  const colour = outcome === 'done' ? 'green' : outcome === 'blocked' ? 'yellow' : 'red'
  console.log(`  ${paint(colour, outcome)}: ${detail}`)
  info(`${tokens.input} input / ${tokens.output} output tokens across ${log.length} round(s)`)

  recordRun({ objective, outcome, detail, rounds: log.length, identity, tokens, log })
  return { outcome, rounds: log.length, detail, tokens }
}

/**
 * Ask an independent, fresh-context run whether the objective is actually met.
 *
 * Generator is never the evaluator (law 4): this invocation carries no `--session-id`, so it has
 * never seen the work and cannot be convinced by its own earlier reasoning.
 * @param {object} ctx - command context.
 * @param {string} objective - the objective.
 * @param {string} claim - what the working run claimed.
 * @param {(args: string[], opts: object) => {code: number, out: string}} run - the substrate runner.
 * @param {string} profile - the profile name.
 * @returns {Promise<{pass: boolean, detail: string}>} the verdict.
 */
async function verifyRound(ctx, objective, claim, run, profile) {
  const prompt = [
    'You are verifying someone else\'s work. You have not seen how it was done.',
    '',
    `OBJECTIVE: ${objective}`,
    `THEY CLAIM: ${claim}`,
    '',
    'Check the claim yourself with your tools. Do not assume it is true.',
    'Reply with exactly one line: "PASS: <why>" or "NEEDS_WORK: <what is missing>".',
  ].join('\n')
  const r = run(['--profile', profile, '--json', prompt], { capture: true, env: ctx.routeEnv })
  const text = parseRound(r.out).answer
  const pass = /^\s*PASS\b/im.test(text)
  const m = /^\s*(?:PASS|NEEDS_WORK):\s*(.+)$/im.exec(text)
  if (m === null && !pass) {
    // A small model often ignores the reply format. Say so plainly rather than reporting an empty
    // rejection: "the checker did not answer" is a different fact from "the work is wrong".
    return {
      pass: false,
      detail: text.trim() === ''
        ? 'the checker returned nothing'
        : `the checker did not answer in the required format: ${text.slice(0, 140)}`,
    }
  }
  return { pass, detail: m?.[1]?.trim() ?? text.slice(0, 200) }
}

/**
 * @param {string} identity - a session identity.
 * @param {string} workspace - the workspace key.
 * @returns {string} that session's directory.
 */
function sessionDirFor(identity, workspace) {
  const found = listSessions({ workspace, limit: 60 }).find(x => x.identity === identity)
  return found?.dir ?? ''
}

/**
 * Parse the substrate's `--json` event stream.
 *
 * Reading the printed transcript was a mistake: the last visible line is usually reasoning, and a
 * round that merely *mentioned* "DONE:" while thinking out loud was misread. The stream separates
 * them - `final` carries the committed answer, `session` carries the identity, and `status` carries
 * per-step usage - so classification never sees the model's inner monologue.
 * @param {string} out - captured stdout.
 * @returns {{answer: string, sessionId: string|undefined, usage: {input: number, output: number}, reason: string|undefined}} the round.
 */
function parseRound(out) {
  let answer = ''
  let sessionId
  let reason
  const usage = { input: 0, output: 0 }
  for (const line of String(out ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let e
    try { e = JSON.parse(t) } catch { continue }
    if (e.type === 'session') sessionId = e.sessionId
    else if (e.type === 'final') answer = String(e.text ?? '')
    else if (e.type === 'status') {
      if (e.usage !== undefined) {
        usage.input += Number(e.usage.inputTokens ?? 0)
        usage.output += Number(e.usage.outputTokens ?? 0)
      }
      if (e.phase === 'turn_end') reason = e.reason?.kind
    }
  }
  return { answer, sessionId, usage, reason }
}

/** @param {object} record - the run record appended to the loop log. */
function recordRun(record) {
  const dir = join(REPO, '.verness', 'loops')
  mkdirSync(dir, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8')
}

// Standalone CLI: `node scripts/loop-task.mjs "<objective>" [--max-rounds N] [--no-verify]`.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { loadConfigForCli, makeCliContext } = await import('./verness.mjs')
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--max-rounds')
  const objective = argv.filter(a => !a.startsWith('--') && a !== argv[at + 1]).join(' ')
  const ctx = await makeCliContext(loadConfigForCli())
  const res = await runLoopTask(ctx, objective, {
    maxRounds: at >= 0 ? Number(argv[at + 1]) : undefined,
    verify: !argv.includes('--no-verify'),
  })
  process.exit(res.outcome === 'done' ? 0 : 1)
}
