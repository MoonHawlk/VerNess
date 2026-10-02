/**
 * Long-line cases for the inline editor (T-302), driven by `prompt.simulated-tty.test.mjs`.
 *
 * Every key is emitted synchronously and the whole screen is checked after it, on a small VT that
 * auto-wraps (deferred, like xterm/conhost), knows two-column characters, and reflows on resize the
 * way Windows Terminal, conhost and the macOS terminals do. The VT has its own width rule, so it does
 * not just echo the editor's maths back. It rejects any escape the editor is not allowed to use.
 * @module scripts/test/prompt.long-lines
 */
import { readLineWithSuggestions } from '../lib/prompt.mjs'

/**
 * @param {string} ch - one code point.
 * @returns {number} its columns on the simulated terminal: 2 for CJK, Hangul, fullwidth and emoji.
 */
const simWidth = ch => {
  const cp = ch.codePointAt(0) ?? 0
  const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1faff)
  return wide ? 2 : 1
}

/** A minimal VT: rows of cells, a cursor, deferred auto-wrap, soft-wrap marks for reflow. */
class VT {
  /** @param {number} cols - the width. */
  constructor(cols) {
    this.cols = cols
    /** @type {(string|undefined)[][]} a cell is a character, '' for the right half of a wide one. */
    this.rows = [[]]
    /** @type {boolean[]} row i continues on row i+1 because the terminal wrapped it. */
    this.soft = [false]
    this.r = 0
    this.c = 0
  }

  /** @param {number} r - a row index. @returns {(string|undefined)[]} that row, created on demand. */
  row(r) {
    while (this.rows.length <= r) { this.rows.push([]); this.soft.push(false) }
    return this.rows[r]
  }

  /** @param {string} text - terminal output. */
  write(text) {
    for (let i = 0; i < text.length;) {
      const m = /^\u001b\[([0-9;]*)([A-Za-z])/.exec(text.slice(i))
      if (m !== null) {
        const n = m[1] === '' ? 1 : Math.max(1, Number(m[1]))
        if (m[2] === 'A') { this.r = Math.max(0, this.r - n); this.c = Math.min(this.c, this.cols - 1) }
        else if (m[2] === 'C') this.c = Math.min(this.cols - 1, this.c + n)
        else if (m[2] === 'J' && m[1] === '0') {
          this.row(this.r).length = Math.min(this.c, this.row(this.r).length)
          this.rows.length = this.r + 1
          this.soft.length = this.r + 1
          this.soft[this.r] = false
        } else if (m[2] !== 'm') throw new Error(`escape not allowed in the editor: ${JSON.stringify(m[0])}`)
        i += m[0].length
        continue
      }
      const ch = String.fromCodePoint(text.codePointAt(i) ?? 0)
      i += ch.length
      if (ch === '\r') this.c = 0
      else if (ch === '\n') { this.r++; this.c = 0; this.row(this.r) } // raw mode keeps ONLCR
      else {
        const w = simWidth(ch)
        if (this.c + w > this.cols) { this.soft[this.r] = true; this.r++; this.c = 0 }
        const row = this.row(this.r)
        row[this.c] = ch
        if (w === 2) row[this.c + 1] = ''
        this.c += w
      }
    }
  }

  /**
   * Change the width and reflow: soft-wrapped rows join into lines, which re-wrap at the new width;
   * the cursor keeps its place in its line.
   * @param {number} cols - the new width.
   */
  resize(cols) {
    /** @type {{cells: (string|undefined)[], cur?: number}[]} */
    const lines = []
    let cur = /** @type {{cells: (string|undefined)[], cur?: number}|null} */ (null)
    for (let r = 0; r < this.rows.length; r++) {
      cur ??= { cells: [] }
      let cells = [...this.rows[r]]
      if (this.soft[r]) while (cells.length > 0 && cells[cells.length - 1] === undefined) cells.pop()
      if (r === this.r) {
        cur.cur = cur.cells.length + this.c
        while (cells.length < this.c) cells.push(undefined)
      }
      cur.cells.push(...cells)
      if (!this.soft[r]) { lines.push(cur); cur = null }
    }
    if (cur !== null) lines.push(cur)
    this.cols = cols
    this.rows = []
    this.soft = []
    for (const line of lines) {
      let r = this.rows.length
      let c = 0
      this.row(r)
      line.cells.forEach((cell, k) => {
        if (cell === '') return
        const w = cell === undefined ? 1 : simWidth(cell)
        if (c + w > cols) { this.soft[r] = true; r++; c = 0; this.row(r) }
        if (line.cur === k) { this.r = r; this.c = c }
        this.row(r)[c] = cell
        if (w === 2) this.row(r)[c + 1] = ''
        c += w
      })
      if (line.cur !== undefined && line.cur >= line.cells.length) { this.r = r; this.c = c }
    }
  }

  /** @returns {string[]} the screen as text, trailing blanks trimmed. */
  text() {
    return this.rows.map(row => Array.from(row, x => x ?? ' ').join('').trimEnd())
  }

  /**
   * @param {number} from - the first row of a line.
   * @returns {{text: string, next: number}} the logical line starting there and the row after it.
   */
  line(from) {
    let text = ''
    let r = from
    for (; r < this.rows.length; r++) {
      const cells = [...this.rows[r]]
      if (this.soft[r]) while (cells.length > 0 && cells[cells.length - 1] === undefined) cells.pop()
      text += Array.from(cells, x => x ?? ' ').join('')
      if (!this.soft[r]) break
    }
    return { text, next: r + 1 }
  }

  /** @returns {string|undefined} the character under the cursor. */
  under() {
    const cell = this.rows[this.r]?.[this.c]
    return cell === '' ? undefined : cell
  }

  /** @returns {string|undefined} the character just before the cursor, across a soft wrap. */
  before() {
    let r = this.r
    let c = this.c - 1
    for (;;) {
      if (c < 0) {
        if (r === 0 || !this.soft[r - 1]) return undefined
        r--
        c = this.rows[r].length - 1
        continue
      }
      const cell = this.rows[r][c]
      if (cell !== '' && cell !== undefined) return cell
      c--
    }
  }
}

/**
 * @param {string} s - text.
 * @returns {string[]} its graphemes (the test's own split, for the expected buffer).
 */
const graphemes = s => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), x => x.segment)

const COMMANDS = ['/decide', '/decision', '/dashboard', '/doctor', '/run']
const ARGS = ['argument', 'arguments', 'archive', 'area', 'array', 'arrow', 'artifact', 'arc']

/**
 * Slash commands for the first word, ARGS for a later word starting "ar"; nothing for plain text,
 * so Up/Down walk history rather than a dropdown.
 * @param {string} buffer - the line.
 * @returns {{value: string, hint?: string, replace: number}[]} candidates.
 */
const suggest = buffer => {
  if (!buffer.startsWith('/')) return []
  if (!/\s/.test(buffer)) {
    return COMMANDS.filter(c => c.startsWith(buffer)).map(value => ({ value, hint: `the ${value.slice(1)} command`, replace: buffer.length }))
  }
  const word = buffer.split(/\s/).pop() ?? ''
  if (word === '') return []
  return ARGS.filter(a => a.startsWith(word)).map(value => ({ value, replace: word.length }))
}

const PROMPT = 'finess> '
const EARLIER = ['earlier output one', 'earlier output two']

/**
 * Run one editor session on a fresh VT and check the screen after every key.
 * @param {string} name - the case name.
 * @param {number} cols - the starting width.
 * @param {(api: object) => void} script - drives the keys.
 * @param {{history?: string[], status?: string}} [opts] - editor options.
 * @returns {Promise<{ok: boolean, why: string, line: string|null}>} the verdict.
 */
async function session(name, cols, script, opts = {}) {
  const vt = new VT(cols)
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true })
  process.stdout.write = c => { vt.write(String(c)); return true }
  vt.write(EARLIER.join('\n') + '\n')
  const status = opts.status ?? '  persona · model · session'
  const keyBase = process.stdin.listenerCount('keypress')
  const resizeBase = process.stdout.listenerCount('resize')

  let buffer = ''
  let cursor = 0
  let closed = false
  let why = ''
  let step = 0

  /** Compare the screen with the expected buffer, cursor and dropdown. */
  const check = label => {
    step++
    const fail = msg => { if (why === '') why = `step ${step} (${label}): ${msg}\n${vt.text().map(l => `      |${l}|`).join('\n')}\n      cursor ${vt.r},${vt.c}` }
    const t = vt.text()
    if (t[0] !== EARLIER[0] || t[1] !== EARLIER[1]) return fail('earlier output was damaged')
    if (!t[2].startsWith(status.slice(0, 10)) || t[2].length >= vt.cols) return fail('status row wrong')
    const input = vt.line(3)
    if (!input.text.startsWith(PROMPT + buffer)) return fail(`input row shows ${JSON.stringify(input.text)}`)
    const rest = input.text.slice((PROMPT + buffer).length)
    const n = closed || buffer.trim() === '' ? 0 : suggest(buffer).length
    if (rest !== '' && !suggest(buffer).some(c => c.value.endsWith(rest))) return fail(`stray text after the buffer: ${JSON.stringify(rest)}`)
    let below = vt.rows.length - input.next
    // A line that exactly fills its last row gets one blank row for the cursor.
    if (below > 0 && t[input.next] === '' && vt.r === input.next) below--
    const want = Math.min(n, 6) + (n > 6 ? 1 : 0)
    if (below !== want) return fail(`expected ${want} dropdown row(s), found ${below}`)
    if (vt.r < 3 || vt.r > input.next) return fail('cursor is outside the input')
    if (vt.r === input.next && !(t[input.next] === '' && cursor === buffer.length)) return fail('cursor sits on the dropdown')
    const g = graphemes(buffer)
    const idx = graphemes(buffer.slice(0, cursor)).length
    if (idx < g.length) { if (vt.under() !== g[idx]) return fail(`cursor over ${JSON.stringify(vt.under())}, want ${JSON.stringify(g[idx])}`) }
    else if (vt.r === input.next) { if (vt.c !== 0 || rest !== '') return fail('cursor on the blank row but not at its start') }
    else if (g.length > 0 && vt.before() !== g[g.length - 1]) return fail(`cursor after ${JSON.stringify(vt.before())}, want ${JSON.stringify(g[g.length - 1])}`)
    if (idx === g.length && rest === '' && vt.under() !== undefined) return fail('cursor at the end is over text')
  }

  const emit = (name, str) => process.stdin.emit('keypress', str, { name, sequence: str })
  const api = {
    /** @param {string} s - characters to type, one keypress per code point. */
    type(s) {
      for (const ch of s) {
        emit(undefined, ch)
        buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor)
        cursor += ch.length
        closed = false
        check(`type ${ch}`)
      }
    },
    /**
     * @param {string} key - a key name.
     * @param {number} [times] - repeat count.
     * @param {{buffer?: string, cursor?: number}} [expect] - the state after it, for keys the
     *   harness does not model (tab, history).
     */
    press(key, times = 1, expect = {}) {
      for (let i = 0; i < times; i++) {
        emit(key, key === 'tab' ? '\t' : undefined)
        const g = graphemes(buffer)
        const idx = graphemes(buffer.slice(0, cursor)).length
        const at = k => g.slice(0, k).join('').length
        if (key === 'left') cursor = at(Math.max(0, idx - 1))
        if (key === 'right' && idx < g.length) cursor = at(idx + 1)
        if (key === 'home') cursor = 0
        if (key === 'end') cursor = buffer.length
        if (key === 'backspace' && idx > 0) { buffer = buffer.slice(0, at(idx - 1)) + buffer.slice(cursor); cursor = at(idx - 1); closed = false }
        if (key === 'delete' && idx < g.length) { buffer = buffer.slice(0, cursor) + buffer.slice(at(idx + 1)); closed = false }
        if (key === 'escape') closed = true
        if (expect.buffer !== undefined) { buffer = expect.buffer; cursor = expect.cursor ?? buffer.length; closed = false }
        check(key)
      }
    },
    /** @param {number} to - the new width; the VT reflows, then the editor hears 'resize'. */
    resize(to) {
      vt.resize(to)
      Object.defineProperty(process.stdout, 'columns', { value: to, configurable: true })
      process.stdout.emit('resize')
      check(`resize ${to}`)
    },
    vt,
  }

  const done = readLineWithSuggestions({ prompt: PROMPT, status, suggest, history: opts.history })
  check('first render')
  try { script(api) } catch (e) { why ||= `threw: ${e.stack}` }
  emit('return', '\r')
  const line = await done
  if (line !== buffer && why === '') why = `returned ${JSON.stringify(line)}, want ${JSON.stringify(buffer)}`
  const after = vt.text().slice(2)
  if (why === '' && vt.line(2).text !== PROMPT + buffer) why = `left ${JSON.stringify(after)} after Enter`
  if (why === '' && vt.rows.length !== vt.line(2).next + 1) why = `left extra rows after Enter: ${JSON.stringify(after)}`
  if (process.stdin.listenerCount('keypress') !== keyBase) why ||= 'keypress listener leaked'
  if (process.stdout.listenerCount('resize') !== resizeBase) why ||= 'resize listener leaked'
  return { ok: why === '', why: why === '' ? '' : `${name}: ${why}`, line }
}

const LONG = 'the quick brown fox jumps over the lazy dog and keeps running past the edge'

/**
 * Every long-line case, at widths 40 and 80.
 * @param {(s: string) => boolean} log - the real stdout write, for failure details.
 * @returns {Promise<Record<string, boolean>>} check label → passed.
 */
export async function longLineCases(log) {
  const write = process.stdout.write
  /** @type {[string, number, (api: any) => void, object?][]} */
  const cases = []
  for (const w of [40, 80]) {
    cases.push(
      [`w${w}: typing past the edge keeps the cursor after the last character`, w, a => a.type(`/run ${LONG}`)],
      [`w${w}: a line that exactly fills the row puts the cursor on the next row`, w, a => {
        a.type('/run ' + 'x'.repeat(w - PROMPT.length - 5))
        a.type('y')
      }],
      [`w${w}: a full row with the dropdown open and no ghost keeps the cursor off the dropdown`, w, a => {
        a.type('/run ' + 'x'.repeat(w - PROMPT.length - 5 - 4) + ' arc')
        a.press('down') // "arc" itself: nothing left to ghost
        a.press('left')
        a.press('right')
        a.press('tab', 1, { buffer: '/run ' + 'x'.repeat(w - PROMPT.length - 5 - 4) + ' arc ' })
      }],
      [`w${w}: backspace across the wrap`, w, a => { a.type(`/run ${LONG}`); a.press('backspace', LONG.length - 10) }],
      [`w${w}: left/right/home/end across the wrap, insert and delete mid-line`, w, a => {
        a.type(`/run ${LONG}`)
        a.press('left', 50)
        a.type('ZZ')
        a.press('right', 3)
        a.press('delete', 2)
        a.press('home')
        a.press('right', w - 2)
        a.press('backspace', 3)
        a.press('end')
      }],
      [`w${w}: dropdown opens below a wrapped line, arrows and escape`, w, a => {
        a.type(`/run ${LONG} ar`)
        a.press('down', 3)
        a.press('up', 1)
        a.press('escape')
        a.type('r')
      }],
      [`w${w}: tab accepts a suggestion on a wrapped line, then typing continues`, w, a => {
        a.type(`/run ${LONG} ar`)
        a.press('down')
        a.press('tab', 1, { buffer: `/run ${LONG} arguments ` })
        a.press('tab') // nothing to accept: a no-op, and never a tab character
        a.type('ar')
        a.press('tab', 1, { buffer: `/run ${LONG} arguments argument ` })
        a.type('done')
      }],
      [`w${w}: tab with no candidates does nothing`, w, a => { a.type('plain words '); a.press('tab', 2); a.type('more') }],
      [`w${w}: history recalls long and short lines cleanly`, w, a => {
        const h = [`a short one`, `a ${LONG} ${LONG}`]
        a.press('up', 1, { buffer: h[1] })
        a.press('up', 1, { buffer: h[0] })
        a.press('down', 1, { buffer: h[1] })
        a.press('down', 1, { buffer: '' })
        a.press('up', 1, { buffer: h[1] })
        a.press('left', 30)
      }, { history: [`a short one`, `a ${LONG} ${LONG}`] }],
      [`w${w}: wide and emoji characters wrap without corrupting`, w, a => {
        a.type('a')
        a.type('漢字かな🙂'.repeat(Math.ceil(w / 8)))
        a.press('left', 7)
        a.type('🙂x')
        a.press('backspace', 3)
        a.press('end')
        a.press('backspace', 2)
      }],
    )
  }
  cases.push(
    ['resize 80 → 40 → 80 with the dropdown open on a wrapped line', 80, a => {
      a.type(`/run ${LONG} ar`)
      a.resize(40)
      a.type('r')
      a.resize(80)
      a.press('left', 20)
      a.resize(40)
      a.resize(80)
      a.press('end')
      a.press('tab', 1, { buffer: `/run ${LONG} array ` })
    }],
    ['resize 40 → 80 → 40 keeps earlier output', 40, a => {
      a.type(`/run ${LONG}${LONG}`)
      a.resize(80)
      a.resize(40)
      a.press('backspace', 5)
    }],
    ['a terminal narrower than forty columns', 30, a => { a.type(`/run ${LONG}`); a.press('left', 35); a.press('end') }],
  )

  const res = {}
  for (const [name, w, script, opts] of cases) {
    const r = await session(name, w, script, opts)
    res[`long lines: ${name}`] = r.ok
    if (!r.ok) { process.stdout.write = write; log(`${r.why}\n`) }
  }
  process.stdout.write = write
  return res
}
