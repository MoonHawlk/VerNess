/**
 * Fold a session log into the agent's current todo list. The substrate records each `todo/write`
 * event as a whole-list snapshot (`data.todos: [{content, status}]`, status pending|in_progress|
 * completed), latest write wins (packages/todo/tool-todo/src/types.ts:31, :45).
 * @module scripts/lib/todos
 */

/**
 * @param {object[]} events - decoded session events, in append order.
 * @returns {{content: string, status: string}[]|null} the latest list, or null when never written.
 */
export function foldTodos(events) {
  let list = null
  for (const e of events) {
    if (e?.type !== 'todo/write' || !Array.isArray(e.data?.todos)) continue
    list = e.data.todos.filter(t => t !== null && typeof t === 'object').map(t => ({ content: String(t.content ?? ''), status: String(t.status ?? 'pending') }))
  }
  return list
}

/**
 * @param {{content: string, status: string}[]} todos - a folded list.
 * @returns {string[]} one `[x]`/`[~]`/`[ ]` line per item, then a done count.
 */
export function formatTodos(todos) {
  const mark = { completed: '[x]', in_progress: '[~]' }
  const done = todos.filter(t => t.status === 'completed').length
  return [...todos.map(t => `${mark[t.status] ?? '[ ]'} ${t.content}`), `${done}/${todos.length} done`]
}
