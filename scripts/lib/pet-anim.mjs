/**
 * Ness moving at the prompt: a small scheduler that repaints only the art's rows in place (T-335f).
 *
 * Safety model. The animator never guesses where the art is. The caller tells it how many rows were
 * printed after the art, and the line editor reports, after every redraw, which row its cursor is on
 * and whether its dropdown is open. A repaint saves the cursor, climbs to one art row, rewrites the
 * art's columns only (the panel text beside her is never touched), and restores the cursor. It holds
 * while the dropdown is open, stops when the art may have scrolled off the screen, and the REPL stops
 * it before anything else prints - every command and every model turn, so nothing draws while `dsh`
 * streams (T-335d). Time and the terminal are injected, so tests run on a fake clock and a fake screen.
 * @module scripts/lib/pet-anim
 */

import { activityOf, animationAllowed, petArt, petFrames, petIntro } from './pet.mjs'

const ESC = '\u001b'
/**
 * DECSC / DECRC (ESC 7 / ESC 8) save and restore the cursor. Chosen over CSI s / CSI u, which some
 * terminals (Terminal.app among them) do not honour; Windows Terminal, conhost, iTerm2 and xterm
 * know the DEC pair.
 */
const SAVE = `${ESC}7`
const RESTORE = `${ESC}8`
const CYAN = `${ESC}[36m`
const OFF = `${ESC}[0m`
/** Rows the editor may draw below its cursor (six dropdown rows and a "more" line), plus one spare. */
const BELOW_CURSOR = 8

/**
 * @typedef {import('./pet.mjs').PetTrack} PetTrack
 * @typedef {{place(at: {bottom: number, hold?: boolean}): void, start(): void, stop(): void,
 *   running(): boolean}} Animator
 */

/**
 * The scheduler. Plays `tracks` in order: a `loop: false` track plays once and hands over to the
 * next; a looping track repeats until `stop`. One timer at most, unref'd so it never keeps the
 * process alive.
 * @param {object} o - options.
 * @param {PetTrack[]} o.tracks - what to play, in order.
 * @param {string[]} o.drawn - the art as it is on screen now; only rows that differ get repainted.
 * @param {number} [o.from] - the first art row on screen (1 when the blank mark row is not drawn);
 *   rows above it are never written.
 * @param {number} [o.column] - the art's left column (`renderPet` indents it by 2).
 * @param {(s: string) => unknown} o.write - the terminal writer; one call per repaint.
 * @param {() => number|undefined} o.rows - the terminal height; unknown means never paint.
 * @param {(fn: () => void, ms: number) => any} o.setTimeout - timer start.
 * @param {(id: any) => void} o.clearTimeout - timer stop.
 * @param {() => number} [o.random] - 0..1, for jitter.
 * @returns {Animator} the controller. `place` reports the cursor: `bottom` is how many rows it sits
 *   below the art's last row, `hold` pauses painting (the dropdown is open).
 */
export function createAnimator(o) {
  const random = o.random ?? Math.random
  const from = o.from ?? 0
  const column = o.column ?? 0
  const shown = [...o.drawn]
  let want = shown
  let ti = 0
  let fi = 0
  let timer
  let stopped = false
  let bottom
  let hold = false

  /** Bring the screen in line with `want`, when it is safe to. */
  const flush = () => {
    if (stopped || bottom === undefined || hold) return
    const H = want.length
    const rows = want.map((_, i) => i).filter(i => i >= from && want[i] !== shown[i])
    if (rows.length === 0) return
    // The highest row painted must still be on screen, with room for the dropdown below the cursor;
    // otherwise cursor-up would clamp at the top and overwrite the wrong line.
    const height = o.rows()
    if (height === undefined || bottom < 1 || bottom + H - 1 - from + BELOW_CURSOR >= height) { stop(); return }
    const right = column > 0 ? `${ESC}[${column}C` : ''
    o.write(rows.map(i => `${SAVE}${ESC}[${bottom + H - 1 - i}A\r${right}${CYAN}${want[i]}${OFF}${RESTORE}`).join(''))
    for (const i of rows) shown[i] = want[i]
  }
  /** @param {number} ms @param {number} jitter @returns {number} the randomised delay. */
  const delay = (ms, jitter) => Math.max(0, Math.round(ms * (1 + (random() * 2 - 1) * jitter)))
  const schedule = () => {
    const t = o.tracks[ti]
    // The last frame of the last one-shot track stays: nothing more to play.
    if (!t.loop && fi === t.frames.length - 1 && ti === o.tracks.length - 1) return
    timer = o.setTimeout(advance, delay(t.frames[fi].ms, t.jitter))
    timer?.unref?.()
  }
  const advance = () => {
    timer = undefined
    if (stopped) return
    const t = o.tracks[ti]
    if (fi + 1 < t.frames.length) fi++
    else if (t.loop) fi = 0
    else { ti++; fi = 0 }
    want = o.tracks[ti].frames[fi].lines
    flush()
    if (!stopped) schedule()
  }
  const stop = () => {
    stopped = true
    if (timer !== undefined) o.clearTimeout(timer)
    timer = undefined
  }
  return {
    place(at) {
      bottom = at.bottom
      hold = at.hold === true
      flush()
    },
    start() {
      if (stopped || timer !== undefined || o.tracks.length === 0) return
      ti = 0
      fi = 0
      want = o.tracks[0].frames[0].lines
      flush()
      if (!stopped) schedule()
    },
    stop,
    running: () => !stopped && timer !== undefined,
  }
}

/**
 * Animate the pet `renderPet` just drew, while the line editor waits. Returns a no-op controller
 * when `animationAllowed` says no (off a TTY, `pet.animate: false`, `pet.enabled: false`,
 * `FINESS_NO_PET`, `NO_COLOR`, `CI`, a narrow terminal), so callers never branch. It starts on the
 * editor's first redraw, when the cursor row is known, and stops itself on exit and on resize (a
 * narrower terminal reflows the side-by-side layout).
 * @param {object} o - options.
 * @param {object} o.vitals - the vitals `renderPet` drew.
 * @param {object} o.cfg - the merged configuration.
 * @param {number} o.after - terminal rows printed between the art's last row and the editor.
 * @param {{isTTY?: boolean, columns?: number, rows?: number, write(s: string): unknown,
 *   on?: Function, off?: Function}} [o.out] - the terminal (default `process.stdout`).
 * @param {Record<string, string|undefined>} [o.env] - the environment (default `process.env`).
 * @param {{on?: Function, off?: Function}} [o.proc] - for the exit hook (default `process`).
 * @param {(fn: () => void, ms: number) => any} [o.setTimeout] - timers, for tests.
 * @param {(id: any) => void} [o.clearTimeout] - timers, for tests.
 * @param {() => number} [o.random] - jitter source, for tests.
 * @returns {{onRender(state: {row: number, dropdown: boolean}): void, stop(): void, running(): boolean,
 *   why?: string}} pass `onRender` to the editor and call `stop` once it returns.
 */
export function petAnimation(o) {
  const out = o.out ?? process.stdout
  const allowed = animationAllowed({ isTTY: out.isTTY, columns: out.columns, env: o.env ?? process.env, cfg: o.cfg })
  if (!allowed.ok) return { onRender() {}, stop() {}, running: () => false, why: allowed.why }
  const { mood, intro } = activityOf(o.vitals)
  const art = petArt(mood)
  const anim = createAnimator({
    tracks: [intro === undefined ? undefined : petIntro(intro, mood), petFrames(mood)].filter(t => t !== undefined),
    drawn: art,
    // `renderPet` leaves out a blank mark row.
    from: art[0].trim() === '' ? 1 : 0,
    column: 2,
    write: s => out.write(s),
    rows: () => out.rows,
    setTimeout: o.setTimeout ?? setTimeout,
    clearTimeout: o.clearTimeout ?? clearTimeout,
    random: o.random,
  })
  const proc = o.proc ?? process
  const stop = () => {
    anim.stop()
    proc.off?.('exit', stop)
    out.off?.('resize', stop)
  }
  proc.on?.('exit', stop)
  out.on?.('resize', stop)
  let started = false
  return {
    onRender({ row, dropdown }) {
      anim.place({ bottom: o.after + 1 + row, hold: dropdown })
      if (!started) { started = true; anim.start() }
    },
    stop,
    running: anim.running,
  }
}

/**
 * How many terminal rows some lines take, counting the ones that wrap.
 * @param {string[]} lines - lines as printed (may carry colour codes).
 * @param {number} columns - the terminal width.
 * @returns {number|undefined} the rows they occupy, or undefined when a line exactly fills its last
 *   row: terminals disagree on whether that adds an empty row, so the count cannot be trusted.
 */
export function rowsOf(lines, columns) {
  let n = 0
  for (const l of lines) {
    const len = l.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').length
    if (len > 0 && len % columns === 0) return undefined
    n += Math.max(1, Math.ceil(len / columns))
  }
  return n
}
