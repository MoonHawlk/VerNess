/**
 * `/btw` - "by the way": a side note that steers the next task without being one. Sent once, on the
 * next task, as a delimited "context, not tasks" block; kept (marked sent) until cleared. Zero tokens
 * by itself. Storage and the send-once rule: `scripts/lib/notes.mjs`.
 * @module scripts/commands/btw
 */

import { NEW_KEY, addNote, clearNotes, dropNote, readNotes, totalChars } from '../lib/notes.mjs'
import { head, info, ok, RUN_DIR, warn } from '../lib/util.mjs'

/** @param {object} ctx - command context. @returns {string} the notes key for this conversation. */
const keyOf = ctx => ctx.conversation?.id() ?? NEW_KEY

export default {
  name: 'btw',
  group: 'core',
  // Notes are composed onto the terminal REPL's next task; a browser task never reads them.
  web: false,
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
      head(`side notes (${notes.length}, ${totalChars(notes)}/${max} characters)`)
      if (notes.length === 0) info('none - add one with /btw <note>')
      notes.forEach((n, i) => info(`${i + 1}. ${n.text}${n.sent ? '  (sent)' : ''}`))
      return 0
    }
    if (args[0] === 'clear' && args.length === 1) { clearNotes(RUN_DIR, key); ok('notes cleared'); return 0 }
    if (args[0] === 'drop' && args.length === 2) {
      if (dropNote(RUN_DIR, key, Number(args[1]))) { ok(`note ${args[1]} dropped`); return 0 }
      warn(`no note ${args[1]} - /btw lists them`)
      return 1
    }
    const r = addNote(RUN_DIR, key, args.join(' '), max)
    if (r.refused) {
      warn(r.reason === 'cap' ? `notes are capped at ${max} characters (${r.total} used) - /btw clear or /btw drop <n>` : 'empty note')
      return 1
    }
    ok(`note ${r.notes.length} saved - ${r.total}/${max} characters; sent with your next task`)
    if (r.warn) warn(`notes are at ${Math.round((100 * r.total) / max)}% of their cap`)
    return 0
  },
}
