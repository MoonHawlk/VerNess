/**
 * Process management: tree kill (T-433) and the run registry behind `/task list|cancel` (T-169).
 * Pure helpers take their spawn/kill/liveness as parameters so tests never touch real processes.
 * @module scripts/lib/procs
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The command that kills a whole process tree, where the platform needs one.
 * @param {number} pid - the tree's root.
 * @param {NodeJS.Platform} [platform] - target platform.
 * @returns {{cmd: string, args: string[]}|null} `taskkill /T /F` on Windows; null elsewhere (a process group signal does it).
 */
export function killCommand(pid, platform = process.platform) {
  return platform === 'win32' ? { cmd: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] } : null
}

/**
 * Kill a process and everything it started. Windows: `taskkill /T /F`. Elsewhere the child must have
 * been spawned `detached` (own process group): SIGTERM the group, then SIGKILL after `grace` ms.
 * @param {number} pid - root pid.
 * @param {{platform?: NodeJS.Platform, spawn?: Function, kill?: Function, grace?: number, force?: boolean, timer?: Function}} [o] - injectable effects; `force` skips the grace (exit hooks).
 * @returns {boolean} whether the kill was issued.
 */
export function killTree(pid, o = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const { platform = process.platform, spawn = spawnSync, kill = process.kill, grace = 1500, force = false, timer = setTimeout } = o
  const cmd = killCommand(pid, platform)
  const sig = force ? 'SIGKILL' : 'SIGTERM'
  if (cmd !== null) {
    try { spawn(cmd.cmd, cmd.args, { stdio: 'ignore', windowsHide: true }); return true } catch { return false }
  }
  try { kill(-pid, sig) } catch {
    try { kill(pid, sig) } catch { return false }
  }
  if (!force) {
    const t = timer(() => {
      try { kill(-pid, 0); kill(-pid, 'SIGKILL') } catch { /* group already gone */ }
    }, grace)
    t?.unref?.()
  }
  return true
}

/** @param {number} pid - a pid. @returns {boolean} whether the process exists. */
export function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** @param {string} file - a job file. @returns {object|undefined} its record. */
function readJob(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}

/**
 * Read the registry, deleting entries whose owner process is dead.
 * @param {string} root - the jobs directory.
 * @param {{alive?: (pid: number) => boolean}} [o] - liveness check (injectable).
 * @returns {{id: string, kind: string, label: string, started: string, heartbeat: string, owner: number, pids: number[], cancelled?: boolean}[]} live jobs, oldest first.
 */
export function readJobs(root, { alive = isAlive } = {}) {
  if (!existsSync(root)) return []
  const out = []
  for (const f of readdirSync(root).filter(n => n.endsWith('.json'))) {
    const file = join(root, f)
    const j = readJob(file)
    if (j === undefined) continue
    if (j === null || typeof j !== 'object' || !Number.isInteger(j.owner) || !alive(j.owner)) {
      try { rmSync(file, { force: true }) } catch { /* raced with its owner */ }
      continue
    }
    out.push({ ...j, pids: (Array.isArray(j.pids) ? j.pids : []).filter(p => alive(p)) })
  }
  return out.sort((a, b) => (a.started < b.started ? -1 : 1))
}

/**
 * Register a running job. The handle tracks child pids, beats a heartbeat, and removes the file.
 * @param {string} root - the jobs directory.
 * @param {{kind: string, label: string}} what - what is running.
 * @param {{owner?: number, beatMs?: number}} [o] - owner pid (default this process) and heartbeat period.
 * @returns {{id: string, track: (child: {pid?: number, once: Function}) => void, cancelled: () => boolean, remove: () => void}} the handle.
 */
export function registerJob(root, { kind, label }, { owner = process.pid, beatMs = 5000 } = {}) {
  mkdirSync(root, { recursive: true })
  const id = `${kind}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const file = join(root, `${id}.json`)
  const rec = { id, kind, label: String(label).slice(0, 120), started: new Date().toISOString(), heartbeat: '', owner, pids: [] }
  const save = () => {
    rec.heartbeat = new Date().toISOString()
    try {
      // Keep a cancel flag another process wrote.
      if (readJob(file)?.cancelled === true) rec.cancelled = true
      writeFileSync(file, JSON.stringify(rec), 'utf8')
    } catch { /* registry is advisory */ }
  }
  save()
  const timer = setInterval(save, beatMs)
  timer.unref()
  return {
    id,
    track(child) {
      if (!Number.isInteger(child?.pid)) return
      rec.pids.push(child.pid)
      save()
      child.once('close', () => { rec.pids = rec.pids.filter(p => p !== child.pid); save() })
    },
    cancelled: () => readJob(file)?.cancelled === true,
    remove() { clearInterval(timer); try { rmSync(file, { force: true }) } catch { /* gone */ } },
  }
}

/**
 * Cancel a job: flag it (so its owner stops starting work) and kill its processes' trees.
 * @param {string} root - the jobs directory.
 * @param {string} id - job id or a unique prefix.
 * @param {{kill?: (pid: number) => boolean, alive?: (pid: number) => boolean}} [o] - injectable effects.
 * @returns {{ok: boolean, job?: object, killed?: number[], error?: string}} the outcome.
 */
export function cancelJob(root, id, { kill = killTree, alive = isAlive } = {}) {
  const hits = readJobs(root, { alive }).filter(j => j.id === id || j.id.startsWith(id))
  const job = hits.find(j => j.id === id) ?? (hits.length === 1 ? hits[0] : undefined)
  if (job === undefined) return { ok: false, error: hits.length > 1 ? `ambiguous: ${hits.map(j => j.id).join(', ')}` : `no running job ${id}` }
  const file = join(root, `${job.id}.json`)
  try { writeFileSync(file, JSON.stringify({ ...readJob(file), cancelled: true }), 'utf8') } catch { /* best effort */ }
  const killed = job.pids.filter(p => kill(p))
  return { ok: true, job, killed }
}
