/**
 * Drive the inline editor with a simulated terminal: fake TTY flags, a captured stdout, and
 * synthetic keypress events. Proves the rendering path, not just that the module parses.
 */
import { readLineWithSuggestions } from '../lib/prompt.mjs'

const chunks = []
const realWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = c => { chunks.push(String(c)); return true }
Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true })
Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
process.stdin.setRawMode = () => process.stdin

const suggest = buffer => {
  if (!buffer.startsWith('/')) return []
  const all = [
    { value: '/decide', hint: 'route a task with the decision model' },
    { value: '/decision', hint: 'decision engine lifecycle' },
    { value: '/dashboard', hint: 'build and open the dashboard' },
    { value: '/doctor', hint: 'what is installed' },
  ]
  const typed = buffer.toLowerCase()
  return all.filter(c => c.value.startsWith(typed)).map(c => ({ ...c, replace: buffer.length }))
}

const key = (name, str) => process.stdin.emit('keypress', str, { name, sequence: str })

const done = readLineWithSuggestions({ prompt: 'verness> ', status: '  persona · model · session', suggest })

setTimeout(() => key(undefined, '/'), 10)
setTimeout(() => key(undefined, 'd'), 20)
setTimeout(() => key(undefined, 'e'), 30)
setTimeout(() => key('down'), 40)      // move to /decision
setTimeout(() => key('tab'), 50)       // accept it
setTimeout(() => key('return'), 60)

const line = await done
const out = chunks.join('')

/**
 * A minimal VT screen: enough of \r, \n, CUU (A), CUF (C), ED (0J) and auto-wrap to replay what
 * the editor wrote and see what the user would be left looking at.
 * @param {string} text - everything written to the terminal.
 * @param {number} cols - the terminal width.
 * @returns {string[]} the screen rows.
 */
const screen = (text, cols) => {
  const rows = [[]]
  let r = 0
  let c = 0
  for (let i = 0; i < text.length;) {
    const m = text.slice(i).match(/^\u001b\[([0-9;]*)([A-Za-z])/)
    if (m !== null) {
      const n = m[1] === '' ? 1 : Math.max(1, Number(m[1]))
      if (m[2] === 'A') r = Math.max(0, r - n)
      if (m[2] === 'C') c = Math.min(cols - 1, c + n)
      if (m[2] === 'J') { rows[r].length = c; rows.length = r + 1 }
      i += m[0].length
      continue
    }
    const ch = text[i++]
    if (ch === '\r') c = 0
    else if (ch === '\n') { r++; c = 0; rows[r] ??= [] } // raw mode keeps ONLCR: \n is CRLF
    else {
      if (c >= cols) { c = 0; r++; rows[r] ??= [] }
      rows[r][c++] = ch
    }
  }
  return rows.map(x => Array.from(x, ch => ch ?? ' ').join(''))
}

// Regression: typing with the dropdown open used to climb past the drawing and erase whatever the
// terminal showed above the prompt. Replay a session behind some earlier output and a narrow width.
chunks.length = 0
Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true })
process.stdout.write('earlier line one\nearlier line two\n')
const done2 = readLineWithSuggestions({ prompt: 'verness> ', status: '  a status line long enough to need clipping at forty', suggest })
for (const [i, ch] of [...'/de'].entries()) setTimeout(() => key(undefined, ch), 10 + i * 10)
setTimeout(() => key('down'), 50)
setTimeout(() => key('backspace'), 60)
for (const [i, ch] of [...' a long argument that wraps the input row'].entries()) setTimeout(() => key(undefined, ch), 70 + i * 2)
setTimeout(() => key('return'), 200)
await done2
const replay = screen(chunks.join(''), 40)
process.stdout.write = realWrite

const plain = out.replaceAll(/\u001b\[[0-9;]*[A-Za-z]/g, '')
const checks = {
  'rendered the prompt': plain.includes('verness> '),
  'rendered the status line': plain.includes('persona · model · session'),
  'dropdown listed /decide': plain.includes('/decide'),
  'dropdown listed /decision': plain.includes('/decision'),
  'showed a hint': plain.includes('decision engine lifecycle'),
  'filtered on typing (no /doctor after "de")': !plain.split('/de')[2]?.includes('/doctor'),
  'used reverse video for selection': out.includes('\u001b[7m'),
  'used dim for ghost/hints': out.includes('\u001b[2m'),
  'cleared between renders': out.includes('\u001b[0J'),
  'accepted the highlighted item (trailing space is intentional)': line.trim() === '/decision',
  'kept the output printed before the prompt': replay[0] === 'earlier line one' && replay[1] === 'earlier line two',
  'left only the submitted line below it': replay.slice(2).join('').replaceAll(' ', '') === 'verness>/d along argument that wraps the input row'.replaceAll(' ', ''),
}
let bad = 0
for (const [k, v] of Object.entries(checks)) {
  if (!v) bad++
  console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`)
}
console.log(`\nreturned: ${JSON.stringify(line)}`)
process.exit(bad === 0 ? 0 : 1)
