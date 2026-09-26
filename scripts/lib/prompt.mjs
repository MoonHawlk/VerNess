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

const ESC = '\u001b'
const DIM = `${ESC}[2m`
const OFF = `${ESC}[0m`
const REV = `${ESC}[7m`
const CYAN = `${ESC}[36m`

/** Matches the ANSI escape sequences this editor and its callers emit. */
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

/**
 * @param {string} s - text that may carry ANSI escapes.
 * @returns {number} how many columns it occupies.
 */
const visibleLength = s => s.replaceAll(ANSI, '').length

/**
 * Cut a line to at most `max` visible columns, keeping its escapes, so it can never wrap.
 * @param {string} s - text that may carry ANSI escapes.
 * @param {number} max - the column budget.
 * @returns {string} the clipped text.
 */
const clip = (s, max) => {
  let cols = 0
  let res = ''
  for (let i = 0; i < s.length;) {
    const m = s.slice(i).match(/^\u001b\[[0-9;]*[A-Za-z]/)
    if (m !== null) { res += m[0]; i += m[0].length; continue }
    if (cols < max) { res += s[i]; cols++ }
    i++
  }
  return res
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
    // Rows between the top of what this editor drew and the row the terminal cursor is on now.
    let cursorRow = 0
    let histIndex = history.length
    let candidates = []

    /** @returns {number} the terminal width, with a sane floor for odd environments. */
    const width = () => Math.max(40, out.columns ?? 80)

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
      // old bottom-of-dropdown count did) wiped earlier terminal output on every keystroke.
      if (cursorRow > 0) out.write(`${ESC}[${cursorRow}A`)
      out.write(`\r${ESC}[0J`)
      cursorRow = 0
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
        lines.push(`${DIM} … ${candidates.length - visible.length} more${OFF}`)
      }

      // The input line may wrap. One that exactly fills its last row leaves the terminal cursor
      // parked there; when nothing follows it, an explicit newline makes the next row real so the
      // cursor maths below holds.
      const inputLen = visibleLength(input)
      const inputRows = Math.max(1, Math.ceil(inputLen / w))
      const fullLast = lines.length === 0 && inputLen > 0 && inputLen % w === 0
      out.write([...above, input, ...lines].join('\n') + (fullLast ? '\r\n' : ''))
      const bottom = above.length + inputRows - 1 + lines.length + (fullLast ? 1 : 0)

      // Put the cursor back on the input line, at the editing column (maybe on a wrapped row).
      const at = promptPlain.length + cursor
      const target = above.length + Math.floor(at / w)
      if (bottom > target) out.write(`${ESC}[${bottom - target}A`)
      out.write('\r')
      if (at % w > 0) out.write(`${ESC}[${at % w}C`) // CSI 0 C still moves one column
      cursorRow = target
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
          else cursor = Math.min(buffer.length, cursor + 1)
          break
        case 'left': cursor = Math.max(0, cursor - 1); break
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
          if (cursor > 0) { buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor); cursor--; refresh() }
          break
        case 'delete':
          if (cursor < buffer.length) { buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1); refresh() }
          break
        case 'escape':
          candidates = []
          break
        default: {
          // Printable input only: control sequences must never land in the buffer.
          const ch = str
          if (ch === undefined || key?.ctrl === true || key?.meta === true) break
          if (ch.length !== 1 || ch.codePointAt(0) < 0x20) break
          buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor)
          cursor++
          refresh()
        }
      }
      render()
    }

    emitKeypressEvents(process.stdin)
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('keypress', onKey)
    render()
  })
}

/**
 * Build the suggestion function the REPL uses: command names while the first word is being typed,
 * then that command's own arguments.
 * @param {Map<string, object>} commands - the loaded registry.
 * @param {() => Record<string, string[]>} argsFor - lazily supplies argument candidates per command.
 * @returns {(buffer: string) => {value: string, hint?: string}[]} the suggester.
 */
export function makeSuggester(commands, argsFor) {
  return buffer => {
    if (!buffer.startsWith('/')) return []
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
