/**
 * Thin quick-tools over the launcher's own actions, so `/help` lists one complete command set instead
 * of the user having to remember which verbs are "launcher commands" and which are "quick tools".
 *
 * Each entry delegates to a handler the launcher passes in `ctx.builtins`.
 * @module scripts/commands/builtins
 */

import { warn } from '../lib/util.mjs'

/**
 * Build one delegating command.
 * @param {string} name - the command name.
 * @param {string} group - the help group.
 * @param {string} summary - the one-line description.
 * @param {string} [usage] - the usage line.
 * @returns {object} the command definition.
 */
const delegate = (name, group, summary, usage) => ({
  name,
  group,
  summary,
  usage: usage ?? `/${name}`,
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - forwarded arguments.
   * @returns {Promise<number>} exit code.
   */
  async run(ctx, args) {
    const fn = ctx.builtins?.[name]
    if (fn === undefined) { warn(`${name} is not available in this context`); return 1 }
    return (await fn(args)) ?? 0
  },
})

// One module can register several commands by exporting them individually; the loader reads the
// default export, so the extras are re-exported through a tiny wrapper file each. Keeping them here
// as an array would need loader support, so `default` is the model command and the rest live beside.
export default delegate('model', 'model', 'model status, or switch model: /model <id|source>', '/model [<id>]')
export const up = delegate('up', 'model', 'start the engine, fetch weights, warm the model')
export const down = delegate('down', 'model', 'unload weights, free memory, stop our engine', '/down [--force]')
export const stats = delegate('stats', 'telemetry', 'live engine telemetry: resident memory, tok/s, latency')
export const doctor = delegate('doctor', 'core', 'what is installed and what is missing')
export const sync = delegate('sync', 'core', 'regenerate the profile patch from the config')
export const web = {
  ...delegate('web', 'core', 'open the browser UI: a chat window with a message bar instead of the terminal', '/web [--port <n>] [--no-open]'),
  aliases: ['ui'],
}
export const graph = delegate('graph', 'telemetry', 'rebuild the Engram knowledge graph (no LLM calls)')
