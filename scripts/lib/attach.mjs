/**
 * Local context for a REPL task, gathered at zero model cost (T-181, T-447):
 * - `!<cmd>` runs a shell command here and prints its output; `!!<cmd>` also attaches it to the next task.
 * - `@path` in a task attaches that file (or a directory's listing); `@https://...` attaches the page as text.
 *
 * Pure apart from the injected `fs`, `fetch` and `spawn`, so every rule is unit-tested.
 *
 * Caps are characters, not bytes, and sized for Windows: the task reaches the substrate as one argv
 * element, and CreateProcess refuses a command line past 32,767 UTF-16 units. So the totals here stay
 * well under that on every platform, with room for the brief and `/btw` notes.
 * @module scripts/lib/attach
 */

import { resolve } from 'node:path'

/** Default caps, in characters. */
export const CAPS = { perItem: 12000, total: 20000, dirEntries: 200, fetchBytes: 2 * 1024 * 1024, fetchMs: 10000 }

/** The longest composed task the launcher hands to the substrate (Windows command-line limit, with margin). */
export const MAX_TASK_CHARS = 30000

/**
 * @typedef {{label: string, body: string, truncated?: boolean}} Attachment
 * @typedef {{kind: 'file'|'dir'|'url', ref: string}} Ref
 */

/**
 * The shell for `!<cmd>`, as an executable plus an args array: `cmd.exe` on Windows, `/bin/sh` elsewhere.
 * On Windows the line is passed verbatim inside one pair of quotes (`/s` strips them), which is how
 * Node itself drives `cmd.exe`; escaping it any other way would change what the user typed.
 * @param {string} line - the command as typed.
 * @param {string} [platform] - `process.platform` by default.
 * @returns {{file: string, args: string[], verbatim: boolean}} what to spawn.
 */
export function shellSpec(line, platform = process.platform) {
  if (platform === 'win32') return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
  return { file: '/bin/sh', args: ['-c', line], verbatim: false }
}

/**
 * Run `!<cmd>` and capture its output. stdin is closed so a piped REPL keeps its own lines.
 * @param {string} line - the command.
 * @param {{cwd: string, spawnSync: Function, platform?: string, timeoutMs?: number}} opts - where and how.
 * @returns {{code: number, out: string, timedOut: boolean, error?: string}} exit status and stdout+stderr.
 */
export function runShell(line, opts) {
  const { file, args, verbatim } = shellSpec(line, opts.platform)
  const r = opts.spawnSync(file, args, {
    cwd: opts.cwd, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: verbatim,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeoutMs ?? 120000, maxBuffer: 16 * 1024 * 1024,
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\s+$/, '')
  const timedOut = r.error?.code === 'ETIMEDOUT'
  return { code: r.status ?? 1, out, timedOut, ...(r.error !== undefined && !timedOut ? { error: r.error.message } : {}) }
}

/**
 * The output of `!!<cmd>` as an attachment, capped.
 * @param {string} line - the command.
 * @param {{code: number, out: string}} res - what `runShell` returned.
 * @param {number} [cap] - characters kept.
 * @returns {Attachment} the attachment.
 */
export function shellAttachment(line, res, cap = CAPS.perItem) {
  const { text, truncated } = clip(res.out, cap)
  return { label: `$ ${line} (exit ${res.code})`, body: text, truncated }
}

/**
 * Find the `@` references in a task. `@` counts only at the start or after whitespace or an opening
 * bracket/quote, so `me@example.com` never expands. `@"a b.txt"` quotes a path with spaces. Trailing
 * sentence punctuation is dropped (`see @a.txt.` means `a.txt`); the raw form is kept as a fallback.
 * @param {string} text - the task.
 * @returns {{raw: string, ref: string, alt?: string, url: boolean}[]} each reference in order, deduplicated.
 */
export function findRefs(text) {
  const seen = new Set()
  const found = []
  const re = /(^|[\s(\[{'"`])@(?:"([^"]+)"|([^\s"'`]+))/g
  for (const m of String(text).matchAll(re)) {
    const quoted = m[2]
    const bare = m[3]
    const raw = quoted ?? bare
    const ref = quoted ?? bare.replace(/[.,;:!?)\]}]+$/, '')
    if (ref === '' || seen.has(ref)) continue
    seen.add(ref)
    const url = /^https?:\/\//i.test(ref)
    found.push({ raw: `@${quoted === undefined ? bare : `"${quoted}"`}`, ref, url, ...(ref !== raw && !url ? { alt: raw } : {}) })
  }
  return found
}

/**
 * Keep at most `cap` characters.
 * @param {string} text - the text.
 * @param {number} cap - the limit.
 * @returns {{text: string, truncated: boolean}} the kept text.
 */
function clip(text, cap) {
  const s = String(text)
  return s.length <= cap ? { text: s, truncated: false } : { text: s.slice(0, Math.max(0, cap)), truncated: true }
}

/** @param {Uint8Array} buf - file bytes. @returns {boolean} whether it looks binary (a NUL in the first 8 KB). */
export const looksBinary = buf => buf.subarray(0, 8192).includes(0)

/**
 * HTML to readable text: scripts, styles and comments dropped, block ends become newlines, tags
 * removed, the common entities decoded, blank runs collapsed.
 * @param {string} html - the page.
 * @returns {string} its text.
 */
export function htmlToText(html) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|pre|blockquote|title)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        try { return String.fromCodePoint(n) } catch { return all }
      }
      return named[e.toLowerCase()] ?? all
    })
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Read a local reference: a text file's contents, or a directory's entries (`name/` for directories).
 * @param {string} abs - the absolute path.
 * @param {object} fs - `{statSync, readFileSync, readdirSync}`.
 * @param {number} cap - characters kept.
 * @returns {{kind: 'file'|'dir', body: string, truncated: boolean} | {refused: string} | undefined} undefined when it does not exist.
 */
function readLocal(abs, fs, cap) {
  let st
  try { st = fs.statSync(abs) } catch { return undefined }
  if (st.isDirectory()) {
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => a.localeCompare(b))
    const shown = entries.slice(0, CAPS.dirEntries)
    const more = entries.length - shown.length
    const { text, truncated } = clip([...shown, ...(more > 0 ? [`... ${more} more`] : [])].join('\n'), cap)
    return { kind: 'dir', body: text === '' ? '(empty directory)' : text, truncated: truncated || more > 0 }
  }
  if (!st.isFile()) return { refused: 'not a regular file' }
  const buf = fs.readFileSync(abs)
  if (looksBinary(buf)) return { refused: 'binary file' }
  const { text, truncated } = clip(Buffer.from(buf).toString('utf8').replace(/^﻿/, ''), cap)
  return { kind: 'file', body: text, truncated }
}

/**
 * Fetch a URL as text, with no cookies, auth or referrer, and a hard timeout.
 * @param {string} url - an http(s) URL without credentials.
 * @param {Function} fetchFn - `fetch`.
 * @param {{fetchMs: number, fetchBytes: number}} caps - timeout and raw-size cap.
 * @returns {Promise<{body: string, type: string} | {refused: string}>} the text, or why not.
 */
async function fetchText(url, fetchFn, caps) {
  let res
  try {
    res = await fetchFn(url, {
      redirect: 'follow', credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: { 'user-agent': 'FiNess (+@url attachment)', accept: 'text/html,text/plain,application/json,*/*;q=0.5' },
      signal: AbortSignal.timeout(caps.fetchMs),
    })
  } catch (e) {
    return { refused: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `timed out after ${caps.fetchMs / 1000} s` : `fetch failed: ${e?.message ?? e}` }
  }
  if (!res.ok) return { refused: `HTTP ${res.status}` }
  const type = String(res.headers.get('content-type') ?? '').toLowerCase()
  const textual = type === '' || /^text\/|json|xml|javascript|yaml|csv/.test(type)
  if (!textual) return { refused: `not text (${type})` }
  // Read at most `fetchBytes` raw bytes, so a huge page never sits in memory whole.
  const chunks = []
  let size = 0
  if (res.body?.getReader !== undefined) {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.length
      if (size >= caps.fetchBytes) { await reader.cancel().catch(() => {}); break }
    }
  } else chunks.push(new TextEncoder().encode(await res.text()))
  const raw = Buffer.concat(chunks.map(c => Buffer.from(c))).subarray(0, caps.fetchBytes)
  if (looksBinary(raw)) return { refused: 'binary content' }
  const text = raw.toString('utf8')
  return { body: type.includes('html') || (type === '' && /^\s*<(!doctype|html)/i.test(text)) ? htmlToText(text) : text, type }
}

/**
 * Expand every `@path` and `@url` in a task into attachments. A reference that is not found stays
 * plain text (it may be a handle or a decorator), reported under `missing`.
 * @param {string} text - the task.
 * @param {{cwd: string, fs: object, fetch?: Function, caps?: Partial<typeof CAPS>}} opts - where paths resolve, and the injected I/O.
 * @returns {Promise<{attachments: Attachment[], notes: string[], warnings: string[], missing: string[]}>}
 *   the attachments, what to tell the user (`notes`: what was attached or fetched), and what went wrong.
 */
export async function expandRefs(text, opts) {
  const caps = { ...CAPS, ...opts.caps }
  const out = { attachments: [], notes: [], warnings: [], missing: [] }
  let left = caps.total
  for (const r of findRefs(text)) {
    if (left <= 0) { out.warnings.push(`${r.raw} skipped - the ${caps.total}-character attachment total is used up`); continue }
    const cap = Math.min(caps.perItem, left)
    let got
    let label
    if (r.url) {
      let u
      try { u = new URL(r.ref) } catch { out.warnings.push(`${r.raw}: not a valid URL`); continue }
      if (u.username !== '' || u.password !== '') { out.warnings.push(`${r.raw}: refused - the URL carries credentials, which are never sent`); continue }
      u.hash = ''
      if (opts.fetch === undefined) { out.warnings.push(`${r.raw}: fetching is unavailable here`); continue }
      const f = await fetchText(u.href, opts.fetch, caps)
      if ('refused' in f) { out.warnings.push(`${r.raw}: not attached - ${f.refused}`); continue }
      const { text: body, truncated } = clip(f.body, cap)
      got = { body, truncated }
      label = u.href
      out.notes.push(`fetched ${u.href} (${body.length} characters attached)`)
    } else {
      const tryPaths = [r.ref, ...(r.alt === undefined ? [] : [r.alt])]
      let found
      for (const p of tryPaths) {
        const local = readLocal(resolve(opts.cwd, p), opts.fs, cap)
        if (local !== undefined) { found = { p, local }; break }
      }
      if (found === undefined) { out.missing.push(r.raw); continue }
      if ('refused' in found.local) { out.warnings.push(`${r.raw}: not attached - ${found.local.refused}`); continue }
      got = found.local
      label = found.local.kind === 'dir' ? `${found.p.replace(/[\\/]+$/, '')}/ (directory listing)` : found.p
      out.notes.push(`attached ${label} (${got.body.length} characters)`)
    }
    if (got.truncated) out.warnings.push(`${label} truncated to ${got.body.length} characters`)
    out.attachments.push({ label, body: got.body, truncated: got.truncated })
    left -= got.body.length
  }
  return out
}

