/**
 * Irreversible-command classifier (T-473). Pure: a shell line in, `{irreversible, reasons}` out.
 *
 * The line is tokenized the way a shell would split it (quotes, escapes, `;` `&&` `||` `|` `&`,
 * `$(...)`, backticks, `<(...)`, redirects, PowerShell script blocks) and every simple command is
 * judged after its wrappers are peeled off (`sudo`, `env`, `nohup`, `timeout`, `xargs`, ...). Nested
 * command text (`sh -c`, `eval`, `cmd /c`, `powershell -Command` / `-EncodedCommand`, `iex`, `wsl`)
 * is classified recursively. Every dialect is checked on every line, so the caller need not know the
 * shell. Text that is only data (`echo "rm -rf /"`, `git commit -m "drop table"`) is never a command.
 * A line with an unclosed quote is also checked with its quotes removed: never "safe" by accident.
 * @module @finess/guard/classify
 */

/** @typedef {{words: string[], redirects: string[], subs: string[], heredocs: string[]}} Cmd */

/** Characters a backslash escapes outside quotes; any other `\` stays (Windows paths, `\rm`). */
const ESCAPABLE = new Set([' ', '\t', ';', '&', '|', "'", '"', '\\', '(', ')', '$', '`', '<', '>', '{', '}', '*', '?', '#', '!'])

/**
 * Read a balanced `( ... )` body, respecting quotes (a lone apostrophe, as in a heredoc's "don't", is text).
 * @param {string} s - the text. @param {number} start - index just after the `(`.
 * @returns {{text: string, end: number, closed: boolean}} the body and the index after `)`.
 */
function readParen(s, start) {
  let depth = 1
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (c === "'" || c === '"') { const j = s.indexOf(c, i + 1); if (j >= 0) i = j; continue }
    if (c === '\\') { i++; continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return { text: s.slice(start, i), end: i + 1, closed: true }
  }
  return { text: s.slice(start), end: s.length, closed: false }
}

/**
 * Read a double-quoted string; `$(...)` and backtick bodies inside it are reported as substitutions.
 * @param {string} s - the text. @param {number} start - index just after the opening `"`.
 * @param {(t: string) => void} sub - receives each substitution body.
 * @returns {{text: string, end: number, closed: boolean}} the unquoted text and the index after `"`.
 */
function readDouble(s, start, sub) {
  let text = ''
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (c === '"') return { text, end: i + 1, closed: true }
    if (c === '\\' && '"\\$`'.includes(s[i + 1] ?? '')) { text += s[++i]; continue }
    if (c === '$' && s[i + 1] === '(') { const r = readParen(s, i + 2); sub(r.text); text += '$()'; i = r.end - 1; continue }
    if (c === '`') {
      const j = s.indexOf('`', i + 1)
      const q = s.indexOf('"', i + 1)
      if (j > i && (q < 0 || j < q)) { sub(s.slice(i + 1, j)); i = j; continue }
    }
    text += c
  }
  return { text, end: s.length, closed: false }
}

/**
 * Split a line into pipelines of simple commands.
 * @param {string} line - a shell line (POSIX, cmd.exe or PowerShell).
 * @returns {{pipelines: Cmd[][], unbalanced: boolean}} the commands; `unbalanced` when a quote or
 *   parenthesis never closed.
 */
export function parseLine(line) {
  const s = String(line)
  /** @type {Cmd[][]} */
  const pipelines = []
  /** @type {Cmd[]} */
  let pipeline = []
  /** @type {Cmd} */
  let cmd = { words: [], redirects: [], subs: [], heredocs: [] }
  /** @type {string|null} */
  let word = null
  /** @type {'out'|'skip'|'heredoc'|'heredoc-'|null} */
  let redirect = null
  let unbalanced = false
  /** Heredocs whose body starts on the next line: the owning command and the delimiter. */
  const pending = []
  const endWord = () => {
    if (word === null) return
    if (redirect === 'out') cmd.redirects.push(word)
    else if (redirect === 'heredoc' || redirect === 'heredoc-') pending.push({ cmd, delim: word, strip: redirect === 'heredoc-' })
    else if (redirect !== 'skip') cmd.words.push(word)
    redirect = null
    word = null
  }
  const endCmd = () => {
    endWord()
    if (cmd.words.length + cmd.redirects.length + cmd.subs.length > 0 || pending.some(p => p.cmd === cmd)) pipeline.push(cmd)
    cmd = { words: [], redirects: [], subs: [], heredocs: [] }
  }
  const endPipeline = () => { endCmd(); if (pipeline.length > 0) pipelines.push(pipeline); pipeline = [] }
  const add = t => { word = (word ?? '') + t }
  const sub = t => { cmd.subs.push(t) }
  let i = 0
  while (i < s.length) {
    const c = s[i]
    const n = s[i + 1]
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue }
    if (c === '#' && word === null) { while (i < s.length && s[i] !== '\n') i++; continue }
    if (c === '\\') {
      if (n === '\n') { i += 2; continue }
      if (n !== undefined && ESCAPABLE.has(n)) { add(n); i += 2; continue }
      add(c); i++; continue
    }
    if (c === "'") {
      const j = s.indexOf("'", i + 1)
      if (j < 0) { unbalanced = true; add(s.slice(i + 1)); i = s.length; continue }
      add(s.slice(i + 1, j)); i = j + 1; continue
    }
    if (c === '"') { const r = readDouble(s, i + 1, sub); add(r.text); if (!r.closed) unbalanced = true; i = r.end; continue }
    if (c === '`') {
      const j = s.indexOf('`', i + 1)
      if (j > i) { sub(s.slice(i + 1, j)); add('``'); i = j + 1 } else { if (n !== undefined) add(n); i += 2 }
      continue
    }
    if ((c === '$' || c === '@') && n === '(') {
      const r = readParen(s, i + 2); sub(r.text); add('$()'); if (!r.closed) unbalanced = true; i = r.end; continue
    }
    if ((c === '<' || c === '>') && n === '(' && word === null) {
      const r = readParen(s, i + 2); sub(r.text); add('<()'); if (!r.closed) unbalanced = true; i = r.end; continue
    }
    if (c === '$' && n === '{') {
      const j = s.indexOf('}', i + 2)
      const end = j < 0 ? s.length : j + 1
      add(s.slice(i, end)); i = end; continue
    }
    if (c === '{' && n === '}') { add('{}'); i += 2; continue }
    if (c === '&' && n === '>') { endWord(); i += 2; if (s[i] === '>') i++; redirect = 'out'; continue }
    if (c === '<') {
      endWord()
      const here = s.startsWith('<<', i) && !s.startsWith('<<<', i)
      i += s.startsWith('<<<', i) ? 3 : here ? 2 : 1
      const strip = here && s[i] === '-'
      if (strip) i++
      redirect = here ? (strip ? 'heredoc-' : 'heredoc') : 'skip'
      continue
    }
    if (c === '>') {
      // `2>` and `1>`: the digit is the descriptor, not a word.
      if (word !== null && /^\d+$/.test(word)) word = null
      else endWord()
      i++
      if (s[i] === '>' || s[i] === '|') i++
      if (s[i] === '&') { i++; while (/[\d-]/.test(s[i] ?? '')) i++; continue }
      redirect = 'out'
      continue
    }
    if (c === '|') { if (n === '|') { endPipeline(); i += 2; continue } endCmd(); i += n === '&' ? 2 : 1; continue }
    // A heredoc body is data for its command, never commands of this line: read it whole here.
    if (c === '\n' && (endWord(), pending.length > 0)) {
      endPipeline()
      let at = i + 1
      for (const p of pending.splice(0)) {
        const body = []
        while (at < s.length) {
          const nl = s.indexOf('\n', at)
          const ln = s.slice(at, nl < 0 ? s.length : nl).replace(/\r$/, '')
          at = nl < 0 ? s.length : nl + 1
          if ((p.strip ? ln.replace(/^\t+/, '') : ln) === p.delim) break
          body.push(ln)
        }
        p.cmd.heredocs.push(body.join('\n'))
      }
      i = at
      continue
    }
    if (c === ';' || c === '\n' || c === '&' || c === '(' || c === ')' || c === '}' || (c === '{' && word === null)) {
      endPipeline(); i += c === '&' && n === '&' ? 2 : 1; continue
    }
    add(c); i++
  }
  endWord()
  // A heredoc opened on the last line has no body.
  for (const p of pending.splice(0)) p.cmd.heredocs.push('')
  endPipeline()
  return { pipelines, unbalanced }
}

/**
 * A command word as a bare lower-case name: `\rm`, `/usr/bin/rm`, `C:\x\rm.exe` all become `rm`.
 * @param {string} word - the first word of a command. @returns {string} the name.
 */
export function norm(word) {
  const w = String(word).replace(/^\\+/, '').split(/[\\/]/).pop() ?? ''
  return w.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
}

/** Shell keywords and prefixes that precede the real command. */
const PREFIXES = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'time', 'coproc', 'exec', 'command', 'builtin', 'nohup', 'noglob', 'busybox', 'call', 'caffeinate'])

/**
 * Peel wrappers off a command: assignments, keywords, `sudo`/`doas`, `env`, `nice`, `ionice`,
 * `timeout`, `stdbuf`, `xargs`.
 * @param {string[]} words - the command's words.
 * @returns {{words: string[], xargs: boolean}} the real command and whether `xargs` fed it.
 */
export function unwrap(words) {
  const w = [...words]
  let xargs = false
  for (let guard = 0; guard < 32 && w.length > 0; guard++) {
    while (w.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift()
    if (w.length === 0) break
    const n = norm(w[0])
    if (PREFIXES.has(n)) {
      w.shift()
      while ((n === 'time' || n === 'command' || n === 'exec') && w[0]?.startsWith('-')) w.shift()
      continue
    }
    if (n === 'sudo' || n === 'doas' || n === 'run0' || n === 'pkexec') {
      w.shift()
      while (w[0]?.startsWith('-')) {
        const f = w.shift()
        if (f === '--') break
        if (/^-[ugpCDhrtTUc]$/.test(f) || /^--(user|group|host|prompt|chdir|role|type|other-user|close-from|command-timeout)$/.test(f)) w.shift()
      }
      continue
    }
    if (n === 'env') {
      w.shift()
      while (w.length > 0) {
        if (w[0] === '--') { w.shift(); break }
        if (/^-[uCS]$/.test(w[0]) || /^--(unset|chdir|split-string)$/.test(w[0])) { w.splice(0, 2); continue }
        if (w[0].startsWith('-') || /^[A-Za-z_]\w*=/.test(w[0])) { w.shift(); continue }
        break
      }
      continue
    }
    if (n === 'nice' || n === 'ionice') {
      w.shift()
      while (w[0]?.startsWith('-')) { const f = w.shift(); if (/^-[ncp]$/.test(f)) w.shift() }
      continue
    }
    if (n === 'timeout') {
      w.shift()
      while (w[0]?.startsWith('-')) { const f = w.shift(); if (/^-[sk]$/.test(f) || f === '--signal' || f === '--kill-after') w.shift() }
      w.shift()
      continue
    }
    if (n === 'stdbuf') { w.shift(); while (w[0]?.startsWith('-')) { const f = w.shift(); if (/^-[ioe]$/.test(f)) w.shift() } continue }
    if (n === 'xargs') {
      xargs = true
      w.shift()
      while (w[0]?.startsWith('-')) {
        const f = w.shift()
        if (f === '--') break
        if (/^-[InPLsdEa]$/.test(f) || /^--(max-args|max-procs|max-lines|delimiter|arg-file|replace)$/.test(f)) w.shift()
      }
      continue
    }
    break
  }
  return { words: w, xargs }
}

/**
 * Whether a word is a PowerShell parameter (or an unambiguous prefix of it) that is switched on.
 * @param {string} w - the word. @param {string} name - the full parameter name, lower case.
 * @param {number} min - the shortest prefix accepted. @returns {boolean} whether it matches.
 */
const ps = (w, name, min) => {
  const m = /^-([a-z]+)(?::(.*))?$/i.exec(w)
  if (m === null || m[1].length < min || !name.startsWith(m[1].toLowerCase())) return false
  return m[2] === undefined || !/^\$?false$/i.test(m[2])
}

/** @param {string[]} args @returns {Set<string>} the letters of every short-option cluster (`-fdx`). */
const shortLetters = args => new Set(args.filter(a => /^-[a-zA-Z]+$/.test(a)).flatMap(a => [...a.slice(1)]))

/** @param {string[]} args @returns {Set<string>} the letters of every cmd.exe switch (`/s`, `/s/q`). */
const cmdSwitches = args => new Set(args.filter(a => /^(\/[a-z?])+$/i.test(a)).flatMap(a => a.toLowerCase().split('/').filter(Boolean)))

/** Targets whose deletion is a catastrophe whatever the flags. */
const DANGEROUS_TARGET = /^(\/|\/\*|~|~\/|~\/\*|\*|\.\/\*|\.\.?|\.\.?\/|\.\.\/\*|\$home|\$env:userprofile|%userprofile%|\$\{?home\}?\/?\*?|[a-z]:[\\/]?\*?|[a-z]:[\\/]\*\.\*)$/i

/** Top-level system paths for recursive chmod/chown. */
const ROOTISH = /^(\/|\/\*|~|~\/|\$home|[a-z]:[\\/]?|\/(etc|usr|bin|sbin|lib|lib64|var|boot|home|root|opt|system|library|users|private)\/?)$/i

/** Raw block devices: writing to one destroys the filesystem on it. */
const RAW_DEVICE = /^\/dev\/(sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|disk\d|rdisk\d|md\d|dm-\d|mapper\/|loop\d)|\.\\physicaldrive\d*|^\\?\\?\.\\[a-z]:$/i

/** Commands that delete what they are given. */
const REMOVERS = new Set(['rm', 'del', 'erase', 'ri', 'remove-item', 'unlink', 'shred', 'rmdir', 'rd', 'srm'])

/** Commands that fetch remote content. */
const DOWNLOADERS = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'fetch'])

/** Commands that execute what they read. */
const RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'perl', 'ruby', 'node', 'iex', 'invoke-expression', 'pwsh', 'powershell', 'cmd', 'source', '.', 'eval'])

/** Shells whose heredoc body is a script. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd'])

/** PowerShell/POSIX listers: piped into a remover, they make a bulk delete (`gci | ri`). */
const LISTERS = new Set(['get-childitem', 'gci', 'ls', 'dir', 'get-item', 'gi'])

/** SQL command-line clients. */
const SQL_CLIENTS = new Set(['sqlite3', 'sqlite', 'psql', 'mysql', 'mariadb', 'sqlcmd', 'duckdb', 'clickhouse-client'])

/** Commands whose arguments are emitted as text (a pipeline into a SQL client runs them). */
const EMITTERS = new Set(['echo', 'printf', 'write-output', 'write-host', 'cat'])

/**
 * Destructive SQL in a text: DROP, TRUNCATE, ALTER ... DROP, DELETE or UPDATE without WHERE.
 * @param {string} sql - SQL text. @returns {string[]} the reasons.
 */
export function sqlReasons(sql) {
  const out = []
  const text = String(sql).replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const raw of text.split(';')) {
    const st = raw.trim().toLowerCase().replace(/\s+/g, ' ')
    if (/^drop /.test(st)) out.push(`SQL ${st.split(' ').slice(0, 2).join(' ').toUpperCase()}: removes the object and its data`)
    else if (/^truncate\b/.test(st)) out.push('SQL TRUNCATE: deletes every row')
    else if (/^alter table .* drop /.test(st)) out.push('SQL ALTER TABLE ... DROP: removes a column or constraint with its data')
    else if (/^delete (from )?/.test(st) && !/\bwhere\b/.test(st)) out.push('SQL DELETE without WHERE: deletes every row')
    else if (/^update /.test(st) && !/\bwhere\b/.test(st)) out.push('SQL UPDATE without WHERE: overwrites every row')
  }
  return out
}

/**
 * The SQL a client runs from its own arguments.
 * @param {string} name - the client. @param {string[]} args - its arguments.
 * @returns {string[]} the SQL texts found.
 */
function sqlOf(name, args) {
  const out = []
  const opt = { psql: ['-c', '--command'], mysql: ['-e', '--execute'], mariadb: ['-e', '--execute'], sqlcmd: ['-Q', '-q'], 'clickhouse-client': ['-q', '--query'] }[name]
  if (opt !== undefined) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      for (const o of opt) {
        if (a === o) out.push(args[i + 1] ?? '')
        else if (o.startsWith('--') && a.startsWith(`${o}=`)) out.push(a.slice(o.length + 1))
        else if (!o.startsWith('--') && a.startsWith(o) && a.length > o.length) out.push(a.slice(o.length))
      }
    }
    return out
  }
  // sqlite3 / duckdb: options, then the database, then SQL.
  const withValue = new Set(['-cmd', '-separator', '-nullvalue', '-init', '-newline', '-c', '-s'])
  let seenDb = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('-')) { if (withValue.has(a)) { if (a === '-cmd' || a === '-c' || a === '-s') out.push(args[i + 1] ?? ''); i++ } continue }
    if (!seenDb) { seenDb = true; continue }
    out.push(a)
  }
  return out
}

/**
 * The parameters of `powershell`/`pwsh` that take a value.
 * @type {[string, number][]}
 */
const PS_VALUE = [['executionpolicy', 2], ['ep', 2], ['windowstyle', 1], ['workingdirectory', 2], ['configurationname', 3], ['outputformat', 1], ['inputformat', 1], ['version', 1], ['psconsolefile', 2], ['custompipename', 2], ['settingsfile', 2]]

/**
 * The command text `powershell`/`pwsh` runs, decoding `-EncodedCommand`.
 * @param {string[]} args - its arguments. @returns {string|undefined} the text, or undefined (a file).
 */
function pwshText(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('-')) return args.slice(i).join(' ')
    if (ps(a, 'command', 1)) return args.slice(i + 1).join(' ')
    if (ps(a, 'encodedcommand', 1) || /^-ec$/i.test(a)) {
      try { return Buffer.from(args[i + 1] ?? '', 'base64').toString('utf16le') } catch { return '' }
    }
    if (ps(a, 'file', 1)) return undefined
    if (PS_VALUE.some(([n, m]) => ps(a, n, m))) i++
  }
  return undefined
}

/**
 * Reasons from one `git` invocation.
 * @param {string[]} argv - the arguments after `git`. @returns {string[]} the reasons.
 */
function gitReasons(argv) {
  let i = 0
  while (i < argv.length && argv[i].startsWith('-')) {
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'].includes(argv[i])) i++
    i++
  }
  const sub = argv[i]
  const rest = argv.slice(i + 1)
  const has = (...xs) => xs.some(x => rest.some(r => r === x || r.startsWith(`${x}=`)))
  const L = shortLetters(rest)
  const pos = rest.filter(r => !r.startsWith('-'))
  switch (sub) {
    case 'reset': return has('--hard') ? ['git reset --hard: discards uncommitted changes'] : []
    case 'clean': return (has('--force') || L.has('f')) && !has('--dry-run') && !L.has('n') ? ['git clean -f: deletes untracked files for good'] : []
    case 'push': {
      if (has('--dry-run') || L.has('n')) return []
      const out = []
      if (has('--force', '--force-with-lease', '--force-if-includes') || L.has('f')) out.push('git push --force: overwrites the remote history')
      if (has('--mirror')) out.push('git push --mirror: makes the remote match, deleting what is not local')
      if (has('--delete', '--prune') || L.has('d') || pos.slice(1).some(p => p.startsWith(':'))) out.push('git push --delete: deletes remote refs')
      if (pos.slice(1).some(p => p.startsWith('+'))) out.push('git push +refspec: forces the update')
      return out
    }
    case 'branch': return rest.includes('-D') || ((has('--delete') || L.has('d')) && (has('--force') || L.has('f'))) ? ['git branch -D: deletes a branch even if unmerged'] : []
    case 'checkout': {
      if (has('--force') || L.has('f')) return ['git checkout -f: discards local changes']
      const dash = rest.indexOf('--')
      if ((dash >= 0 && dash < rest.length - 1) || rest.includes('.')) return ['git checkout -- <path>: discards uncommitted changes to those paths']
      return []
    }
    case 'switch': return has('--discard-changes', '--force') || L.has('f') ? ['git switch -f: discards local changes'] : []
    case 'restore': {
      const worktree = !(has('--staged') || L.has('S')) || has('--worktree') || L.has('W')
      return worktree && !has('--patch') && !L.has('p') && pos.length > 0 ? ['git restore: discards uncommitted changes to those paths'] : []
    }
    case 'stash': return rest[0] === 'drop' || rest[0] === 'clear' ? [`git stash ${rest[0]}: deletes stashed changes`] : []
    case 'filter-branch': case 'filter-repo': return [`git ${sub}: rewrites the whole history`]
    case 'reflog': return rest[0] === 'expire' || rest[0] === 'delete' ? [`git reflog ${rest[0]}: removes the recovery log`] : []
    case 'gc': return rest.some(r => /^--prune=(now|all)$/.test(r)) ? ['git gc --prune=now: drops unreachable commits for good'] : []
    default: return []
  }
}

/**
 * Reasons from deleting commands (`rm`, `del`, `rd`, `Remove-Item` and aliases).
 * @param {string} name - normalized name. @param {string[]} args - arguments. @returns {string[]} the reasons.
 */
function removeReasons(name, args) {
  const out = []
  const dd = args.indexOf('--')
  const opts = dd < 0 ? args : args.slice(0, dd)
  const targets = (dd < 0 ? args : args.slice(dd + 1)).filter(a => dd >= 0 || (!a.startsWith('-') && !/^(\/[a-z?])+$/i.test(a)))
  const sw = cmdSwitches(opts)
  if (name === 'rm' || name === 'srm') {
    for (const a of opts) {
      if (/^-[fiIrRdvPx]+$/.test(a)) {
        if (/[rR]/.test(a)) out.push(`${name} -r: deletes a whole directory tree`)
        if (a.includes('f')) out.push(`${name} -f: deletes without asking`)
      } else if (a === '--recursive') out.push(`${name} -r: deletes a whole directory tree`)
      else if (a === '--force') out.push(`${name} -f: deletes without asking`)
      else if (a === '--no-preserve-root') out.push(`${name} --no-preserve-root: allows deleting /`)
    }
  }
  if (name !== 'unlink' && name !== 'shred') {
    const psOpts = name === 'rm' || name === 'srm' ? opts.filter(a => !/^-[fiIrRdvPx]+$/.test(a)) : opts
    if (psOpts.some(a => ps(a, 'recurse', 1))) out.push(`${name} -Recurse: deletes a whole directory tree`)
    if (psOpts.some(a => ps(a, 'force', 2))) out.push(`${name} -Force: deletes without asking, read-only and hidden items too`)
  }
  if ((name === 'del' || name === 'erase') && sw.has('s')) out.push(`${name} /s: deletes matching files in every subdirectory`)
  if ((name === 'del' || name === 'erase') && sw.has('q') && targets.some(t => t.includes('*'))) out.push(`${name} /q *: deletes every match without asking`)
  if ((name === 'rd' || name === 'rmdir') && sw.has('s')) out.push(`${name} /s: deletes a whole directory tree`)
  if (name !== 'rmdir' && name !== 'rd' && name !== 'unlink') {
    for (const t of targets) if (DANGEROUS_TARGET.test(t)) out.push(`${name} ${t}: deletes everything there`)
  }
  return out
}

/**
 * Classify one simple command.
 * @param {Cmd} cmd - the command. @param {number} depth - nesting depth.
 * @param {(r: string) => void} push - collects reasons.
 * @returns {string} the command's normalized name (after wrappers).
 */
function checkCmd(cmd, depth, push) {
  for (const r of cmd.redirects) if (RAW_DEVICE.test(r)) push(`> ${r}: overwrites a raw disk device`)
  for (const s of cmd.subs) for (const r of classifyText(s, depth + 1)) push(r)
  const { words, xargs } = unwrap(cmd.words)
  if (words.length === 0) return ''
  const name = norm(words[0])
  const args = words.slice(1)
  const L = shortLetters(args)
  const nested = text => { for (const r of classifyText(text, depth + 1)) push(r) }
  if (xargs && REMOVERS.has(name)) push(`xargs ${name}: deletes every file it is fed`)
  if (/^mkfs(\.|$)/.test(name) || ['mke2fs', 'mkswap', 'newfs', 'mkntfs'].includes(name)) push(`${name}: creates a filesystem, erasing the device`)
  if (cmd.subs.some(s => DOWNLOADERS.has(firstName(s))) && RUNNERS.has(name)) push(`${name} $(download): runs code fetched from the network`)
  switch (name) {
    case 'rm': case 'srm': case 'del': case 'erase': case 'ri': case 'remove-item': case 'rd': case 'rmdir':
      for (const r of removeReasons(name, args)) push(r)
      break
    case 'find': {
      if (args.includes('-delete')) push('find -delete: deletes every match')
      for (let i = 0; i < args.length; i++) {
        if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[i])) continue
        let j = i + 1
        while (j < args.length && args[j] !== ';' && args[j] !== '+') j++
        const inner = args.slice(i + 1, j)
        if (inner.length > 0 && REMOVERS.has(norm(inner[0]))) push(`find ${args[i]} ${norm(inner[0])}: deletes every match`)
        checkCmd({ words: inner, redirects: [], subs: [] }, depth + 1, push)
        i = j
      }
      break
    }
    case 'shred': case 'sdelete': case 'wipe': case 'blkdiscard':
      push(`${name}: destroys data so it cannot be recovered`)
      break
    case 'wipefs':
      if (L.has('a') || L.has('o') || args.some(a => a === '--all' || a.startsWith('--offset'))) push('wipefs: erases filesystem signatures')
      break
    case 'format':
      if (args.some(a => /^[a-z]:\\?$/i.test(a))) push('format: erases a volume')
      break
    case 'format-volume': case 'clear-disk': case 'initialize-disk': case 'remove-partition': case 'clear-recyclebin':
      push(`${words[0]}: erases data for good`)
      break
    case 'diskpart':
      push('diskpart: repartitions and erases disks')
      break
    case 'fdisk': case 'sfdisk': case 'gdisk': case 'sgdisk': case 'parted': case 'cfdisk':
      if (!args.some(a => ['-l', '--list', '-L', '-p', '--print', 'print', '-v', '--version', '-h', '--help'].includes(a))) push(`${name}: rewrites a partition table`)
      break
    case 'dd':
      if (args.some(a => a.startsWith('of='))) push(`dd ${args.find(a => a.startsWith('of='))}: overwrites the target byte by byte`)
      break
    case 'tee': case 'cp': case 'mv': case 'install':
      for (const a of args) if (RAW_DEVICE.test(a)) push(`${name} ${a}: overwrites a raw disk device`)
      if (name === 'mv' && args.at(-1) === '/dev/null') push('mv ... /dev/null: deletes the source')
      break
    case 'git':
      for (const r of gitReasons(args)) push(r)
      break
    case 'chmod': case 'chown': case 'chgrp':
      if ((L.has('R') || args.includes('--recursive')) && args.some(a => ROOTISH.test(a))) push(`${name} -R on ${args.find(a => ROOTISH.test(a))}: rewrites permissions of the whole system`)
      break
    case 'shutdown':
      if (!args.some(a => /^[-/](a|c)$/i.test(a))) push('shutdown: stops the machine and every unsaved process')
      break
    case 'reboot': case 'halt': case 'poweroff': case 'stop-computer': case 'restart-computer':
      push(`${words[0]}: stops the machine and every unsaved process`)
      break
    case 'init': case 'telinit':
      if (args[0] === '0' || args[0] === '6') push(`${name} ${args[0]}: stops the machine`)
      break
    case 'systemctl':
      if (args.some(a => ['poweroff', 'reboot', 'halt', 'kexec'].includes(a))) push('systemctl poweroff/reboot: stops the machine')
      break
    case 'kill': {
      let a = [...args]
      if (a[0] === '-s' || a[0] === '-n') a = a.slice(2)
      else if (a[0]?.startsWith('-') && a[0] !== '--' && a.length > 1) a = a.slice(1)
      if (a[0] === '--') a = a.slice(1)
      if (a.includes('-1')) push('kill -1: kills every process you can signal')
      break
    }
    case 'killall5':
      push('killall5: kills every process')
      break
    case 'taskkill': {
      const im = args.findIndex(a => /^\/im$/i.test(a))
      if (im >= 0 && /^\*(\.\*)?$/.test(args[im + 1] ?? '')) push('taskkill /im *: kills every process')
      break
    }
    case 'stop-process': case 'spps':
      if (args.includes('*')) push('Stop-Process *: kills every process')
      break
    case 'sh': case 'bash': case 'zsh': case 'dash': case 'ksh': case 'fish': {
      const c = args.findIndex(a => /^-[a-z]*c[a-z]*$/i.test(a))
      if (c >= 0 && args[c + 1] !== undefined) nested(args[c + 1])
      break
    }
    case 'eval':
      nested(args.join(' '))
      break
    case 'cmd': {
      const c = args.findIndex(a => /^\/[ck]$/i.test(a))
      if (c >= 0) nested(args.slice(c + 1).join(' ').replace(/\^(.)/g, '$1'))
      break
    }
    case 'powershell': case 'pwsh': case 'powershell_ise': {
      const t = pwshText(args)
      if (t !== undefined) nested(t)
      break
    }
    case 'iex': case 'invoke-expression':
      nested(args.join(' '))
      break
    case 'wsl': {
      let i = 0
      while (i < args.length && args[i].startsWith('-') && !['-e', '--exec', '--'].includes(args[i])) i += ['-d', '--distribution', '-u', '--user', '--cd'].includes(args[i]) ? 2 : 1
      if (['-e', '--exec', '--'].includes(args[i])) i++
      if (i < args.length) nested(args.slice(i).join(' '))
      break
    }
    default:
      break
  }
  if (SQL_CLIENTS.has(name)) for (const sql of [...sqlOf(name, args), ...(cmd.heredocs ?? [])]) for (const r of sqlReasons(sql)) push(r)
  // `bash <<EOF ... EOF` runs its body; `cat > f <<EOF` only writes it.
  if (SHELLS.has(name)) for (const body of cmd.heredocs ?? []) nested(body)
  if (REMOVERS.has(name) && args.some(a => /^\$(_|psitem)$/i.test(a))) push(`${name} $_: deletes every item it is fed`)
  return name
}

/** @param {string} text - a command line. @returns {string} the name of its first command. */
function firstName(text) {
  const p = parseLine(text).pipelines[0]?.[0]
  return p === undefined ? '' : norm(unwrap(p.words).words[0] ?? '')
}

/**
 * Every reason a line is irreversible.
 * @param {string} text - the line. @param {number} depth - nesting depth (recursion guard).
 * @returns {string[]} the reasons, possibly repeated.
 */
function classifyText(text, depth) {
  if (depth > 8) return []
  const out = []
  const push = r => { out.push(r) }
  const { pipelines, unbalanced } = parseLine(text)
  const names = []
  for (const pipeline of pipelines) {
    const stages = pipeline.map(c => checkCmd(c, depth, push))
    names.push(...stages)
    const dl = stages.findIndex(n => DOWNLOADERS.has(n))
    if (dl >= 0 && stages.slice(dl + 1).some(n => RUNNERS.has(n))) push(`${stages[dl]} | ${stages.slice(dl + 1).find(n => RUNNERS.has(n))}: runs code fetched from the network`)
    // `echo "DROP TABLE t" | sqlite3 db`
    const sq = stages.findIndex(n => SQL_CLIENTS.has(n))
    if (sq > 0) {
      for (let k = 0; k < sq; k++) {
        if (EMITTERS.has(stages[k])) for (const r of sqlReasons(unwrap(pipeline[k].words).words.slice(1).join(' '))) push(r)
      }
    }
    const ls = stages.findIndex(n => LISTERS.has(n))
    if (ls >= 0 && stages.slice(ls + 1).some(n => REMOVERS.has(n))) push(`${stages[ls]} | ${stages.slice(ls + 1).find(n => REMOVERS.has(n))}: deletes every listed item`)
    if (stages.includes('stop-process') && pipeline.length > 1 && ['get-process', 'gps', 'ps'].includes(stages[0]) && pipeline[0].words.length === 1) {
      push('Get-Process | Stop-Process: kills every process')
    }
  }
  // `iex (iwr ...)`, `iex (New-Object Net.WebClient).DownloadString(...)`
  if (names.some(n => n === 'iex' || n === 'invoke-expression') && (names.some(n => DOWNLOADERS.has(n)) || /downloadstring|downloadfile|net\.webclient/i.test(text))) {
    push('iex <download>: runs code fetched from the network')
  }
  if (unbalanced && depth < 8) out.push(...classifyText(String(text).replace(/["'`]/g, ' '), 8))
  return out
}

/**
 * Whether a shell line would do something that cannot be undone, and why.
 * @param {string} cmd - the line as the shell would receive it (any dialect).
 * @returns {{irreversible: boolean, reasons: string[]}} the verdict; reasons are unique.
 */
export function classifyCommand(cmd) {
  const reasons = [...new Set(classifyText(String(cmd ?? ''), 0))]
  return { irreversible: reasons.length > 0, reasons }
}
