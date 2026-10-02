/**
 * `/context` - what the NEXT task will carry and roughly what it costs, against the model's context
 * window. Zero tokens. Matters for small local models. Arithmetic: `scripts/lib/context.mjs`.
 * @module scripts/commands/context
 */

import { buildContextReport, formatContextReport } from '../lib/context.mjs'
import { NEW_KEY, pendingNotes, readBrief, readNotes, totalChars } from '../lib/notes.mjs'
import { activePersonaId, loadPersonas, personaPrompt } from '../lib/personas.mjs'
import { effectiveRoute } from '../lib/routes.mjs'
import { listSessions } from '../lib/sessions.mjs'
import { head, info, line, RUN_DIR, REPO, warn } from '../lib/util.mjs'

export default {
  name: 'context',
  group: 'core',
  // Reads the terminal REPL's conversation and notes; a browser task never composes them.
  web: false,
  summary: 'what the next task carries, its estimated tokens and % of the context window',
  usage: '/context',
  details: [
    'parts: persona prompt, project brief, pending /btw notes, the conversation so far',
    'token counts are estimates (characters / 4); the conversation uses reported usage when the route gives it',
    'warns above 80% of the window; fix with /new, /btw drop, or a shorter .finess/brief.md',
  ],
  /**
   * @param {object} ctx - command context.
   * @returns {number} exit code.
   */
  run(ctx) {
    const cfg = ctx.cfg
    const id = ctx.conversation?.id()
    const parts = []

    const persona = loadPersonas(cfg).get(activePersonaId(cfg))
    if (persona !== undefined) {
      const { prefix, suffix } = personaPrompt(persona, cfg.tips ?? [])
      parts.push({ label: 'persona prompt', chars: prefix.length + suffix.length, note: persona.id })
    }

    // A new session gets the whole brief on its first task; a continuing one already holds it.
    const brief = readBrief(REPO)
    parts.push(id === undefined
      ? { label: 'project brief', chars: brief.length }
      : { label: 'project brief', chars: 0, note: `${brief.length} chars already in the session` })

    const notes = pendingNotes(readNotes(RUN_DIR, id ?? NEW_KEY))
    parts.push({ label: 'side notes', chars: totalChars(notes), note: `${notes.length} pending` })

    if (id !== undefined) {
      const s = listSessions({ workspace: ctx.workspaceKey, limit: 60 }).find(x => x.identity === id)
      if (s?.lastInputTokens !== undefined) parts.push({ label: 'conversation so far', tokens: s.lastInputTokens, note: 'reported by the model' })
      else parts.push({ label: 'conversation so far', chars: 0, note: 'size not reported by this route' })
    }

    const e = effectiveRoute(cfg)
    const window = e.route?.contextWindow ?? (e.route?.kind === 'catalog' ? undefined : 32768)
    const report = buildContextReport(parts, window)
    const { lines, warnings } = formatContextReport(report)
    head(`next task context (${e.model ?? e.name})`)
    lines.forEach(l => line(`  ${l}`))
    warnings.forEach((w, i) => (i === 0 ? warn(w) : info(w.trim())))
    return 0
  },
}
