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
    let drawnLines = 0
    let histIndex = history.length
    let candidates = []

    /** @returns {number} the terminal width, with a sane floor for odd environments. */
    const width = () => Math.max(40, out.columns ?? 80)

    /** @returns {string} the plain-text prompt, for width maths. */
    const promptPlain = prompt.replaceAll(/\u001b\[[0-9;]*m/g, '')

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
      if (drawnLines > 0) out.write(`${ESC}[${drawnLines}A`)
      out.write(`\r${ESC}[0J`)
      drawnLines = 0
    }

    /** Draw the status line, the input line with its ghost, and the dropdown. */
    const render = () => {
      erase()
      const g = ghost()
      const lines = []
      if (status !== undefined) lines.push(`${DIM}${status}${OFF}`)
      lines.push(`${prompt}${buffer}${g === '' ? '' : `${DIM}${g}${OFF}`}`)

      // The dropdown only appears when there is something to choose between.
      const visible = candidates.slice(
        Math.max(0, Math.min(selected - MAX_VISIBLE + 1, candidates.length - MAX_VISIBLE)),
        Math.max(MAX_VISIBLE, selected + 1),
      )
      const hintCol = Math.min(24, Math.max(...visible.map(c => c.value.length), 8) + 2)
      for (const c of visible) {
        const isSel = candidates[selected] === c
        const label = c.value.padEnd(hintCol)
        const hint = c.hint === undefined ? '' : c.hint.slice(0, Math.max(0, width() - hintCol - 4))
        lines.push(isSel
          ? `${REV} ${label}${OFF}${DIM} ${hint}${OFF}`
          : `${DIM} ${label} ${hint}${OFF}`)
      }
      if (candidates.length > visible.length) {
        lines.push(`${DIM} … ${candidates.length - visible.length} more${OFF}`)
      }

      out.write(lines.join('\n'))
      drawnLines = lines.length - 1

      // Put the cursor back on the input line, at the editing column.
      const inputRow = status === undefined ? 0 : 1
      const below = drawnLines - inputRow
      if (below > 0) out.write(`${ESC}[${below}A`)
      out.write(`\r${ESC}[${promptPlain.length + cursor}C`)
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
