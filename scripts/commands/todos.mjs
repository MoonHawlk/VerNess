/**
 * `/todos` - the agent's todo list for the current session (or one picked by id prefix), so you see
 * the plan the model is following. Zero tokens: folds `todo/write` events from the session log.
 * @module scripts/commands/todos
 */

import { join } from 'node:path'
import { readSessionEvents, listSessions } from '../lib/sessions.mjs'
import { foldTodos, formatTodos } from '../lib/todos.mjs'
import { head, info, warn } from '../lib/util.mjs'

export default {
  name: 'todos',
  // The web UI already renders the todo list in the conversation's tool rows.
  web: false,
  group: 'telemetry',
  summary: "the agent's todo list for this session: [x] done, [~] in progress, [ ] pending",
  usage: '/todos [<session-prefix>]',
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - an optional session id prefix.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const sessions = listSessions({ workspace: ctx.workspaceKey, limit: 50 })
    const cur = ctx.conversation?.id()
    const needle = (args[0] ?? (cur === undefined ? '' : String(cur))).replace(/^session-/, '')
    const s = needle === '' ? sessions[0] : sessions.find(x => x.id.startsWith(needle))
    if (s === undefined) { warn(needle === '' ? 'no sessions recorded yet' : `no session starting with "${needle}" - see /sessions`); return 1 }
    const todos = foldTodos(readSessionEvents(join(s.dir, 'session.v4.jsonl.zstd')))
    head(`todos - session ${s.id.slice(0, 8)}${s.title ? ` (${s.title.slice(0, 40)})` : ''}`)
    if (todos === null) { info('this session has no todo list (the agent never wrote one)'); return 0 }
    if (todos.length === 0) { info('the todo list is empty'); return 0 }
    for (const l of formatTodos(todos)) console.log(`  ${l}`)
    return 0
  },
}
