/**
 * Pure helpers behind `scripts/tools/release-notes.mjs`: turn the commits since the last tag and the
 * `03-BACKLOG-DONE.md` lines of their task IDs into a draft `CHANGELOG.md` entry (Added / Changed /
 * Fixed / Upgrade). No git or file access here, so the logic is testable with fixture strings.
 * @module scripts/lib/release-notes
 */

/** Commit type → CHANGELOG section. Types not listed (docs, test, ci, style) place nothing. */
export const SECTION_OF = { feat: 'Added', fix: 'Fixed', chore: 'Changed', refactor: 'Changed', perf: 'Changed', build: 'Changed' }

/** Section order in the entry, and priority when one task has commits of several types. */
export const SECTIONS = ['Added', 'Changed', 'Fixed']
const PRIORITY = { Added: 0, Fixed: 1, Changed: 2 }

/**
 * Files whose change means every machine must re-run setup (plugins, bundles, packages, installs).
 * The root `package.json` is left out: its version bump changes on every release.
 */
export const SETUP_PATHS = [/^verness\.config\.json$/, /^scripts\/lib\/profile-setup\.mjs$/, /^packages\/[^/]+\/package\.json$/, /^pnpm-lock\.yaml$/, /^pnpm-workspace\.yaml$/]

/**
 * Every task ID a text names; `T-374..T-378` expands to each ID in the range. Letter-suffixed IDs
 * (`T-140L`) stay distinct.
 * @param {string} text - a commit subject or any line.
 * @returns {string[]} the IDs, in order, without repeats.
 */
export function taskIds(text) {
  const out = []
  for (const m of text.matchAll(/T-(\d{3})([A-Za-z]?)(?:\.\.T-(\d{3}))?/g)) {
    if (m[3] !== undefined) for (let n = Number(m[1]); n <= Number(m[3]); n++) out.push(`T-${n}`)
    else out.push(`T-${m[1]}${m[2]}`)
  }
  return [...new Set(out)]
}

/**
 * @param {string} subject - a commit subject, e.g. `feat(commands): /exit ends the REPL (T-148)`.
 * @returns {{type: string, scope: string, text: string, ids: string[]}} the conventional-commit parts
 *   (`type` is '' when the subject does not follow the convention).
 */
export function parseSubject(subject) {
  const m = subject.match(/^(\w+)(?:\(([^)]*)\))?!?:\s*(.*)$/)
  return m ? { type: m[1].toLowerCase(), scope: m[2] ?? '', text: m[3], ids: taskIds(subject) } : { type: '', scope: '', text: subject, ids: taskIds(subject) }
}

/**
 * Map each task ID defined in `03-BACKLOG-DONE.md` to its line, so IDs of one range line
 * (`- [x] T-374..T-378 …`) share one key and become one bullet.
 * @param {string} done - the text of `03-BACKLOG-DONE.md`.
 * @returns {Map<string, {key: string, ids: string, text: string}>} ID → { key (the line's ID label), ids, text }.
 */
export function doneIndex(done) {
  const index = new Map()
  for (const line of done.split('\n')) {
    const m = line.match(/^\s*- \[x\] (T-\d{3}[A-Za-z]?(?:\.\.T-\d{3})?)\s+(.*)$/)
    if (!m) continue
    const entry = { key: m[1], ids: m[1], text: m[2].trim() }
    for (const id of taskIds(m[1])) if (!index.has(id)) index.set(id, entry)
  }
  return index
}

/**
 * The lead of a backlog line: up to its first top-level `: `, `; ` or `. ` (never inside
 * parentheses or a code span), cut to about `max` characters, Markdown kept.
 * @param {string} text - the line after its ID.
 * @param {number} [max] - the length limit.
 * @returns {string} the short text.
 */
export function shorten(text, max = 160) {
  let depth = 0
  let code = false
  let end = text.length
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '`') code = !code
    else if (code) continue
    else if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && ':;.'.includes(ch) && (i + 1 === text.length || text[i + 1] === ' ')) { end = i; break }
  }
  const first = text.slice(0, end).trim()
  if (first.length <= max) return first
  const cut = first.slice(0, max)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2)).replace(/[,;:]$/, '')}…`
}

/**
 * Group commits into CHANGELOG sections. A task is placed once, in the section of its most
 * significant commit (feat > fix > chore); only tasks defined in `03-BACKLOG-DONE.md` are placed.
 * @param {{hash: string, subject: string}[]} commits - non-merge commits of the range.
 * @param {Map<string, {key: string, ids: string, text: string}>} index - from `doneIndex`.
 * @returns {{sections: Record<string, string[]>, unplaced: string[], open: string[]}} bullets per
 *   section; review lines (done tasks with only docs/test commits, feat/fix commits without an ID);
 *   IDs mentioned but not done.
 */
export function groupCommits(commits, index) {
  /** @type {Map<string, {entry: object, section: string}>} */
  const tasks = new Map()
  const loose = { Added: [], Changed: [], Fixed: [] }
  const onlyDocs = new Map()
  const open = new Set()
  for (const c of commits) {
    const p = parseSubject(c.subject)
    const section = SECTION_OF[p.type]
    const known = p.ids.filter(id => index.has(id))
    for (const id of p.ids) if (!index.has(id)) open.add(id)
    if (section === undefined) {
      for (const id of known) {
        const { key, ids } = index.get(id)
        if (!onlyDocs.has(key)) onlyDocs.set(key, { ids, refs: [] })
        onlyDocs.get(key).refs.push(`${p.type || 'other'} ${c.hash}`)
      }
      continue
    }
    if (known.length === 0) { loose[section].push(`${p.text} (${p.ids.length > 0 ? 'task not in 03-BACKLOG-DONE.md' : 'no task ID'}: ${c.hash})`); continue }
    for (const id of known) {
      const entry = index.get(id)
      const prev = tasks.get(entry.key)
      if (prev === undefined || PRIORITY[section] < PRIORITY[prev.section]) tasks.set(entry.key, { entry, section })
    }
  }
  const sections = { Added: [], Changed: [], Fixed: [] }
  for (const { entry, section } of tasks.values()) sections[section].push(`${shorten(entry.text)} (${entry.ids})`)
  const unplaced = [...[...onlyDocs].filter(([key]) => !tasks.has(key)).map(([, v]) => `${v.ids} (only ${v.refs.join(', ')})`),
    ...SECTIONS.flatMap(s => loose[s].map(l => `${s}? ${l}`))]
  return { sections, unplaced, open: [...open].filter(id => !index.has(id)) }
}

/**
 * @param {string[]} files - repo-relative paths changed in the range.
 * @returns {string[]} the ones that mean setup must be re-run.
 */
export function setupTriggers(files) {
  return files.filter(f => SETUP_PATHS.some(re => re.test(f)))
}

/**
 * The next version by the pre-1.0 rule in `05-CONVENTIONS.md`: anything Added bumps the minor,
 * fixes only bump the patch.
 * @param {string} tag - the last tag, e.g. `v0.4.0`.
 * @param {boolean} minor - whether the release adds something.
 * @returns {string} e.g. `v0.5.0`.
 */
export function nextVersion(tag, minor) {
  const m = tag.match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!m) return 'vX.Y.Z'
  const [maj, min, pat] = m.slice(1).map(Number)
  return minor ? `v${maj}.${min + 1}.0` : `v${maj}.${min}.${pat + 1}`
}

/**
 * Render the draft entry.
 * @param {object} o - the parts.
 * @param {string} o.version - the version heading.
 * @param {string} o.date - YYYY-MM-DD.
 * @param {Record<string, string[]>} o.sections - from `groupCommits`.
 * @param {string[]} o.triggers - from `setupTriggers`.
 * @param {string[]} o.merges - merge subjects, for the reviewer.
 * @param {string[]} o.unplaced - review lines.
 * @param {string[]} o.open - IDs mentioned but not done.
 * @returns {string} Markdown.
 */
export function renderEntry({ version, date, sections, triggers, merges, unplaced, open }) {
  const out = [`## ${version} — ${date}`, '', '**<one-line summary of the release>**']
  for (const s of SECTIONS) {
    if (sections[s].length === 0) continue
    out.push('', `### ${s}`, ...sections[s].map(b => `- ${b}`))
  }
  if (triggers.length > 0) {
    out.push('', '### Upgrade', 'Run `./turn_on.sh setup` (Windows: `.\\turn_on.cmd setup`) once, on every machine.',
      `<!-- setup inputs changed: ${triggers.join(', ')} -->`)
  }
  const review = [
    ...merges.map(m => `merged: ${m}`),
    ...unplaced.map(u => `not placed: ${u}`),
    ...(open.length > 0 ? [`mentioned, not done: ${open.join(', ')}`] : []),
  ]
  if (review.length > 0) out.push('', '<!-- review, then delete:', ...review.map(r => `  ${r.replace(/-->/g, '->')}`), '-->')
  return out.join('\n')
}
