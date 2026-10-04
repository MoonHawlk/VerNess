/**
 * Pipeline executors (T-254). A REPL task runs through `executePipeline(mode, input, {run})`, so the
 * M7 modes (`agent | decision | adaptive`, docs/01-ARCHITECTURE.md "Core contracts") plug in beside
 * `standard` without touching the REPL.
 *
 * `standard` is "one model turn with tools" (docs/09-HANDOFF-DECISION-ROUTING.md, "3. Pipeline"):
 * one dsh run on the route T-361/T-453 resolved, with the substrate's own tool loop inside that turn.
 * No planning, no evaluation, no retry. It is exactly what the REPL did before this module, so the
 * argv and options are byte-identical (pinned in scripts/test/pipeline.test.mjs).
 *
 * Session, notes, brief and attachment bookkeeping stay in the REPL; an executor only builds the run
 * and calls the injected runner.
 * @module scripts/lib/pipeline
 */

/** Every mode the contract names; only `standard` has an executor before M7. */
export const PIPELINE_MODES = ['standard', 'agent', 'decision', 'adaptive']

/**
 * @typedef {object} PipelineInput
 * @property {string[]} base - leading dsh args (`--profile <name>`).
 * @property {string[]} [overlays] - `--patch <file>` pairs, in order (recipe overlay, then fallback).
 * @property {string} [sessionId] - the session to continue; undefined starts a new one.
 * @property {string} task - the composed task text (brief, notes and attachments included).
 * @property {Record<string, string>} [env] - extra environment for the route.
 * @property {string} [cwd] - the agent's working directory.
 */

/**
 * The single run a `standard` task makes. Pure.
 * @param {PipelineInput} input - the task.
 * @returns {{mode: 'standard', turns: 1, argv: string[], opts: {env: Record<string, string>, cwd?: string, task: true}}} the plan.
 */
export function planStandard({ base, overlays = [], sessionId, task, env = {}, cwd, timeoutMs }) {
  return {
    mode: 'standard',
    turns: 1,
    argv: [...base, ...overlays, ...(sessionId === undefined ? [] : ['--session-id', sessionId]), task],
    // `task: true` sends a long task through stdin (T-448).
    opts: { env, ...(cwd === undefined ? {} : { cwd }), ...(timeoutMs === undefined ? {} : { timeoutMs }), task: true },
  }
}

/** Executors by mode. M7 adds `agent`, `decision` and `adaptive` here. */
export const EXECUTORS = {
  standard: (input, { run }) => {
    const plan = planStandard(input)
    return { mode: plan.mode, ...run(plan.argv, plan.opts) }
  },
}

/**
 * Run one task in a pipeline mode. A mode without an executor never runs anything: it returns a
 * failure that names the milestone, so a caller can never silently get a different strategy.
 * @param {string} mode - the pipeline mode.
 * @param {PipelineInput} input - the task.
 * @param {{run: (argv: string[], opts: object) => {code: number}}} deps - the dsh runner.
 * @returns {{mode: string, code: number, error?: string}} the runner's result, tagged with the mode.
 */
export function executePipeline(mode, input, deps) {
  const exec = Object.hasOwn(EXECUTORS, mode) ? EXECUTORS[mode] : undefined
  if (exec !== undefined) return exec(input, deps)
  const error = PIPELINE_MODES.includes(mode)
    ? `pipeline "${mode}" is not implemented yet (M7) - only "standard" runs`
    : `unknown pipeline "${mode}" (expected one of ${PIPELINE_MODES.join(', ')})`
  return { mode, code: 2, error }
}
