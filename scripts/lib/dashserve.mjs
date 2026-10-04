/**
 * Dashboard server pieces (T-273..T-278): bind/token rules, debounce, SSE framing, a change watcher
 * and a loopback-first HTTP server. Node built-ins only. The pure parts are unit-tested.
 * @module scripts/lib/dashserve
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'

export const DEFAULT_PORT = 4180
export const DEFAULT_HOST = '127.0.0.1'

/**
 * @param {string} host - a bind address or host name.
 * @returns {boolean} whether it is a loopback address (127.0.0.0/8, ::1, localhost).
 */
export function isLoopback(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1' || /^127(\.\d{1,3}){3}$/.test(h)
}

/**
 * Decide how a bind address is protected: loopback needs nothing, anything else needs a token.
 * @param {string} host - the requested bind address.
 * @returns {{loopback: boolean, requireToken: boolean}} the plan.
 */
export function bindPlan(host) {
  const loopback = isLoopback(host)
  return { loopback, requireToken: !loopback }
}

/** @returns {string} a fresh random token (192 bits, url-safe). */
export const generateToken = () => randomBytes(24).toString('base64url')

/**
 * Read the stored token, or create and store one. Printed by the caller only when `created`.
 * @param {string} file - e.g. `.finess/run/dashboard.token`.
 * @returns {{token: string, created: boolean}} the token.
 */
export function loadOrCreateToken(file) {
  try {
    const t = readFileSync(file, 'utf8').trim()
    if (t.length >= 16) return { token: t, created: false }
  } catch { /* none yet */ }
  const token = generateToken()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, token + '\n', { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* not supported on this fs */ }
  return { token, created: true }
}

/**
 * The token a request carries: `?token=`, `x-finess-token`, or `Authorization: Bearer`.
 * @param {string} url - the request URL (path + query).
 * @param {Record<string, string|string[]|undefined>} headers - lowercased request headers.
 * @returns {string|undefined} the token, if any.
 */
export function requestToken(url, headers) {
  const q = new URL(url, 'http://x').searchParams.get('token')
  if (q) return q
  const h = headers['x-finess-token']
  if (typeof h === 'string' && h) return h
  const m = /^Bearer (.+)$/.exec(String(headers.authorization ?? ''))
  return m?.[1]
}

/**
 * @param {string|undefined} given - the token presented.
 * @param {string} expected - the real one.
 * @returns {boolean} whether they match (constant time).
 */
export function tokenOk(given, expected) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Host-header check against DNS rebinding: a loopback server only answers loopback host names.
 * @param {string|undefined} hostHeader - the `Host` header.
 * @returns {boolean} whether the name is loopback.
 */
export function hostAllowed(hostHeader) {
  if (!hostHeader) return false
  const name = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.replace(/:\d+$/, '')
  return isLoopback(name)
}

/**
 * Trailing-edge debounce.
 * @param {() => void} fn - the action.
 * @param {number} ms - quiet time before it fires.
 * @returns {{trigger: () => void, cancel: () => void}} the debounced handle.
 */
export function debounce(fn, ms) {
  let t
  return {
    trigger() { clearTimeout(t); t = setTimeout(() => { t = undefined; fn() }, ms) },
    cancel() { clearTimeout(t); t = undefined },
  }
}

/**
 * One Server-Sent Events frame.
 * @param {string} event - event name.
 * @param {unknown} [data] - JSON-encoded payload (single line).
 * @param {number|string} [id] - event id.
 * @returns {string} the frame, ending in a blank line.
 */
export function sseFrame(event, data, id) {
  return (id === undefined ? '' : `id: ${id}\n`) + `event: ${event}\n` + (data === undefined ? '' : `data: ${JSON.stringify(data)}\n`) + '\n'
}

/**
 * A cheap fingerprint of a file tree (count + size + mtime), depth-limited; for the polling fallback.
 * @param {string} root - directory (or file).
 * @param {number} [depth] - how deep to look.
 * @returns {string} the signature ('' when missing).
 */
export function treeSignature(root, depth = 4) {
  let n = 0
  let sum = 0
  const walk = (p, d) => {
    let st
    try { st = statSync(p) } catch { return }
    n++
    sum += st.size + st.mtimeMs
    if (st.isDirectory() && d > 0) {
      let names = []
      try { names = readdirSync(p) } catch { return }
      for (const name of names) walk(join(p, name), d - 1)
    }
  }
  walk(root, depth)
  return n === 0 ? '' : `${n}:${sum}`
}

/**
 * Watch directories and call `onChange` (debounced) when anything under them changes. Uses
 * `fs.watch` where it works; a directory that is missing or cannot be watched is polled instead
 * (and retried), so the page still catches up.
 * @param {() => string[]} targets - the directories to watch (re-evaluated on each poll).
 * @param {() => void} onChange - called after a quiet period.
 * @param {{debounceMs?: number, pollMs?: number, ignore?: (name: string) => boolean}} [opts] - tuning.
 * @returns {{close: () => void}} handle.
 */
export function watchChanges(targets, onChange, opts = {}) {
  const deb = debounce(onChange, opts.debounceMs ?? 300)
  const watchers = new Map()
  const sigs = new Map()
  const attach = dir => {
    if (watchers.has(dir) || !existsSync(dir)) return
    try {
      const w = watch(dir, { recursive: true }, (_e, name) => { if (!name || !opts.ignore?.(String(name))) deb.trigger() })
      w.on('error', () => { try { w.close() } catch { /* gone */ } watchers.delete(dir) })
      watchers.set(dir, w)
    } catch { /* polled */ }
  }
  const poll = () => {
    for (const dir of targets()) {
      attach(dir)
      if (watchers.has(dir)) continue
      const sig = treeSignature(dir)
      if (sigs.has(dir) && sigs.get(dir) !== sig) deb.trigger()
      sigs.set(dir, sig)
    }
  }
  poll()
  const timer = setInterval(poll, opts.pollMs ?? 2000)
  timer.unref()
  return {
    close() {
      clearInterval(timer)
      deb.cancel()
      for (const w of watchers.values()) { try { w.close() } catch { /* already closed */ } }
      watchers.clear()
    },
  }
}

/**
 * Script injected into the served page: on a `changed` event it refetches the page and swaps the
 * document in place (no navigation), keeping the scroll position and the token query.
 * @returns {string} an HTML script element.
 */
export function liveClientScript() {
  return `<script>
(function () {
  if (!window.EventSource) return;
  var es = new EventSource('events' + location.search);
  es.addEventListener('changed', function () {
    fetch(location.href, { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : null }).then(function (html) {
      if (!html) return;
      var y = window.scrollY;
      es.close();
      document.open(); document.write(html); document.close();
      window.scrollTo(0, y);
    }).catch(function () {});
  });
})();
</script>`
}

/**
 * Serve the dashboard. `render()` is called lazily and cached until the next change.
 * @param {object} o - options.
 * @param {() => string} o.render - builds the page HTML.
 * @param {string} [o.host] - bind address (default loopback).
 * @param {number} [o.port] - port (0 = ephemeral).
 * @param {string} [o.token] - required when `host` is not loopback; if given, enforced on loopback too.
 * @param {() => string[]} [o.targets] - directories to watch.
 * @param {number} [o.debounceMs] - change debounce.
 * @param {number} [o.pollMs] - polling fallback interval.
 * @param {number} [o.heartbeatMs] - SSE keep-alive interval.
 * @returns {Promise<{url: string, port: number, host: string, notify: () => void, close: () => Promise<void>}>} the running server.
 */
export async function startDashboardServer(o) {
  const host = o.host ?? DEFAULT_HOST
  const plan = bindPlan(host)
  if (o.token) plan.requireToken = true
  if (bindPlan(host).requireToken && !o.token) throw new Error(`refusing to bind ${host}: a non-loopback address needs a token`)
  let version = 0
  let cached
  const clients = new Set()
  const notify = () => {
    version++
    cached = undefined
    for (const res of clients) res.write(sseFrame('changed', { version }, version))
  }
  const watcher = watchChanges(o.targets ?? (() => []), notify, {
    debounceMs: o.debounceMs, pollMs: o.pollMs, ignore: n => /dashboard\.html$/.test(n),
  })
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n') }, o.heartbeatMs ?? 25000)
  heartbeat.unref()

  const server = createServer((req, res) => {
    const deny = (code, msg) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(msg) }
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'method not allowed')
    if (plan.loopback && !hostAllowed(req.headers.host)) return deny(403, 'forbidden host')
    if (plan.requireToken && !tokenOk(requestToken(req.url ?? '/', req.headers), o.token)) return deny(401, 'token required')
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      res.write('retry: 2000\n' + sseFrame('hello', { version }))
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return undefined
    }
    if (path === '/' || path === '/index.html') {
      try {
        cached ??= o.render().replace('</body>', liveClientScript() + '</body>')
      } catch (e) { return deny(500, `render failed: ${e?.message ?? e}`) }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(req.method === 'HEAD' ? undefined : cached)
    }
    return deny(404, 'not found')
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(o.port ?? DEFAULT_PORT, host, resolve) })
  const port = server.address().port
  const shown = host.includes(':') ? `[${host}]` : host
  return {
    host, port, notify,
    url: `http://${shown}:${port}/`,
    close() {
      watcher.close()
      clearInterval(heartbeat)
      for (const res of clients) res.end()
      clients.clear()
      server.closeAllConnections?.()
      return new Promise(resolve => server.close(() => resolve()))
    },
  }
}
