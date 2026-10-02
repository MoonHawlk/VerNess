/**
 * `/recipe` - reusable task templates (`recipes/*.md`, format in `scripts/lib/recipes.mjs`). With no
 * name it lists them; with one it fills the template and queues it as the next task, wearing the
 * recipe's persona for that one task only (the active persona is not switched).
 * @module scripts/commands/recipe
 */

import { join } from 'node:path'

import { loadPersonas, writePersonaOverlay } from '../lib/personas.mjs'
import { bindArgs, fillRecipe, loadRecipes, recipeUsage } from '../lib/recipes.mjs'
import { head, info, REPO, RUN_DIR, warn } from '../lib/util.mjs'

export default {
  name: 'recipe',
  group: 'core',
  // The task is queued onto the terminal REPL's turn loop; the browser has no such seam.
  web: false,
  summary: 'run a task template: /recipe [<name> [args | key=value ...]]',
  usage: '/recipe [<name> [args... | key=value...]]',
  details: [
    'recipes are markdown files in recipes/ with a small front-matter; add your own there',
    'positional words fill the args in order (the last arg takes the rest); key=value sets one by name',
    'a recipe may name a persona; it applies to that task only',
  ],
  /**
   * @param {object} ctx - command context; `ctx.queueTask` hands the filled task to the REPL.
   * @param {string[]} args - recipe name, then its arguments.
   * @returns {number} exit code.
   */
  run(ctx, args) {
    const { recipes, problems } = loadRecipes(ctx.recipesDir ?? join(REPO, 'recipes'))
    for (const p of problems) warn(`recipes/${p}`)
    if (args.length === 0) {
      head('recipes')
      if (recipes.size === 0) info('none - add recipes/<name>.md')
      for (const r of recipes.values()) console.log(`  ${recipeUsage(r).padEnd(44)} ${r.summary}`)
      info('run one with /recipe <name> <args>')
      return 0
    }
    const r = recipes.get(args[0])
    if (r === undefined) {
      warn(`no such recipe: ${args[0]}`)
      info(`available: ${[...recipes.keys()].join(', ') || '(none)'}`)
      return 1
    }
    const { values, missing } = bindArgs(r, args.slice(1))
    if (missing.length > 0) {
      warn(`/recipe ${r.name} needs: ${missing.join(', ')}`)
      info(`usage: /recipe ${recipeUsage(r)}`)
      return 1
    }
    let overlay
    if (r.persona !== undefined) {
      const persona = loadPersonas(ctx.cfg).get(r.persona)
      if (persona === undefined) { warn(`recipe ${r.name} names an unknown persona: ${r.persona}`); return 1 }
      overlay = writePersonaOverlay(persona, ctx.cfg, join(RUN_DIR, `recipe-${r.name}.patch.yml`))
    }
    if (ctx.queueTask === undefined) { warn('/recipe sends a task, so it only works in the terminal REPL'); return 1 }
    info(`recipe ${r.name}${r.persona === undefined ? '' : ` as ${r.persona}`}`)
    ctx.queueTask({ text: fillRecipe(r, values), overlay })
    return 0
  },
}
