/**
 * `/decisions-data` — the labelled set that decides whether the decision model may ever steer.
 *
 * `label` walks shadow records that have no human label yet and asks, per routing question, what
 * the right answer was. It is blind on purpose: the rules' answer and the model's answer are shown
 * shuffled and unmarked, so the operator is not anchored on either. Every label is written as it is
 * entered, so `q` (or ctrl+c) loses nothing.
 *
 * The file name avoids a clash with `decision.mjs`, which already owns the alias `decisions`.
 * @module scripts/commands/decisions-cmd
 */

import { createInterface } from 'node:readline'

import { ROUTING_QUESTIONS, decisionsDir, optionHash } from '../lib/decisions.mjs'
import { appendLabel, labelCounts, parseLabelInput, readLabels, readShadow, unlabelled } from '../lib/labels.mjs'
import { head, info, ok, paint, table, warn } from '../lib/util.mjs'

/** Labels per question below which the gate refuses to judge (T-223). */
const MIN_LABELS = 50
/** What the handoff recommends for a stable measurement. */
const GOOD_LABELS = 200

/**
 * Can this record be labelled for this question under today's options? A record logged under a
 * different option set (someone edited the criteria) cannot: its numbers mean different things.
 * @param {object} rec - a shadow record.
 * @param {string} q - the question key.
 * @returns {boolean} whether the option sets match (legacy records carry no hash and pass).
 */
function sameOptions(rec, q) {
  const h = rec.model?.[q]?.hash
  return h === undefined || h === optionHash(ROUTING_QUESTIONS[q])
}

/**
 * Print how many labels each question has, against the gate's minimum.
 * @param {string} dir - the decisions directory.
 * @param {string[]} questions - the question keys.
 */
function printStatus(dir, questions) {
  const recs = readShadow(dir)
  const labels = readLabels(dir)
  const counts = labelCounts(labels, questions)
  const rows = questions.map(q => {
    const n = counts[q].labelled
    const todo = unlabelled(recs, labels, q).filter(r => sameOptions(r, q)).length
    const bar = n >= GOOD_LABELS ? paint('green', 'good') : n >= MIN_LABELS ? paint('green', 'gate can judge') : paint('yellow', `${MIN_LABELS - n} to go`)
    return [q, String(n), String(counts[q].skipped), String(todo), bar]
  })
  head(`labelled set: ${recs.length} shadow records`)
  for (const l of table(['question', 'labelled', 'skipped', 'unlabelled', `vs ${MIN_LABELS} min`], rows)) console.log(`  ${l}`)
}

/**
 * Ask for one label until the input is usable.
 *
 * Reads through readline's line iterator rather than `rl.question()`: the iterator buffers lines
 * that arrive before they are asked for (fast typing, a paste), and it ends when input closes, where
 * a pending `question()` would never settle.
 * @param {AsyncIterator<string>} lines - the prompt's line iterator.
 * @param {string[]} options - the question's option keys.
 * @returns {Promise<{label: string} | {quit: true}>} the label, or quit (also on EOF / ctrl+c).
 */
async function askLabel(lines, options) {
  for (;;) {
    process.stdout.write(paint('cyan', `  label [1-${options.length} | s=skip | q=quit] > `))
    const next = await lines.next()
    if (next.done === true) { console.log(''); return { quit: true } }
    const p = parseLabelInput(next.value, options)
    if (p.invalid !== true) return p
    warn(`type 1-${options.length}, an option name, s or q`)
  }
}

/**
 * The labelling loop.
 * @param {string} dir - the decisions directory.
 * @param {string[]} questions - which questions to label.
 * @param {number} limit - at most this many records.
 * @returns {Promise<number>} exit code.
 */
async function label(dir, questions, limit) {
  if (process.stdin.isTTY !== true) { warn('labelling needs a terminal'); return 1 }
  const labels = readLabels(dir)
  const pending = readShadow(dir)
    .map(rec => ({ rec, qs: questions.filter(q => labels.get(rec.id)?.[q] === undefined && sameOptions(rec, q)) }))
    .filter(p => p.qs.length > 0)
    .slice(0, limit)
  if (pending.length === 0) { ok('nothing to label - every shadow record already has a label'); printStatus(dir, questions); return 0 }

  head(`labelling ${pending.length} record(s): the right answer for each question, in your judgement`)
  info('the two suggestions are the rules and the model, shuffled and unmarked - pick what is right, not who')
  info('s skips a task no option fits (it is not asked again); q stops - every label is saved as you go')
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false })
  // In a cooked terminal ctrl+c is a process signal, and nothing else handles it: unhandled, it
  // would kill the whole REPL. Scoped to this session, it just ends labelling (labels are saved).
  const stop = () => rl.close()
  process.on('SIGINT', stop)
  const lines = rl[Symbol.asyncIterator]()
  let written = 0
  try {
    for (const [i, { rec, qs }] of pending.entries()) {
      console.log('')
      head(`[${i + 1}/${pending.length}] ${String(rec.at ?? '').slice(0, 16).replace('T', ' ')} · ${rec.source ?? '?'}`)
      console.log(`  task: ${String(rec.task ?? '').slice(0, 500)}`)
      for (const q of qs) {
        const question = ROUTING_QUESTIONS[q]
        const options = Object.keys(question.criteria)
        console.log(`\n  ${paint('cyan', q)} - ${question.instructions}`)
        for (const [n, [k, desc]] of Object.entries(question.criteria).entries()) {
          console.log(`    ${n + 1} ${k.padEnd(12)} ${paint('dim', desc)}`)
        }
        const seen = [...new Set([rec.rules?.[q], rec.model?.[q]?.answer].filter(a => options.includes(a)))]
        if (Math.random() < 0.5) seen.reverse()
        if (seen.length > 0) info(`suggested: ${seen.join(' · ')}`)
        const p = await askLabel(lines, options)
        if ('quit' in p) { ok(`stopped - ${written} label(s) saved`); printStatus(dir, questions); return 0 }
        appendLabel(dir, { id: rec.id, question: q, label: p.label })
        written++
      }
    }
  } finally { process.removeListener('SIGINT', stop); rl.close() }
  ok(`done - ${written} label(s) saved`)
  printStatus(dir, questions)
  return 0
}

export default {
  name: 'decisions-data',
  aliases: ['dd'],
  group: 'decisions',
  summary: 'label shadow decisions so the decision model can be measured: /decisions-data label',
  usage: '/decisions-data [status] | label [--question level|tier|pipeline] [--limit N] | report | refit | gate',
  details: [
    'status  labels per question against the 50 the gate needs (200 is better)',
    'label   blind labelling loop over unlabelled shadow records; saved as you go',
    'report, refit, gate  come with WS-E Tasks 3 and 4',
  ],
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - subcommand and flags.
   * @returns {Promise<number>} exit code.
   */
  async run(ctx, args) {
    const sub = args[0] ?? 'status'
    const dir = decisionsDir()
    const qAt = args.indexOf('--question')
    const questions = qAt >= 0 ? [args[qAt + 1]] : Object.keys(ROUTING_QUESTIONS)
    if (!questions.every(q => Object.hasOwn(ROUTING_QUESTIONS, q))) {
      warn(`unknown question: ${questions.join(', ')} - use ${Object.keys(ROUTING_QUESTIONS).join(', ')}`)
      return 1
    }
    const lAt = args.indexOf('--limit')
    const limit = lAt >= 0 ? Number(args[lAt + 1]) : Infinity
    if (!(limit > 0)) { warn('--limit takes a positive number'); return 1 }

    if (sub === 'status') { printStatus(dir, questions); return 0 }
    if (sub === 'label') return label(dir, questions, limit)
    if (sub === 'report' || sub === 'refit' || sub === 'gate') {
      warn(`/decisions-data ${sub} is not built yet (WS-E Tasks 3-4) - label first, it needs ${MIN_LABELS} per question`)
      return 1
    }
    warn(`unknown subcommand: ${sub}`)
    info(this.usage)
    return 1
  },
}
