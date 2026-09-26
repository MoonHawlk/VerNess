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
process.stdout.write = realWrite

const out = chunks.join('')
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
}
let bad = 0
for (const [k, v] of Object.entries(checks)) {
  if (!v) bad++
  console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`)
}
console.log(`\nreturned: ${JSON.stringify(line)}`)
process.exit(bad === 0 ? 0 : 1)
