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

import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus, platform } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { GATE, MIN_LABELS } from '../lib/calibration.mjs'
import { ROUTING_QUESTIONS, decisionsDir, optionHash, temperaturesFile } from '../lib/decisions.mjs'
import {
  appendLabel, currentReport, labelCounts, latestGate, matchRecords, parseLabelInput, readLabels, readShadow, unlabelled,
} from '../lib/labels.mjs'
import { REPO, head, info, ok, paint, table, warn } from '../lib/util.mjs'

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
 * @param {string} [relabel] - relabel the records matching this id or task text, labelled or not.
 * @returns {Promise<number>} exit code.
 */
async function label(dir, questions, limit, relabel) {
  if (process.stdin.isTTY !== true) { warn('labelling needs a terminal'); return 1 }
  const labels = readLabels(dir)
  const records = relabel === undefined ? readShadow(dir) : matchRecords(readShadow(dir), relabel)
  const pending = records
    .map(rec => ({ rec, qs: questions.filter(q => (relabel !== undefined || labels.get(rec.id)?.[q] === undefined) && sameOptions(rec, q)) }))
    .filter(p => p.qs.length > 0)
    .slice(0, limit)
  if (pending.length === 0) {
    if (relabel !== undefined) { warn(`no shadow record matches "${relabel}" - use a record id or words from the task`); return 1 }
    ok('nothing to label - every shadow record already has a label'); printStatus(dir, questions); return 0
  }

  head(`${relabel === undefined ? 'labelling' : 'relabelling'} ${pending.length} record(s): the right answer for each question, in your judgement`)
  if (relabel !== undefined) info('your current label is shown; the newest label wins, so nothing is lost')
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
        const current = labels.get(rec.id)?.[q]
        if (current !== undefined) info(`your current label: ${current}  (id ${rec.id})`)
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

/** @param {number|null|undefined} v - a metric. @returns {string} two decimals, or `-`. */
const fmt = v => (v === null || v === undefined || Number.isNaN(v) ? '-' : v.toFixed(2))

const REPORT_HEAD = ['question', 'n', 'model acc', 'model ECE', 'AUROC', 'refit ECE', 'T', 'rules acc', 'rules ECE']

/** @param {object} r - a report row. @returns {string[]} its table cells. */
const reportCells = r => [
  r.question, String(r.n), fmt(r.model.accuracy), fmt(r.model.ece), fmt(r.model.auroc),
  fmt(r.modelRefit?.ece), r.T === undefined ? '-' : String(r.T), fmt(r.rules.accuracy), fmt(r.rules.ece),
]

/**
 * A factual one-paragraph reading of the report, in the plain style of `08-DECISION-LAYER-LAYA.md`.
 * @param {object[]} rows - the report rows.
 * @returns {string} the paragraph.
 */
function reading(rows) {
  const parts = rows.map(r => {
    const acc = r.model.accuracy > r.rules.accuracy ? 'more accurate than' : r.model.accuracy < r.rules.accuracy ? 'less accurate than' : 'as accurate as'
    const cal = r.model.ece < r.rules.ece ? 'better calibrated' : 'no better calibrated'
    return `on \`${r.question}\` the model is ${acc} the rules (${fmt(r.model.accuracy)} vs ${fmt(r.rules.accuracy)}) and ${cal} (ECE ${fmt(r.model.ece)} vs ${fmt(r.rules.ece)})`
  })
  const small = rows.some(r => r.n < MIN_LABELS)
  return (parts.length === 0 ? 'No labelled records yet.' : `With these labels, ${parts.join('; ')}.`)
    + ' The rules have no confidence and are scored as always sure, so their ECE is 1 − accuracy.'
    + (small ? ` Some questions have fewer than ${MIN_LABELS} labels: these numbers move a lot with each new label, and such a question cannot pass the gate (T-223).` : '')
}

/**
 * `/decisions-data report [--write]`.
 * @param {object} ctx - command context.
 * @param {string} dir - the decisions directory.
 * @param {string[]} questions - the question keys.
 * @param {boolean} write - also publish `docs/research/decision-calibration.md`.
 * @returns {number} exit code.
 */
function printReport(ctx, dir, questions, write) {
  const rows = currentReport(dir, questions)
  if (rows.length === 0) { warn('no labelled records yet - run /decisions-data label first'); return 1 }
  head('calibration: the model vs the rules, against your labels')
  for (const l of table(REPORT_HEAD, rows.map(reportCells))) console.log(`  ${l}`)
  info('ECE: lower is better calibrated. AUROC: does confidence separate right from wrong (0.5 = no)')
  info(`refit ECE and T appear only when a held-out temperature refit helped (needs ${MIN_LABELS}+ labels)`)
  if (rows.some(r => r.n < MIN_LABELS)) info(`below ${MIN_LABELS} labels a question cannot pass the gate - keep labelling`)
  if (!write) return 0
  const out = join(REPO, 'docs', 'research', 'decision-calibration.md')
  mkdirSync(join(REPO, 'docs', 'research'), { recursive: true })
  const md = [
    '# Decision calibration: the model vs the rules',
    '',
    `Generated by \`/decisions-data report --write\` on ${new Date().toISOString().slice(0, 10)}.`,
    `Machine: ${platform()}, ${cpus()[0]?.model?.trim() ?? 'unknown CPU'}. Checkpoint: \`${ctx.cfg?.decisions?.checkpoint ?? 'unknown'}\`.`,
    `Labelled records per question: ${rows.map(r => `${r.question} ${r.n}`).join(', ')}.`,
    '',
    `| ${REPORT_HEAD.join(' | ')} |`,
    `|${REPORT_HEAD.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${reportCells(r).join(' | ')} |`),
    '',
    reading(rows),
    '',
  ].join('\n')
  writeFileSync(out, md, 'utf8')
  ok(`written: ${out}`)
  return 0
}

/**
 * `/decisions-data refit`: store the temperatures whose held-out refit was kept. Entries that no
 * longer qualify are dropped, so the file always matches the current evidence.
 * @param {string} dir - the decisions directory.
 * @param {string[]} questions - the question keys.
 * @returns {number} exit code.
 */
function refit(dir, questions) {
  const rows = currentReport(dir, questions)
  const at = new Date().toISOString()
  const kept = Object.fromEntries(rows.filter(r => r.T !== undefined).map(r => [`${r.question}:${r.hash}`, { T: r.T, n: r.n, at }]))
  mkdirSync(dir, { recursive: true })
  writeFileSync(temperaturesFile(dir), `${JSON.stringify(kept, null, 2)}\n`, 'utf8')
  if (Object.keys(kept).length === 0) {
    warn(`no refit kept: each question needs ${MIN_LABELS}+ labelled records with probabilities, and a held-out improvement`)
    for (const r of rows) info(`${r.question}: ${r.n} labelled`)
    return 0
  }
  for (const [k, v] of Object.entries(kept)) ok(`${k.split(':')[0]}: T = ${v.T} (n ${v.n})`)
  info('applied to shadow decisions from the next REPL start (/decide applies it now); raw confidence is logged too')
  return 0
}

/**
 * `/decisions-data gate`: one line per question, `PASS` or `HOLD — <why>` (T-223). It only reports:
 * nothing is applied until the operator also turns a question on (T-262).
 * @param {string} dir - the decisions directory.
 * @param {string[]} questions - the question keys.
 * @returns {number} exit code (0 either way: a HOLD is an answer, not an error).
 */
function printGate(dir, questions) {
  const gate = latestGate(dir, questions)
  head('calibration gate: may the model steer this question? (report only - nothing is applied)')
  const width = Math.max(...questions.map(q => q.length))
  for (const q of questions) {
    const g = gate[q]
    console.log(`  ${q.padEnd(width)}  ${g.pass ? `${paint('green', 'PASS')} ${paint('dim', g.why)}` : `${paint('yellow', 'HOLD')} — ${g.why}`}`)
  }
  return 0
}

export default {
  name: 'decisions-data',
  aliases: ['dd'],
  group: 'decisions',
  summary: 'label shadow decisions so the decision model can be measured: /decisions-data label',
  usage: '/decisions-data [status] | label [--question level|tier|pipeline] [--limit N] [--relabel <id | task words>] | report [--write] | refit | gate',
  details: [
    'status  labels per question against the 50 the gate needs (200 is better)',
    'label   blind labelling loop over unlabelled shadow records; saved as you go',
    '        --relabel <id | task words> re-asks matching records, labelled or not; the newest label wins',
    'report  accuracy, ECE and AUROC per question, model vs rules; --write publishes docs/research/decision-calibration.md',
    'refit   stores held-out temperature refits in .finess/decisions/temperatures.json (needs 50+ labels)',
    `gate    PASS or HOLD per question: n >= ${GATE.minLabels}, accuracy >= rules, ECE < rules ECE, ECE <= ${GATE.maxEce}, AUROC >= ${GATE.minAuroc}`,
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
    const rAt = args.indexOf('--relabel')
    let relabel
    if (rAt >= 0) {
      // The query runs until the next flag, so task words need no quoting.
      const end = args.findIndex((a, i) => i > rAt && a.startsWith('--'))
      relabel = args.slice(rAt + 1, end < 0 ? undefined : end).join(' ')
      if (relabel.trim() === '') { warn('--relabel takes a record id or words from the task'); return 1 }
    }
    if (sub === 'label') return label(dir, questions, limit, relabel)
    if (sub === 'report') return printReport(ctx, dir, questions, args.includes('--write'))
    if (sub === 'refit') return refit(dir, questions)
    if (sub === 'gate') return printGate(dir, questions)
    warn(`unknown subcommand: ${sub}`)
    info(this.usage)
    return 1
  },
}
