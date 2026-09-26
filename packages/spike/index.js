/**
 * M1 load-bearing spike. Smallest possible out-of-tree VerNess plugin: it registers one tool and
 * writes a mount marker (`verness-spike.log`, beside the loaded copy inside the profile's
 * node_modules), proving that a package living outside the dsh monorepo can be inserted
 * into a profile through `cordis.patch.yml` and reach the documented seams.
 *
 * Plain ESM on purpose — no build step, so the spike proves the loading mechanism and nothing else.
 * Real packages (M2+) are TypeScript with the contracts package.
 * @module @verness/spike
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'verness-spike'
export const inject = ['tools']

/**
 * Mount the spike: append a timestamped line to `verness-spike.log` beside this file (evidence of
 * mount even when no session runs) and register the `verness_ping` tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - registrant context carrying `ctx.tools`.
 */
export function apply(ctx) {
  const marker = join(import.meta.dirname, 'verness-spike.log')
  appendFileSync(marker, `${new Date().toISOString()} mounted\n`)
  ctx.effect(() => {
    return () => { appendFileSync(marker, `${new Date().toISOString()} disposed\n`) }
  })
  ctx.tools.register(defineTool({
    name: 'verness_ping',
    description: 'Diagnostic: confirm the VerNess plugin layer is mounted. Returns a fixed marker.',
    parameters: {
      // Optional parameters simply omit `required` — `required: false` is rejected by the schema compiler.
      note: { type: 'string', description: 'Optional text echoed back in the reply.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          layer: { type: 'string', required: true },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `VerNess layer ${value.layer} is mounted${value.note === undefined ? '' : `: ${value.note}`}`,
      }],
    },
    execute: args => ({ ok: true, layer: 'verness-spike', ...(args.note === undefined ? {} : { note: args.note }) }),
  }))
}
