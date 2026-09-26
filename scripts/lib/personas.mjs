/**
 * Persona loading and per-run persona overlays.
 *
 * A persona is a file in `personas/<id>.json`: identity, prompt text, model preference, tool policy,
 * skills, tips and evaluators. Today the substrate enforces the *prompt* part (through the
 * `system-prompt` seam) and the *model* part (through `agent-default-model`); `tools`, `skills` and
 * `evaluators` are recorded and take effect when M4–M7 land. `describePersona` says which is which,
 * so no surface ever implies unimplemented policy is active.
 *
 * A persona can also be applied to a single run without touching the profile, by writing a
 * `--patch` overlay — the documented way to layer configuration over a composed profile. That is
 * what lets one team run several personas concurrently.
 * @module scripts/lib/personas
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { parseJsonc, REPO, RUN_DIR } from './util.mjs'

/** @returns {string} the persona directory. */
export const personasDir = () => join(REPO, 'personas')

/**
 * Load every persona: files in `personas/`, plus any inline definitions from the config (files win).
 * @param {object} cfg - the VerNess configuration.
 * @returns {Map<string, object>} personas by id.
 */
export function loadPersonas(cfg) {
  const out = new Map()
  for (const [id, p] of Object.entries(cfg.personas?.definitions ?? {})) {
    out.set(id, normalize(id, { ...p, source: 'verness.config.json' }))
  }
  const dir = personasDir()
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      const id = f.replace(/\.json$/, '')
      try {
        const raw = parseJsonc(readFileSync(join(dir, f), 'utf8'))
        out.set(raw.id ?? id, normalize(raw.id ?? id, { ...raw, source: `personas/${f}` }))
      } catch (e) {
        out.set(id, normalize(id, { name: id, broken: String(e.message), source: `personas/${f}` }))
      }
    }
  }
  return out
}

/**
 * Fill in the optional shape so every consumer can read the same fields.
 * @param {string} id - persona id.
 * @param {object} p - the raw persona.
 * @returns {object} the normalized persona.
 */
function normalize(id, p) {
  return {
    id,
    name: p.name ?? id,
    description: p.description ?? '',
    prefix: p.prefix ?? p.prompt?.prefix ?? '',
    suffix: p.suffix ?? p.prompt?.suffix ?? '',
    tips: p.tips ?? [],
    model: p.model ?? {},
    tools: { allow: p.tools?.allow ?? [], deny: p.tools?.deny ?? [] },
    skills: p.skills ?? [],
    evaluators: p.evaluators ?? [],
    source: p.source ?? 'unknown',
    broken: p.broken,
  }
}

/**
 * The persona that is currently active: the local state override, else the config's choice.
 * @param {object} cfg - the VerNess configuration.
 * @returns {string} the active persona id.
 */
export function activePersonaId(cfg) {
  const state = readState()
  return state.persona ?? cfg.personas?.active ?? 'generalist'
}

/** @returns {object} the launcher's local state (never committed). */
export function readState() {
  try { return JSON.parse(readFileSync(join(RUN_DIR, '..', 'state.json'), 'utf8')) } catch { return {} }
}

/**
 * Persist launcher state — the active persona lives here rather than in the config, so switching
 * persona never rewrites a file the user is editing.
 * @param {object} patch - fields to merge into the state.
 */
export function writeState(patch) {
  const file = join(RUN_DIR, '..', 'state.json')
  mkdirSync(join(RUN_DIR, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ ...readState(), ...patch }, null, 2)}\n`, 'utf8')
}

/**
 * Compose the prompt text a persona contributes: its prefix, and its suffix followed by the global
 * tips and its own.
 * @param {object} persona - a normalized persona.
 * @param {string[]} globalTips - `tips` from the configuration.
 * @returns {{prefix: string, suffix: string}} the prompt contribution.
 */
export function personaPrompt(persona, globalTips = []) {
  const tips = [...globalTips, ...persona.tips].filter(t => String(t).trim() !== '')
  const suffix = [persona.suffix, ...tips.map(t => `- ${t}`)].filter(s => s !== '').join('\n')
  return { prefix: persona.prefix, suffix }
}

/**
 * Human-readable persona report that distinguishes enforced fields from recorded ones.
 * @param {object} p - a normalized persona.
 * @returns {string[]} the lines to print.
 */
export function describePersona(p) {
  const lines = [
    `${p.name}  (${p.id})`,
    p.description === '' ? undefined : `  ${p.description}`,
    `  source: ${p.source}`,
    `  prompt: ${p.prefix === '' ? 'no prefix' : `${p.prefix.length} chars prefix`}, ${p.suffix === '' ? 'no suffix' : `${p.suffix.length} chars suffix`}   [enforced]`,
    `  model: ${p.model.id ?? 'inherits the active route'}${p.model.route === undefined ? '' : ` via ${p.model.route}`}   [enforced]`,
    `  tools: allow ${p.tools.allow.length}, deny ${p.tools.deny.length}   [recorded — enforced from M4]`,
    `  skills: ${p.skills.length === 0 ? 'none' : p.skills.join(', ')}   [recorded — enforced from M5]`,
    `  evaluators: ${p.evaluators.length === 0 ? 'none' : p.evaluators.join(', ')}   [recorded — enforced from M7]`,
  ]
  if (p.broken !== undefined) lines.push(`  BROKEN: ${p.broken}`)
  return lines.filter(l => l !== undefined)
}

/**
 * Write a `--patch` overlay that applies one persona to a single run, without changing the profile.
 * Used by the team runner so concurrent tasks can wear different personas.
 * @param {object} persona - a normalized persona.
 * @param {object} cfg - the VerNess configuration.
 * @param {string} [file] - where to write it. Concurrent runs must each pass their own: rewriting the
 *   shared per-persona file while another run's dsh is still reading it could hand that run a
 *   truncated overlay.
 * @returns {string} the overlay path, to pass as `dsh --patch <path>`.
 */
export function writePersonaOverlay(persona, cfg, file = join(RUN_DIR, `persona-${persona.id}.patch.yml`)) {
  const { prefix, suffix } = personaPrompt(persona, cfg.tips ?? [])
  const q = s => `'${String(s).replaceAll("'", "''")}'`
  const block = (key, text, pad) => (text.includes('\n')
    ? [`${pad}${key}: |-`, ...text.split('\n').map(l => `${pad}  ${l}`)]
    : [`${pad}${key}: ${q(text)}`])
  const L = [
    `# GENERATED per-run overlay for persona "${persona.id}" — safe to delete.`,
    '- id: system-prompt',
    '  config:',
    ...block('personaPrefix', prefix, '    '),
    ...block('personaSuffix', `${suffix}\nYour working directory is {{cwd}}.`, '    '),
  ]
  if (persona.model.id !== undefined) {
    L.push('- id: agent-default-model', '  config:',
      // A persona model without a route is a local model preference (see lib/routes.mjs).
      `    provider: ${persona.model.route ?? cfg.model.route}`,
      `    model: ${q(persona.model.id)}`)
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${L.join('\n')}\n`, 'utf8')
  return file
}
