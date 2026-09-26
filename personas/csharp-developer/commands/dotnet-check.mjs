/**
 * `/dotnet-check` - a persona-scoped command for the `csharp-developer` persona: the local .NET verification sequence (printed, not run).
 * Zero tokens, no model call: the launcher runs it in-process, same as any global quick-tool.
 * @module personas/csharp-developer/commands/dotnet-check
 */

import { head, info, line } from '../../../scripts/lib/util.mjs'

export default {
  name: 'dotnet-check',
  group: 'personas',
  summary: 'the local .NET verification sequence (printed, not run)',
  usage: '/dotnet-check',
  /**
   * @param {object} ctx - command context (unused: this command prints a fixed checklist).
   * @param {string[]} args - ignored.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    head('dotnet check')
    for (const l of [
      '1. dotnet restore',
      '2. dotnet build -warnaserror',
      '3. dotnet test',
      '4. dotnet format --verify-no-changes',
      '5. dotnet list package --vulnerable --include-transitive',
    ]) line(`  ${l}`)
    info('printed only - run them in order; each must pass before the next')
    return 0
  },
}
