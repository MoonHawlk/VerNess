/**
 * `/export` — write a session as a readable Markdown file (see `lib/export-md.mjs`).
 * @module scripts/commands/export
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { renderSessionMarkdown } from '../lib/export-md.mjs'
import { listSessions, localDay, readSessionEvents } from '../lib/sessions.mjs'
import { REPO, info, ok, warn } from '../lib/util.mjs'

export default {
  name: 'export',
  // The web UI reserves `/export` for the substrate's own command.
  web: false,
  group: 'core',
  summary: 'write a session as a Markdown file',
  usage: '/export [<id-prefix>] [--out <path>]',
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - optional session id prefix and `--out <path>`.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const rest = [...args]
    const outAt = rest.indexOf('--out')
    let out
    if (outAt >= 0) {
      out = rest[outAt + 1]
      if (out === undefined) { warn('--out needs a path'); return 1 }
      rest.splice(outAt, 2)
    }
    const sessions = listSessions({ workspace: ctx.workspaceKey, limit: 60 })
    const needle = rest[0]?.replace(/^session-/, '')
    const current = ctx.conversation?.id()
    const s = needle !== undefined ? sessions.find(x => x.id.startsWith(needle)) : sessions.find(x => x.identity === current)
    if (s === undefined) {
      warn(needle !== undefined ? `no recent session starts with "${rest[0]}"` : 'no current session yet - run a task first, or /export <id-prefix>')
      return 1
    }
    const md = renderSessionMarkdown(readSessionEvents(join(s.dir, 'session.v4.jsonl.zstd')), { id: s.id.slice(0, 8) })
    const file = resolve(out ?? join(REPO, '.finess', 'exports', `${localDay(s.at.getTime())}-${s.id.slice(0, 8)}.md`))
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, md)
    } catch (e) {
      warn(`could not write ${file}: ${e.code ?? e.message}`)
      return 1
    }
    ok(`exported ${s.id.slice(0, 8)} (${s.turns} turn(s)) to ${file}`)
    info('plain Markdown: keep it, share it, or paste it into another tool')
    return 0
  },
}
