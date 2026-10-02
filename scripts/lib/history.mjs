/**
 * The REPL's input history, persisted so Up/Down and recent-task suggestions survive a restart.
 * JSON lines, one string each, oldest first, deduplicated (the newest copy wins) and capped.
 *
 * Source decision (T-303): the backlog says "from the session logs", but reading every log on each
 * keystroke is too slow and the logs also hold composed tasks (notes, briefs, attached files). What
 * the operator typed is the REPL's own input, so that is what is stored, at `.finess/history.jsonl`
 * (git-ignored), read once at start-up and kept in memory.
 * @module scripts/lib/history
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Lines that look like they carry a credential are never written to disk. */
const SECRETISH = /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]|\bsk-[A-Za-z0-9_-]{16,}|\bBearer\s+\S{16,}/i

/**
 * @param {string} line - a submitted line.
 * @returns {boolean} true when the line may be persisted.
 */
export function storable(line) {
  return line.trim() !== '' && !SECRETISH.test(line)
}

/**
 * @param {string} file - the history file.
 * @param {number} [max] - how many lines to keep.
 * @returns {string[]} history, oldest first; [] when the file is missing or unreadable.
 */
export function loadHistory(file, max = 500) {
  let raw
  try {
    // A byte-order mark (an editor on Windows) must not make the first line unparseable.
    raw = readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)
  } catch {
    return []
  }
  const lines = []
  for (const l of raw) {
    if (l.trim() === '') continue
    try {
      const v = JSON.parse(l)
      if (typeof v === 'string') lines.push(v)
    } catch { /* a torn or hand-edited line is skipped, not fatal */ }
  }
  const seen = new Set()
  const out = []
  for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
    if (!seen.has(lines[i])) { seen.add(lines[i]); out.push(lines[i]) }
  }
  return out.reverse()
}

/**
 * Append a line (moving an earlier copy to the end) and keep the last `max`.
 * Lines that look like they carry a credential are skipped. Write failures are swallowed: history
 * is a convenience and must never break the REPL.
 * @param {string} file - the history file.
 * @param {string} line - the submitted line.
 * @param {number} [max] - how many lines to keep.
 */
export function appendHistory(file, line, max = 500) {
  if (!storable(line)) return
  const next = [...loadHistory(file, max).filter(l => l !== line), line].slice(-max)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${next.map(l => JSON.stringify(l)).join('\n')}\n`, 'utf8')
  } catch { /* read-only checkout, full disk: keep going without persistence */ }
}

/**
 * Recent plain tasks (no leading `/` or `#`) that start with what is typed, newest first.
 * @param {string[]} recent - history, oldest first.
 * @param {string} buffer - the current input.
 * @param {number} [limit] - most candidates returned.
 * @returns {{value: string, hint: string, replace: number}[]} the candidates.
 */
export function recentTasks(recent, buffer, limit = 6) {
  if (buffer.startsWith('/') || buffer.startsWith('#') || buffer.trim().length < 3) return []
  const b = buffer.toLowerCase()
  const out = []
  const seen = new Set()
  for (let i = recent.length - 1; i >= 0 && out.length < limit; i--) {
    const l = recent[i]
    if (l.startsWith('/') || l.startsWith('#') || l === buffer || seen.has(l)) continue
    if (!l.toLowerCase().startsWith(b)) continue
    seen.add(l)
    out.push({ value: l, hint: 'recent', replace: buffer.length })
  }
  return out
}
