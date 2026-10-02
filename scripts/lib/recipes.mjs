/**
 * Recipes: reusable task templates in `recipes/*.md`. A file is a tiny front-matter block (flat
 * `key: value` lines between `---` fences, no YAML) and a body with `{{arg}}` placeholders.
 *
 *   ---
 *   name: code-review
 *   summary: review a file or directory
 *   persona: reviewer            (optional: a persona overlay for this one task)
 *   args: path, focus=bugs       (comma list; `name=default` makes it optional)
 *   ---
 *   Review {{path}}, focusing on {{focus}}.
 *
 * Parsing, argument binding and filling are pure; only `loadRecipes` touches the disk.
 * @module scripts/lib/recipes
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** @typedef {{name: string, summary: string, persona?: string, args: {name: string, default?: string}[], body: string, file?: string}} Recipe */

/**
 * @param {string} text - a recipe file.
 * @param {string} [fallbackName] - name to use when the front-matter has none (the file stem).
 * @returns {Recipe | {error: string}} the recipe, or why the file is not one.
 */
export function parseRecipe(text, fallbackName = '') {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text)
  if (m === null) return { error: 'missing front-matter (--- fences)' }
  /** @type {Record<string, string>} */
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const i = line.indexOf(':')
    if (i < 1) return { error: `bad front-matter line: ${line.trim()}` }
    meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  const name = meta.name ?? fallbackName
  if (!/^[\w-]+$/.test(name)) return { error: `bad recipe name "${name}"` }
  const args = []
  for (const part of (meta.args ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=')
    const argName = (eq < 0 ? part : part.slice(0, eq)).trim()
    if (!/^[\w-]+$/.test(argName)) return { error: `bad arg name "${argName}"` }
    args.push(eq < 0 ? { name: argName } : { name: argName, default: part.slice(eq + 1).trim() })
  }
  const body = (m[2] ?? '').trim()
  if (body === '') return { error: 'empty body' }
  return { name, summary: meta.summary ?? '', ...(meta.persona ? { persona: meta.persona } : {}), args, body }
}

/**
 * Bind CLI words to a recipe's args: `key=value` words by name (a known key only), the rest
 * positionally into the args not set by key. Surplus positionals join the last free arg, so a
 * free-text arg like a goal needs no quoting.
 * @param {Recipe} recipe - the recipe.
 * @param {string[]} words - what followed the recipe name.
 * @returns {{values: Record<string, string>, missing: string[]}} bound values (defaults applied) and required args still unset.
 */
export function bindArgs(recipe, words) {
  const known = new Set(recipe.args.map(a => a.name))
  /** @type {Record<string, string>} */
  const values = {}
  const rest = []
  for (const w of words) {
    const eq = w.indexOf('=')
    if (eq > 0 && known.has(w.slice(0, eq))) values[w.slice(0, eq)] = w.slice(eq + 1)
    else rest.push(w)
  }
  const free = recipe.args.filter(a => values[a.name] === undefined)
  free.forEach((a, i) => {
    if (i >= rest.length) return
    values[a.name] = i < free.length - 1 ? rest[i] : rest.slice(i).join(' ')
  })
  for (const a of recipe.args) if (values[a.name] === undefined && a.default !== undefined) values[a.name] = a.default
  return { values, missing: recipe.args.filter(a => (values[a.name] ?? '') === '').map(a => a.name) }
}

/**
 * @param {Recipe} recipe - the recipe.
 * @param {Record<string, string>} values - arg values.
 * @returns {string} the body with every `{{arg}}` replaced; unknown placeholders are left as written.
 */
export function fillRecipe(recipe, values) {
  return recipe.body.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (all, k) => (values[k] ?? all))
}

/**
 * @param {string} dir - the recipes directory.
 * @returns {{recipes: Map<string, Recipe>, problems: string[]}} valid recipes by name (file order) and one line per bad file.
 */
export function loadRecipes(dir) {
  const recipes = new Map()
  const problems = []
  if (!existsSync(dir)) return { recipes, problems }
  for (const f of readdirSync(dir).filter(x => x.endsWith('.md')).sort()) {
    const r = parseRecipe(readFileSync(join(dir, f), 'utf8'), f.slice(0, -3))
    if ('error' in r) problems.push(`${f}: ${r.error}`)
    else recipes.set(r.name, { ...r, file: f })
  }
  return { recipes, problems }
}

/** @param {Recipe} r - a recipe. @returns {string} its usage line, e.g. `code-review <path> [focus=bugs]`. */
export const recipeUsage = r => [r.name, ...r.args.map(a => (a.default === undefined ? `<${a.name}>` : `[${a.name}=${a.default}]`))].join(' ')
