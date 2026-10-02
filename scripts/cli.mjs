#!/usr/bin/env node
/**
 * The `verness` command (package.json `bin`) and what `turn_on.*` run. Checks the Node version
 * BEFORE loading the launcher: `verness.mjs` statically imports `.ts` contracts, which an old Node
 * rejects at link time, before any code of ours could print a useful message. Keep this file free
 * of static imports other than builtins and `./lib/node-version.mjs`, and of syntax newer than ES2020.
 * @module scripts/cli
 */

import { NODE_MIN, nodeOk } from './lib/node-version.mjs'

if (!nodeOk()) {
  process.stderr.write(
    `error: VerNess needs Node ${NODE_MIN.join('.')}+ on the 22 line, or 24+ (23 is not supported); ` +
      `this is Node ${process.versions.node}.\n  install a supported Node from https://nodejs.org and re-run\n`,
  )
  process.exit(1)
}

const argv = process.argv.slice(2)
// The web UI's commands bridge parses `--list-commands` stdout as JSON: skip the extra work there.
// The warning itself goes to stderr.
// Start the git call first (tracked.mjs loads only builtins) so it runs while the launcher loads;
// its warning prints before the command starts.
let check = Promise.resolve()
if (argv[0] !== '--list-commands') {
  const { warnUntrackedImports } = await import('./lib/tracked.mjs')
  check = warnUntrackedImports().catch(() => {})
}
const { main } = await import('./verness.mjs')
await check
await main(argv)
