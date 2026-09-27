/**
 * `/exit` — end the REPL, exactly as an empty line does. The prompt loop passes `ctx.quit`; outside
 * the REPL (a CLI word, a standalone script, the browser) there is nothing to end, so it is a no-op.
 * @module scripts/commands/exit
 */

import { info } from '../lib/util.mjs'

export default {
  name: 'exit',
  aliases: ['quit'],
  group: 'core',
  summary: 'end the prompt, like an empty line or ctrl+c',
  usage: '/exit',
  // Closing a terminal prompt means nothing in the browser UI.
  web: false,
  /**
   * @param {object} ctx - command context; the REPL sets `ctx.quit`.
   * @returns {number} exit code.
   */
  run(ctx) {
    if (typeof ctx.quit !== 'function') { info('/exit ends the interactive prompt; there is none here'); return 0 }
    ctx.quit()
    return 0
  },
}
