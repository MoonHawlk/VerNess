/**
 * An inline-suggestion line editor for the REPL.
 *
 * Node's `readline` only completes on Tab, which is no help while typing. This is a small raw-mode
 * editor that renders, on every keystroke: the line being typed, a dim **ghost completion** of the
 * best match, and a live dropdown of the other candidates with their descriptions. Arrows move
 * through the list, Tab or Right accepts, Enter submits.
 *
 * No dependencies — the whole thing is ANSI escapes and keypress events, so it behaves the same on
 * Windows Terminal, macOS and Linux. When stdin is not a TTY (a pipe, CI) the caller falls back to
 * plain readline: an editor that redraws itself is meaningless without a terminal.
 * @module scripts/lib/prompt
 */

import { emitKeypressEvents } from 'node:readline'

import { recentTasks } from './history.mjs'

const ESC = '\u001b'
const DIM = `${ESC}[2m`
const OFF = `${ESC}[0m`
const REV = `${ESC}[7m`
const CYAN = `${ESC}[36m`

/** Matches the ANSI escape sequences this editor and its callers emit. */
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

/** Splits text into user-perceived characters, so the cursor never lands inside an emoji. */
const SEGMENTER = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined

/**
 * @param {string} s - plain text.
 * @returns {string[]} its graphemes (code points where Intl.Segmenter is missing).
 */
const graphemes = s => SEGMENTER === undefined ? [...s] : Array.from(SEGMENTER.segment(s), x => x.segment)

/** Code points a terminal draws two columns wide: CJK, Hangul, fullwidth forms, most emoji. */
const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f1e6, 0x1f1ff], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1faff],
  [0x20000, 0x3fffd],
]
/** Code points that take no column: combining marks, zero-width joiners, variation selectors. */
const ZERO = [[0x0300, 0x036f], [0x200b, 0x200f], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f]]

/**
 * Columns one grapheme takes. An approximation (terminals disagree on emoji sequences); what
 * matters is that the editor and the terminal agree on the common cases.
 * @param {string} g - one grapheme.
 * @returns {number} 0, 1 or 2.
 */
const cellWidth = g => {
  const cp = g.codePointAt(0) ?? 0
  const inAny = ranges => ranges.some(([a, b]) => cp >= a && cp <= b)
  if (inAny(WIDE) || g.includes('️')) return 2
  return inAny(ZERO) ? 0 : 1
}

/**
 * @param {string} s - text that may carry ANSI escapes.
 * @returns {number} how many columns it occupies.
 */
const visibleLength = s => graphemes(s.replaceAll(ANSI, '')).reduce((n, g) => n + cellWidth(g), 0)

/**
 * Cut a line to at most `max` visible columns, keeping its escapes, so it can never wrap.
 * @param {string} s - text that may carry ANSI escapes.
 * @param {number} max - the column budget.
 * @returns {string} the clipped text.
 */
const clip = (s, max) => {
  let cols = 0
  let full = false
  let res = ''
  for (const part of s.split(/(\u001b\[[0-9;]*[A-Za-z])/)) {
    if (part.startsWith(ESC)) { res += part; continue }
    for (const g of graphemes(part)) {
      if (full || cols + cellWidth(g) > max) { full = true; continue }
      res += g
      cols += cellWidth(g)
    }
  }
  return res
}

/**
 * Where the input sits once the terminal wraps it: prompt, buffer and ghost written in one go from
 * column 0. Terminals defer the wrap at the last column, and a wide character that does not fit
 * moves whole to the next row; both are modelled.
 * @param {string} prompt - the prompt, plain.
 * @param {string} buffer - the typed text.
 * @param {number} cursor - the cursor index in the buffer.
 * @param {string} ghost - the dim completion drawn after the buffer.
 * @param {number} columns - the terminal width.
 * @returns {{rows: number, cursorRow: number, cursorCol: number}} rows the text fills, and the cell
 *   the cursor belongs in; `cursorRow === rows` when it sits just past a row the text filled exactly.
 */
export function layout(prompt, buffer, cursor, ghost, columns) {
  let row = 0
  let col = 0
  /** @type {{row: number, col: number}|undefined} */
  let at
  const put = g => {
    const w = cellWidth(g)
    if (w > 0 && col + w > columns) { row++; col = 0 }
    col += w
  }
  // The cursor belongs where the next grapheme will be drawn.
  const mark = next => {
    if (at !== undefined) return
    at = col >= columns || (next !== undefined && col + cellWidth(next) > columns)
      ? { row: row + 1, col: 0 }
      : { row, col }
  }
  for (const g of graphemes(prompt)) put(g)
  let i = 0
  for (const g of graphemes(buffer)) {
    if (i >= cursor) mark(g)
    put(g)
    i += g.length
  }
  const tail = graphemes(ghost)
  mark(tail[0])
  for (const g of tail) put(g)
  return { rows: row + 1, cursorRow: at.row, cursorCol: at.col }
}

/**
 * @param {string} s - the buffer.
 * @param {number} i - an index in it.
 * @returns {{prev: number, next: number}} the grapheme boundaries either side of `i`.
 */
const around = (s, i) => {
  let prev = 0
  let at = 0
  for (const g of graphemes(s)) {
    if (at + g.length > i) return { prev, next: at + g.length }
    prev = at
    at += g.length
  }
  return { prev, next: s.length }
}

/** How many candidates the dropdown shows at once. */
const MAX_VISIBLE = 6

/**
 * Read one line with live suggestions.
 *
 * @param {object} opts - editor options.
 * @param {string} opts.prompt - the prompt text (already coloured).
 * @param {string} [opts.status] - a dim status line drawn above the prompt.
 * @param {(buffer: string) => {value: string, hint?: string, replace?: number}[]} opts.suggest -
 *   returns candidates for the current buffer. `replace` is how many characters at the end of the
 *   buffer the value replaces; it defaults to the length of the final word.
 * @param {string[]} [opts.history] - previous lines, newest last; navigated with Up/Down.
 * @returns {Promise<string|null>} the submitted line, or null on ctrl+c / ctrl+d.
 */
export function readLineWithSuggestions(opts) {
  const { prompt, suggest, status } = opts
  const history = opts.history ?? []
  const out = process.stdout

  return new Promise(resolve => {
    let buffer = ''
    let cursor = 0
    let selected = 0
    // What the last render left above the terminal cursor, kept so erase can count those rows at
    // any width: a resize reflows them (Windows Terminal, conhost and the macOS terminals do).
    /** @type {{above: number[], buffer: string, cursor: number, ghost: string, blankRow: boolean}|undefined} */
    let drawn
    let histIndex = history.length
    let candidates = []

    /** @returns {number} the terminal width; 80 when the stream does not know. */
    const width = () => (out.columns > 0 ? out.columns : 80)

    /** @returns {string} the plain-text prompt, for width maths. */
    const promptPlain = prompt.replaceAll(ANSI, '')

    /** Recompute candidates for the current buffer. */
    const refresh = () => {
      candidates = buffer.trim() === '' ? [] : suggest(buffer).slice(0, 24)
      if (selected >= candidates.length) selected = 0
    }

    /**
     * How many characters of the buffer a candidate replaces.
     * @param {object} c - the candidate.
     * @returns {number} the replaced length.
     */
    const replaceLen = c => c.replace ?? (/\s/.test(buffer) ? (buffer.split(/\s/).pop() ?? '').length : buffer.length)

    /** @returns {string} the ghost text shown after the cursor, or ''. */
    const ghost = () => {
      if (candidates.length === 0 || cursor !== buffer.length) return ''
      const c = candidates[selected]
      const typed = buffer.slice(buffer.length - replaceLen(c))
      return c.value.startsWith(typed) ? c.value.slice(typed.length) : ''
    }

    /** Erase everything this editor drew, leaving the cursor where the drawing began. */
    const erase = () => {
      // Climb only as far as the cursor sits below the top of the drawing: climbing further (as the
      // old bottom-of-dropdown count did) wiped earlier terminal output on every keystroke. The
      // rows are counted at today's width, so a resize since the last render is accounted for.
      let up = 0
      if (drawn !== undefined) {
        const w = width()
        for (const cols of drawn.above) up += Math.max(1, Math.ceil(cols / w))
        const L = layout(promptPlain, drawn.buffer, drawn.cursor, drawn.ghost, w)
        // The blank cursor row was a real newline: after a reflow it is still the row below the input.
        up += drawn.blankRow ? L.rows : L.cursorRow
      }
      if (up > 0) out.write(`${ESC}[${up}A`)
      out.write(`\r${ESC}[0J`)
      drawn = undefined
    }

    /** Draw the status line, the input line with its ghost, and the dropdown. */
    const render = () => {
      erase()
      const w = width()
      const g = ghost()
      // Every line but the input is clipped one column short of the width, so each takes exactly
      // one row; the input line may wrap, and its rows are counted below.
      const above = []
      if (status !== undefined) above.push(clip(`${DIM}${status}`, w - 1) + OFF)
      const input = `${prompt}${buffer}${g === '' ? '' : `${DIM}${g}${OFF}`}`
      const lines = []

      // The dropdown only appears when there is something to choose between.
      const visible = candidates.slice(
        Math.max(0, Math.min(selected - MAX_VISIBLE + 1, candidates.length - MAX_VISIBLE)),
        Math.max(MAX_VISIBLE, selected + 1),
      )
      const hintCol = Math.min(24, Math.max(...visible.map(c => c.value.length), 8) + 2)
      for (const c of visible) {
        const isSel = candidates[selected] === c
        const label = c.value.padEnd(hintCol)
        const hint = c.hint ?? ''
        lines.push(clip(isSel
          ? `${REV} ${label}${OFF}${DIM} ${hint}`
          : `${DIM} ${label} ${hint}`, w - 1) + OFF)
      }
      if (candidates.length > visible.length) {
        lines.push(clip(`${DIM} … ${candidates.length - visible.length} more`, w - 1) + OFF)
      }

      // The input may wrap over several rows; the dropdown goes below its last one. When the cursor
      // sits just past a row the text filled exactly, an explicit newline gives it a real, blank row
      // of its own (otherwise it would land on the dropdown, or nowhere).
      const L = layout(promptPlain, buffer, cursor, g, w)
      const blankRow = L.cursorRow === L.rows
      const parts = [...above, blankRow ? `${input}\r` : input]
      if (blankRow) parts.push('')
      out.write([...parts, ...lines].join('\n'))
      const bottom = above.length + L.rows - 1 + (blankRow ? 1 : 0) + lines.length

      // Put the cursor back on the input, at the editing cell (maybe on a wrapped row).
      const target = above.length + L.cursorRow
      if (bottom > target) out.write(`${ESC}[${bottom - target}A`)
      out.write('\r')
      if (L.cursorCol > 0) out.write(`${ESC}[${L.cursorCol}C`) // CSI 0 C still moves one column
      drawn = { above: above.map(visibleLength), buffer, cursor, ghost: g, blankRow }
    }

    /** Accept the highlighted candidate into the buffer. */
    const accept = () => {
      if (candidates.length === 0) return
      const c = candidates[selected]
      buffer = buffer.slice(0, buffer.length - replaceLen(c)) + c.value + (c.value.endsWith(' ') ? '' : ' ')
      cursor = buffer.length
      selected = 0
      refresh()
    }

    /**
     * Finish editing: leave the drawn area clean, restore the terminal, and hand back the line.
     * @param {string|null} value - the line, or null when cancelled.
     */
    const finish = value => {
      erase()
      out.write(value === null ? '' : `${prompt}${value}\n`)
      process.stdin.removeListener('keypress', onKey)
      out.removeListener('resize', onResize)
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
      process.stdin.pause()
      resolve(value)
    }

    /**
     * @param {string|undefined} str - the character produced, if any.
     * @param {{name?: string, ctrl?: boolean, meta?: boolean, sequence?: string}} key - the key.
     */
    const onKey = (str, key) => {
      const name = key?.name
      if (key?.ctrl === true && name === 'c') return finish(null)
      if (key?.ctrl === true && name === 'd' && buffer === '') return finish(null)

      switch (name) {
        case 'return':
        case 'enter':
          return finish(buffer)
        case 'tab':
          if (candidates.length > 0) accept()
          break
        case 'right':
          // Right at the end of the line accepts the ghost, like a shell autosuggestion.
          if (cursor === buffer.length && ghost() !== '') accept()
          else cursor = around(buffer, cursor).next
          break
        // Left, right, backspace and delete step over whole graphemes: half an emoji is garbage.
        case 'left': cursor = around(buffer, cursor).prev; break
        case 'home': cursor = 0; break
        case 'end': cursor = buffer.length; break
        case 'up':
          if (candidates.length > 0) selected = (selected - 1 + candidates.length) % candidates.length
          else if (histIndex > 0) { histIndex--; buffer = history[histIndex] ?? ''; cursor = buffer.length; refresh() }
          break
        case 'down':
          if (candidates.length > 0) selected = (selected + 1) % candidates.length
          else if (histIndex < history.length) { histIndex++; buffer = history[histIndex] ?? ''; cursor = buffer.length; refresh() }
          break
        case 'backspace':
          if (cursor > 0) { const { prev } = around(buffer, cursor); buffer = buffer.slice(0, prev) + buffer.slice(cursor); cursor = prev; refresh() }
          break
        case 'delete':
          if (cursor < buffer.length) { buffer = buffer.slice(0, cursor) + buffer.slice(around(buffer, cursor).next); refresh() }
          break
        case 'escape':
          candidates = []
          break
        default: {
          // Printable input only: control sequences must never land in the buffer.
          const ch = str
          if (ch === undefined || key?.ctrl === true || key?.meta === true) break
          // One code point per key (an emoji is two UTF-16 units); controls and DEL never.
          if ([...ch].length !== 1 || ch.codePointAt(0) < 0x20 || ch === '\u007f') break
          buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor)
          cursor += ch.length
          refresh()
        }
      }
      render()
    }

    /** The terminal changed width: redraw for it (erase counts the old rows at the new width). */
    const onResize = () => render()

    emitKeypressEvents(process.stdin)
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('keypress', onKey)
    out.on('resize', onResize)
    render()
  })
}

/**
 * Build the suggestion function the REPL uses: command names while the first word is being typed,
 * then that command's own arguments; for plain text (a task), recent tasks that start with it.
 * @param {Map<string, object>} commands - the loaded registry.
 * @param {() => Record<string, string[]>} argsFor - lazily supplies argument candidates per command.
 * @param {() => string[]} [recent] - supplies the input history, oldest first (T-303).
 * @returns {(buffer: string) => {value: string, hint?: string}[]} the suggester.
 */
export function makeSuggester(commands, argsFor, recent) {
  return buffer => {
    if (!buffer.startsWith('/')) return recent === undefined ? [] : recentTasks(recent(), buffer)
    const parts = buffer.split(/\s+/)
    const unique = [...new Set(commands.values())]

    if (parts.length === 1) {
      const typed = parts[0].slice(1).toLowerCase()
      return unique
        .filter(c => c.name.startsWith(typed))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(c => ({ value: `/${c.name}`, hint: c.summary, replace: buffer.length }))
    }

    const cmd = commands.get(parts[0].slice(1).toLowerCase())
    if (cmd === undefined) return []
    const word = parts[parts.length - 1].toLowerCase()
    const table = argsFor()
    const options = table[cmd.name] ?? []
    return options
      .filter(o => o.toLowerCase().startsWith(word))
      .slice(0, 24)
      .map(o => ({ value: o, hint: undefined, replace: word.length }))
  }
}
