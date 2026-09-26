/**
 * Loop primitives: what has already happened, and whether the agent is going in circles.
 *
 * Everything here is read from the substrate's durable session log — the only honest record of what
 * the agent actually did. Nothing is inferred from what the model claims about itself, because a
 * model that is looping is precisely the one whose self-report cannot be trusted.
 * @module scripts/lib/loop
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { readSessionEvents } from './sessions.mjs'

/**
 * @param {string} name - tool name.
 * @param {unknown} args - the raw arguments.
 * @returns {string} a stable fingerprint for "the same call again".
 */
export function callFingerprint(name, args) {
  const text = typeof args === 'string' ? args : JSON.stringify(args ?? {})
  let normalized = text
  try { normalized = JSON.stringify(JSON.parse(text)) } catch { /* not JSON, use raw */ }
  return `${name}:${createHash('sha1').update(normalized).digest('hex').slice(0, 12)}`
}

/**
 * Read a session into the facts a loop needs: what was tried, what came back, what was concluded.
 * @param {string} dir - the session directory.
 * @returns {object} the observed state of the run.
 */
export function observeSession(dir) {
  const events = readSessionEvents(join(dir, 'session.v4.jsonl.zstd'))
  const calls = []
  const answers = []
  const errors = []
  let turns = 0
  for (const e of events) {
    switch (e.type) {
      case 'turn/start': turns++; break
      case 'tool/call':
        calls.push({ name: e.data?.name, args: e.data?.arguments, fp: callFingerprint(e.data?.name, e.data?.arguments), turn: turns })
        break
      case 'tool/result': {
        // The error payload is an object, not a string: String() would record "[object Object]".
        const err = e.data?.error
        if (err !== undefined) {
          const text = typeof err === 'string' ? err : (err.message ?? err.code ?? JSON.stringify(err))
          errors.push(String(text).slice(0, 200))
        }
        break
      }
      case 'assistant/message': {
        const text = (e.data?.message?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join(' ').trim()
        if (text !== '') answers.push({ text, turn: turns })
        break
      }
      default: break
    }
  }
  return { turns, calls, answers, errors }
}

/**
 * Detect the two ways an autonomous run stalls: repeating an identical call, and producing nothing
 * new. Both are measured from the log, not from the model's opinion of its own progress.
 * @param {object} state - the result of {@link observeSession}.
 * @param {object} previous - the state observed after the previous round.
 * @param {{repeatLimit?: number}} [opts] - tuning.
 * @returns {{repeated: string[], churning: string[], stalled: boolean, newCalls: number, newText: number}} the verdict.
 */
export function detectStall(state, previous, opts = {}) {
  const limit = opts.repeatLimit ?? 2
  const counts = new Map()
  for (const c of state.calls) counts.set(c.fp, (counts.get(c.fp) ?? 0) + 1)
  const repeated = [...counts.entries()].filter(([, n]) => n > limit).map(([fp]) => fp)
  // Exact fingerprints miss the failure we actually observed: the same tool called again and again
  // with slightly different arguments, hunting for a result it already had. Count by tool name too.
  const byTool = new Map()
  for (const c of state.calls) byTool.set(c.name, (byTool.get(c.name) ?? 0) + 1)
  const churning = [...byTool.entries()].filter(([, n]) => n > (opts.toolLimit ?? 3)).map(([name, n]) => `${name} x${n}`)
  const newCalls = state.calls.length - (previous?.calls.length ?? 0)
  const newText = state.answers.length - (previous?.answers.length ?? 0)
  return { repeated, churning, stalled: newCalls === 0 && newText === 0, newCalls, newText }
}

/**
 * Render the digest injected at the start of each round.
 *
 * This is the anti-repetition workhorse: the model is told, in compact form, what it has already
 * run and already concluded, so asking again is visibly redundant rather than merely wasteful. It is
 * capped, because a digest that grows without bound becomes the context problem it was meant to fix.
 * @param {object} state - the result of {@link observeSession}.
 * @param {{maxChars?: number, maxCalls?: number}} [opts] - caps.
 * @returns {string} the digest text.
 */
export function renderDigest(state, opts = {}) {
  const maxChars = opts.maxChars ?? 1200
  const maxCalls = opts.maxCalls ?? 12
  const seen = new Map()
  for (const c of state.calls) {
    const key = c.fp
    const entry = seen.get(key) ?? { name: c.name, args: c.args, n: 0 }
    entry.n++
    seen.set(key, entry)
  }
  const perTool = new Map()
  for (const c of state.calls) perTool.set(c.name, (perTool.get(c.name) ?? 0) + 1)
  const callLines = [...seen.values()].slice(-maxCalls).map(c => {
    const args = (typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {})).slice(0, 110)
    const tally = perTool.get(c.name) ?? 1
    const note = c.n > 1
      ? '  (identical call already run - do not repeat)'
      : tally > 2 ? `  (${c.name} tried ${tally}x with different arguments - stop varying it)` : ''
    return `- ${c.name} ${args}${note}`
  })
  const lastAnswer = state.answers[state.answers.length - 1]?.text ?? ''
  const parts = [
    `Rounds so far: ${state.turns}.`,
    callLines.length === 0 ? 'No tools have been run yet.' : `Tools already run:\n${callLines.join('\n')}`,
    lastAnswer === '' ? '' : `Your last conclusion was:\n${lastAnswer.slice(0, 400)}`,
    state.errors.length === 0 ? '' : `Errors seen: ${state.errors.slice(-2).join(' | ')}`,
  ].filter(p => p !== '')
  const text = parts.join('\n\n')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[digest truncated]` : text
}

/**
 * The prompt for one round: the objective, what is already known, and the rules the round runs under.
 * @param {object} args - round inputs.
 * @param {string} args.objective - the user's objective, unchanged every round.
 * @param {string} args.digest - the rendered digest.
 * @param {number} args.round - the current round number.
 * @param {number} args.maxRounds - the hard limit.
 * @param {string[]} [args.constraints] - extra operator constraints.
 * @returns {string} the round prompt.
 */
export function roundPrompt({ objective, digest, round, maxRounds, constraints = [] }) {
  return [
    `OBJECTIVE (unchanged): ${objective}`,
    '',
    `ROUND ${round} of at most ${maxRounds}.`,
    '',
    'WHAT YOU HAVE ALREADY DONE (from the durable log, not your memory):',
    digest,
    '',
    'RULES FOR THIS ROUND:',
    '- Do not repeat a tool call listed above; its result is already known to you.',
    '- Take exactly one concrete step towards the objective, then stop.',
    '- If the objective is already met, reply with the single line: DONE: <one-sentence result>.',
    '- If you cannot proceed, reply with the single line: BLOCKED: <what you need>.',
    ...constraints.map(c => `- ${c}`),
  ].join('\n')
}

/**
 * Classify a round's final text.
 * @param {string} text - the model's answer for the round.
 * @returns {{kind: 'done'|'blocked'|'working', detail: string}} the classification.
 */
export function classifyRound(text) {
  const t = String(text ?? '').trim()
  const done = /^\s*DONE:\s*(.+)$/im.exec(t)
  if (done !== null) return { kind: 'done', detail: done[1].trim() }
  const blocked = /^\s*BLOCKED:\s*(.+)$/im.exec(t)
  if (blocked !== null) return { kind: 'blocked', detail: blocked[1].trim() }
  return { kind: 'working', detail: t.slice(0, 200) }
}
