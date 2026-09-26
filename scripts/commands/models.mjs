/**
 * `/models` — install and manage local models without editing the config.
 *
 *   /models                         what is registered, what the engine holds, which one is active
 *   /models search <words>          GGUF repos on Hugging Face, most downloaded first
 *   /models add <ref> [--use]       fetch, register and warm a model; --use also switches to it
 *   /models rm <ref> [--purge]      unregister; --purge also deletes the weights from disk
 *
 * `<ref>` may be a Hugging Face URL, `hf.co/<org>/<repo>[:<quant>]`, `<org>/<repo>[:<quant>]`, or an
 * engine-registry name such as `qwen3:1.7b`. For a Hugging Face repo the quant is checked against the
 * files the repo actually publishes — a quant that does not exist there is the most common failed
 * pull (docs/06-SETUP-AND-LAUNCHER.md, "two traps") — and a sensible one is chosen when omitted.
 *
 * Registered models live in `.verness/state.json` (`localModels`), so the committed config is never
 * rewritten. Zero tokens: everything here talks to the engine and to Hugging Face, never to a model.
 * @module scripts/commands/models
 */

import { modelUp } from '../model.mjs'
import { effectiveRoute, localModels } from '../lib/routes.mjs'
import { readState, writeState } from '../lib/personas.mjs'
import { head, info, ok, paint, step, warn } from '../lib/util.mjs'

const HF = 'https://huggingface.co'
/** Quants tried in order when a Hugging Face ref names none: good quality per byte first. */
const PREFERRED_QUANTS = ['Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'Q4_0']

/**
 * @param {string} url - absolute URL.
 * @returns {Promise<any>} the parsed JSON body, or undefined when unreachable or not found.
 */
async function getJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: process.env.HF_TOKEN === undefined ? {} : { authorization: `Bearer ${process.env.HF_TOKEN}` } })
    return r.ok ? await r.json() : undefined
  } catch { return undefined }
}

/** @param {number} n - bytes. @returns {string} a human size. */
const size = n => (n === undefined ? '?' : n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GiB` : `${Math.round(n / 2 ** 20)} MiB`)

/**
 * Split a user reference into a Hugging Face repo + quant, or an engine-registry name.
 * @param {string} input - what the user typed.
 * @returns {{kind: 'hf', repo: string, quant?: string} | {kind: 'registry', name: string}} the parsed reference.
 */
export function parseRef(input) {
  let s = input.trim()
  const url = /^https?:\/\/(?:www\.)?(?:huggingface\.co|hf\.co)\/([^/\s]+\/[^/\s:?#]+)/i.exec(s)
  if (url !== null) return { kind: 'hf', repo: url[1] }
  s = s.replace(/^(?:hf\.co|huggingface\.co)\//i, '')
  const [path, quant] = s.split(':')
  // Registry names have no slash (`qwen3:1.7b`), Hugging Face repos always do (`org/repo`).
  if (!path.includes('/')) return { kind: 'registry', name: s }
  return { kind: 'hf', repo: path, quant: quant === undefined || quant === '' ? undefined : quant }
}

/**
 * The quants a Hugging Face repo publishes as GGUF files, with their sizes.
 * @param {string} repo - `<org>/<repo>`.
 * @returns {Promise<Map<string, number|undefined>|undefined>} quant -> bytes; undefined if the repo
 *   cannot be read.
 */
async function repoQuants(repo) {
  const meta = await getJson(`${HF}/api/models/${repo}?blobs=true`)
  if (meta === undefined) return undefined
  const out = new Map()
  for (const f of meta.siblings ?? []) {
    const name = String(f.rfilename ?? '')
    // Projector files carry vision weights, not the model; they are not pullable tags on their own.
    if (!name.toLowerCase().endsWith('.gguf') || /mmproj/i.test(name)) continue
    const m = /[-_.]((?:I?Q\d[A-Z0-9_]*)|BF16|F16|F32)(?:-\d{5}-of-\d{5})?\.gguf$/i.exec(name)
    if (m === null) continue
    const q = m[1].toUpperCase()
    out.set(q, (out.get(q) ?? 0) + (f.size ?? f.lfs?.size ?? 0) || undefined)
  }
  return out
}

/**
 * Resolve a reference to the exact tag the engine will pull, validating it where we can.
 * @param {string} input - what the user typed.
 * @returns {Promise<{ref: string, note?: string}|{error: string, hint?: string}>} the pull tag.
 */
async function resolveRef(input) {
  const p = parseRef(input)
  if (p.kind === 'registry') return { ref: p.name, note: 'from the engine registry (not Hugging Face)' }
  const quants = await repoQuants(p.repo)
  if (quants === undefined) return { error: `cannot read ${HF}/${p.repo}`, hint: 'check the name, your network, or set HF_TOKEN in .env for gated repos' }
  if (quants.size === 0) return { error: `${p.repo} publishes no GGUF files`, hint: `find a GGUF conversion: /models search ${p.repo.split('/')[1]}` }
  const available = [...quants.keys()]
  if (p.quant !== undefined) {
    const hit = available.find(q => q === p.quant.toUpperCase())
    if (hit === undefined) return { error: `${p.repo} has no ${p.quant} quant`, hint: `available: ${available.join(', ')}` }
    return { ref: `hf.co/${p.repo}:${hit}`, note: `${hit}, ${size(quants.get(hit))}` }
  }
  const pick = PREFERRED_QUANTS.find(q => quants.has(q)) ?? available[0]
  return { ref: `hf.co/${p.repo}:${pick}`, note: `${pick} chosen (${size(quants.get(pick))}); others: ${available.filter(q => q !== pick).join(', ') || 'none'}` }
}

/**
 * @param {object} ctx - command context.
 * @returns {string[][]} rows of [name, size] from the engine's own list, or [] when it is down.
 */
function engineList(ctx) {
  const r = ctx.sh('ollama', ['list'], { capture: true, allowFail: true })
  if (r.code !== 0) return []
  return r.out.split('\n').slice(1).map(l => l.split(/\s\s+/)).filter(c => c[0] !== undefined && c[0].trim() !== '').map(c => [c[0], c[2] ?? ''])
}

export default {
  name: 'models',
  group: 'model',
  summary: 'install, list, search and remove local models (Hugging Face GGUF or registry)',
  usage: '/models [list | search <words> | add <ref> [--use] | rm <ref> [--purge]]',
  /**
   * @param {object} ctx - command context.
   * @param {string[]} args - subcommand and arguments.
   * @returns {Promise<number>} exit code.
   */
  async run(ctx, args) {
    const [sub = 'list', ...rest] = args
    const flags = new Set(rest.filter(a => a.startsWith('--')))
    const words = rest.filter(a => !a.startsWith('--'))

    if (sub === 'list') {
      const eff = effectiveRoute(ctx.cfg)
      const pulled = engineList(ctx)
      const has = new Set(pulled.map(p => p[0]))
      head(`local models (route ${ctx.cfg.model.route})`)
      for (const id of localModels(ctx.cfg)) {
        const active = eff.route?.kind === 'local' && eff.model === id
        const present = has.has(id) || has.has(`${id}:latest`)
        console.log(`  ${active ? paint('green', '*') : ' '} ${id}  ${paint('dim', present ? 'on disk' : 'not pulled yet')}`)
      }
      const extra = pulled.filter(p => !localModels(ctx.cfg).includes(p[0]))
      if (extra.length > 0) {
        info('also on disk, not registered (register with /models add <name>):')
        for (const [n, s] of extra) info(`  ${n}  ${s}`)
      }
      if (eff.route?.kind !== 'local') info(`the active route is ${eff.name} (API) - /api local switches back`)
      info('add one: /models add <hugging face url | org/repo[:quant] | registry-name> [--use]')
      return 0
    }

    if (sub === 'search') {
      if (words.length === 0) { warn('usage: /models search <words>'); return 1 }
      const q = encodeURIComponent(words.join(' '))
      const hits = await getJson(`${HF}/api/models?search=${q}&filter=gguf&sort=downloads&direction=-1&limit=12`)
      if (hits === undefined) { warn('Hugging Face did not answer'); return 1 }
      if (hits.length === 0) { info('no GGUF repos match'); return 0 }
      head(`GGUF repos matching "${words.join(' ')}" (most downloaded first)`)
      for (const h of hits) console.log(`  ${String(h.id).padEnd(52)} ${paint('dim', `${h.downloads ?? 0} downloads`)}`)
      info('install one: /models add <org/repo> (the quant is chosen for you, or add :Q8_0 etc.)')
      return 0
    }

    if (sub === 'add') {
      if (words.length === 0) { warn('usage: /models add <ref> [--use]'); return 1 }
      step(`resolving ${words[0]}`)
      const res = await resolveRef(words[0])
      if ('error' in res) { warn(res.error); if (res.hint !== undefined) info(res.hint); return 1 }
      ok(`${res.ref}${res.note === undefined ? '' : ` - ${res.note}`}`)
      // modelUp starts the engine if needed, pulls the weights, and warms them - one code path for
      // the configured model and every added one.
      if (!(await modelUp(ctx.cfg, res.ref))) { warn(`could not bring up ${res.ref}`); return 1 }
      const state = readState()
      writeState({ localModels: [...new Set([...(state.localModels ?? []), res.ref])] })
      if (flags.has('--use')) {
        writeState({ route: undefined, model: res.ref, modelRoute: ctx.cfg.model.route })
        ctx.sync()
        ok(`registered and active: the next task runs on ${res.ref}`)
      } else {
        ctx.sync()
        ok(`registered ${res.ref}`)
        info(`switch to it with /model ${res.ref}`)
      }
      return 0
    }

    if (sub === 'rm' || sub === 'remove') {
      if (words.length === 0) { warn('usage: /models rm <ref> [--purge]'); return 1 }
      const target = words[0]
      const state = readState()
      if (target === (ctx.cfg.model.source ?? ctx.cfg.model.id)) { warn('that is the configured model; change model.source in verness.config.json instead'); return 1 }
      writeState({ localModels: (state.localModels ?? []).filter(m => m !== target) })
      if (state.model === target) writeState({ model: undefined, modelRoute: undefined })
      ctx.sync()
      ok(`unregistered ${target}`)
      if (flags.has('--purge')) {
        const r = ctx.sh('ollama', ['rm', target], { capture: true, allowFail: true })
        if (r.code === 0) ok('weights deleted from disk')
        else warn(`the engine could not delete it: ${r.out.split('\n').pop()}`)
      } else info('weights kept on disk; add --purge to delete them')
      return 0
    }

    warn(`unknown subcommand: ${sub}`)
    info(this.usage)
    return 1
  },
}
