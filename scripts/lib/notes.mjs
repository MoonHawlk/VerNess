/**
 * Operator context that steers a task without being one: `/btw` side notes, kept per session in
 * `.finess/run/notes-<session>.json`.
 *
 * A note is sent ONCE, on the next task, then marked `sent`: every REPL turn continues one substrate
 * session, so the model keeps it in its own history. Resending would duplicate it in the log and
 * grow the bill. A new session (`/new`) gets every kept note again on its first task.
 *
 * Every function takes an explicit `dir` so tests use a temp directory; the REPL passes the run dir.
 * @module scripts/lib/notes
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** @typedef {{text: string, at: string, sent: boolean}} Note */

/** The notes key before the first turn has created a session. */
export const NEW_KEY = 'new'

/**
 * @param {string} dir - run dir.
 * @param {string} key - session identity, or `NEW_KEY` before the first turn.
 * @returns {string} the notes file.
 */
export const notesFile = (dir, key) => join(dir, `notes-${String(key).replace(/[^\w.-]+/g, '_')}.json`)

/** @param {string} dir - run dir. @param {string} key - session key. @returns {Note[]} the notes ([] when none or unreadable). */
export function readNotes(dir, key) {
  try {
    // A byte-order mark (a file saved by a Windows editor) must not make the notes vanish.
    const v = JSON.parse(readFileSync(notesFile(dir, key), 'utf8').replace(/^﻿/, ''))
    return Array.isArray(v) ? v.filter(n => typeof n?.text === 'string') : []
  } catch { return [] }
}

/** @param {string} dir - run dir. @param {string} key - session key. @param {Note[]} notes - what to store. */
function writeNotes(dir, key, notes) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(notesFile(dir, key), `${JSON.stringify(notes, null, 2)}\n`, 'utf8')
}

/** @param {Note[]} notes - notes. @returns {number} total characters. */
export const totalChars = notes => notes.reduce((n, x) => n + x.text.length, 0)

/**
 * Append a note, refusing an empty one or one that would pass the cap.
 * @param {string} dir - run dir.
 * @param {string} key - session key.
 * @param {string} text - the note.
 * @param {number} maxChars - the cap for all notes together.
 * @returns {{notes: Note[], total: number, warn: boolean, refused: boolean, reason?: 'empty'|'cap'}} the outcome;
 *   `warn` is true at 80% of the cap or more.
 */
export function addNote(dir, key, text, maxChars) {
  const notes = readNotes(dir, key)
  const t = String(text).trim()
  const outcome = (refused, reason) => {
    const total = totalChars(notes)
    return { notes, total, warn: total >= 0.8 * maxChars, refused, ...(reason === undefined ? {} : { reason }) }
  }
  if (t === '') return outcome(true, 'empty')
  if (totalChars(notes) + t.length > maxChars) return outcome(true, 'cap')
  notes.push({ text: t, at: new Date().toISOString(), sent: false })
  writeNotes(dir, key, notes)
  return outcome(false)
}

/**
 * @param {string} dir - run dir. @param {string} key - session key.
 * @param {number} index1 - 1-based, as `/btw` prints it.
 * @returns {boolean} whether a note was removed.
 */
export function dropNote(dir, key, index1) {
  const notes = readNotes(dir, key)
  if (!Number.isInteger(index1) || index1 < 1 || index1 > notes.length) return false
  notes.splice(index1 - 1, 1)
  writeNotes(dir, key, notes)
  return true
}

/** @param {string} dir - run dir. @param {string} key - session key. */
export function clearNotes(dir, key) {
  rmSync(notesFile(dir, key), { force: true })
}

/**
 * Move notes from one key to another (appended after the target's own), then delete the source.
 * Used when the first turn reveals the session id, and when `/new` carries notes to a fresh session.
 * @param {string} dir - run dir. @param {string} from - source key. @param {string} to - target key.
 */
export function moveNotes(dir, from, to) {
  if (from === to || !existsSync(notesFile(dir, from))) return
  writeNotes(dir, to, [...readNotes(dir, to), ...readNotes(dir, from)])
  rmSync(notesFile(dir, from), { force: true })
}

/** @param {Note[]} notes - notes. @returns {Note[]} the ones not yet sent. */
export const pendingNotes = notes => notes.filter(n => n.sent !== true)

/** @param {string} dir - run dir. @param {string} key - session key. @param {boolean} sent - the new flag for every note. */
function setSent(dir, key, sent) {
  const notes = readNotes(dir, key)
  if (notes.length > 0) writeNotes(dir, key, notes.map(n => ({ ...n, sent })))
}

/** Mark every note sent. @param {string} dir - run dir. @param {string} key - session key. */
export const markSent = (dir, key) => setSent(dir, key, true)

/** Mark every note unsent, so a fresh session receives them again. @param {string} dir - run dir. @param {string} key - session key. */
export const markUnsent = (dir, key) => setSent(dir, key, false)

/**
 * Prefix operator context onto a task, clearly delimited so the model reads it as context. Attached
 * files, pages and command output (`@path`, `@url`, `!!cmd`; T-181) follow the task, each fenced.
 * @param {string} task - the task text.
 * @param {{notes?: Note[], brief?: string, attachments?: {label: string, body: string, truncated?: boolean}[]}} extra -
 *   what to add; the brief goes first, attachments last.
 * @returns {string} the composed task (the task unchanged when there is nothing to add).
 */
export function composeTask(task, extra = {}) {
  const blocks = []
  const brief = String(extra.brief ?? '').trim()
  if (brief !== '') blocks.push(`Project brief from the operator (standing context, not tasks):\n${brief}`)
  const notes = extra.notes ?? []
  if (notes.length > 0) blocks.push(['Side notes from the operator (context, not tasks):', ...notes.map(n => `- ${n.text}`)].join('\n'))
  const atts = (extra.attachments ?? []).map(a =>
    [`----- attached: ${a.label}${a.truncated === true ? ' (truncated)' : ''} -----`, a.body, `----- end of ${a.label} -----`].join('\n'))
  const tail = atts.length === 0 ? [] : ['Attached by the operator (context for the task above):', ...atts]
  if (blocks.length === 0 && tail.length === 0) return task
  return [...blocks, ...(blocks.length === 0 ? [] : ['---']), task, ...tail].join('\n\n')
}

// --- The `#` project brief (T-147): durable, one file per checkout, survives sessions. ---

/** @param {string} root - repo root. @returns {string} the brief file, `<root>/.finess/brief.md`. */
export const briefFile = root => join(root, '.finess', 'brief.md')

/** @param {string} root - repo root. @returns {string} the brief, trimmed ('' when none). */
export function readBrief(root) {
  try { return readFileSync(briefFile(root), 'utf8').replace(/^﻿/, '').trim() } catch { return '' }
}

/**
 * Append one line (`- <text>`) to the brief: `#<text>` in the REPL.
 * @param {string} root - repo root.
 * @param {string} text - the line.
 * @param {number} maxChars - cap for the whole brief.
 * @returns {{line: string, total: number, warn: boolean, refused: boolean, reason?: 'empty'|'cap'}} the outcome;
 *   `line` is what was appended, `warn` is true at 80% of the cap or more.
 */
export function appendBrief(root, text, maxChars) {
  const cur = readBrief(root)
  const t = String(text).trim()
  const line = `- ${t}`
  const next = cur === '' ? line : `${cur}\n${line}`
  const outcome = (total, refused, reason) => ({ line, total, warn: total >= 0.8 * maxChars, refused, ...(reason === undefined ? {} : { reason }) })
  if (t === '') return outcome(cur.length, true, 'empty')
  if (next.length > maxChars) return outcome(cur.length, true, 'cap')
  mkdirSync(join(root, '.finess'), { recursive: true })
  writeFileSync(briefFile(root), `${next}\n`, 'utf8')
  return outcome(next.length, false)
}
