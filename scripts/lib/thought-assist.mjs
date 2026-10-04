/**
 * Decision-model assist for the thought graph (T-295), the launcher half: after a task's run, ask
 * Laya about each node the model recorded with `think_add` in that run - "worth persisting?" and
 * "contradicts an existing node?" in one call per node - and log a shadow record (`source:
 * 'thoughts'`) beside the rule baseline. Never acted on, never throws, silent when decisions are off.
 *
 * Why post-run and here, not inside `think_add`: the tool runs in the dsh plugin, which is installed
 * as a copy under the profile and cannot reach this repo's decision client or its shadow log; and a
 * call made from inside the tool would race the dsh process exit. The shadow answer is the same.
 * @module scripts/lib/thought-assist
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { fileStore, storeFile } from '../../packages/thoughts/src/adapters.js'
import { assistQuestions, assistRules, assistState } from '../../packages/thoughts/src/assist.js'
import { foldEvents } from '../../packages/thoughts/src/fold.js'
import { projectKey, storedNodes } from '../../packages/thoughts/src/store.js'
import { askDecision, decisionConfig, loadTemperatures, logShadowDecision, modelAnswers } from './decisions.mjs'
import { readSessionEvents, sessionLogFile } from './sessions.mjs'

/**
 * The real readers for {@link shadowThoughts}: the session's log and the project's persistent record.
 * @param {string|undefined} session - the session identity (undefined: nothing to read).
 * @param {number} since - epoch ms when the run started.
 * @param {string} dir - the active workspace directory (the project).
 * @returns {{events: () => object[]|undefined, since: number, stored: () => object, session?: string}} the run.
 */
export function thoughtRun(session, since, dir) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return {
    since,
    ...(session === undefined ? {} : { session }),
    events: () => {
      const file = session === undefined ? undefined : sessionLogFile(session)
      return file === undefined ? undefined : readSessionEvents(file)
    },
    stored: () => fileStore(storeFile(home)).read(projectKey(dir)),
  }
}

/** Most nodes assessed after one run: the shadow must not stall the prompt. */
export const MAX_ASSESSED = 5

/**
 * The nodes this run recorded: the current task's (the fold resets per human prompt), stamped at or
 * after the run started - so a run that died before its prompt does not re-assess the last task.
 * @param {object[]} events - the session log.
 * @param {number} since - epoch ms when the run started.
 * @returns {import('../../packages/thoughts/src/schema.js').ThoughtNode[]} the nodes.
 */
export const runNodes = (events, since) => foldEvents(events).nodes.filter(n => Date.parse(n.at) >= since)

/**
 * @param {object} cfg - the FiNess configuration.
 * @param {{events: () => object[]|undefined, since: number, stored: () => {nodes: object[]}, session?: string}} run -
 *   the session log reader, the run's start, the project's persistent record reader, the session id.
 * @param {{ask?: typeof askDecision, dir?: string}} [opts] - test seams (fake model, temp decisions dir).
 * @returns {Promise<string[]>} the shadow record ids written (empty when off or nothing to ask).
 */
export async function shadowThoughts(cfg, run, opts = {}) {
  try {
    const dc = decisionConfig(cfg)
    if (dc.enabled !== true || dc.shadow !== true) return []
    const events = run.events()
    if (events === undefined) return []
    const nodes = runNodes(events, run.since).slice(0, MAX_ASSESSED)
    if (nodes.length === 0) return []
    const stored = storedNodes(run.stored())
    const ask = opts.ask ?? askDecision
    const temps = loadTemperatures(opts.dir)
    const ids = []
    for (const node of nodes) {
      const { questions, candidates } = assistQuestions(node, stored)
      const r = await ask(dc, assistState(node), questions, { retries: 1 })
      if (!r?.ok) break
      ids.push(logShadowDecision({
        source: 'thoughts', task: node.claim, node: node.id, ...(run.session === undefined ? {} : { session: run.session }),
        candidates, ms: r.ms, model: modelAnswers(r.body, temps, questions), rules: assistRules(node, stored, candidates),
      }, opts.dir))
    }
    return ids
  } catch { return [] }
}
