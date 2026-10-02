/**
 * `/pet` — call the pet back: live versions (launcher, substrate installed vs pinned, engine, node)
 * and workers (model engine, decision sidecar, last loop and team run), with a mood that says what
 * needs attention. The same panel greets you at boot; this redraws it with fresh probes.
 * @module scripts/commands/pet
 */

import { gatherVitals, renderPet } from '../lib/pet.mjs'

export default {
  name: 'pet',
  aliases: ['ness', 'status'],
  group: 'core',
  summary: 'the pet: versions, workers and what needs attention',
  usage: '/pet',
  details: [
    'the pet also greets you at boot; turn that off with "pet": { "enabled": false } in',
    'finess.config.json, or FINESS_NO_PET=1 for one run',
    'moods: happy (all good), sleepy (engine up, no model warm), worried (something is wrong)',
    'while the prompt waits she moves: happy blinks, sleepy lets a z drift up, worried pulses her !',
    '(until the problem is fixed and /pet redraws her); a /loop-task that just finished earns a',
    'cheer (done) or a ? (not done) first. She holds still while the dropdown is open and stops',
    'once you submit a line, so nothing draws during a turn. "animate": false keeps her still;',
    'so do NO_COLOR, CI, a pipe or a terminal too narrow to show her beside the panel',
  ],
  /**
   * @param {object} ctx - command context.
   * @returns {Promise<number>} exit code.
   */
  async run(ctx) {
    // On demand, paying for one `dsh --version` is fine; the boot path reuses the launcher's value.
    const r = ctx.sh('dsh', ['--version'], { capture: true, allowFail: true })
    const vitals = await gatherVitals(ctx.cfg, {
      dsh: r.code === 0 ? r.out.split('\n')[0].trim() : undefined,
      commands: new Set(ctx.commands.values()).size,
      session: ctx.conversation?.id(),
    })
    for (const l of renderPet(vitals, { columns: process.stdout.columns })) console.log(l)
    // The panel is the last thing printed, so the next prompt knows where she is and animates her.
    ctx.petDrawn?.(vitals)
    return 0
  },
}
