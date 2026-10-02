/** Recipes: front-matter parsing, argument binding, filling, and the shipped starters. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { bindArgs, fillRecipe, loadRecipes, parseRecipe, recipeUsage } from '../lib/recipes.mjs'
import { loadPersonas } from '../lib/personas.mjs'
import { REPO } from '../lib/util.mjs'

const SRC = '---\nname: demo\nsummary: a demo\npersona: reviewer\nargs: path, focus=bugs, note\n---\nLook at {{path}} for {{focus}}. {{ note }} {{other}}\n'

test('parseRecipe reads front-matter, args with defaults and the body', () => {
  const r = parseRecipe(SRC)
  assert.equal(r.name, 'demo')
  assert.equal(r.summary, 'a demo')
  assert.equal(r.persona, 'reviewer')
  assert.deepEqual(r.args, [{ name: 'path' }, { name: 'focus', default: 'bugs' }, { name: 'note' }])
  assert.equal(r.body, 'Look at {{path}} for {{focus}}. {{ note }} {{other}}')
})

test('parseRecipe tolerates CRLF and a BOM, and falls back to the file stem', () => {
  const r = parseRecipe('﻿---\r\nsummary: x\r\n---\r\nhi\r\n', 'stem')
  assert.equal(r.name, 'stem')
  assert.equal(r.body, 'hi')
})

test('parseRecipe rejects bad files', () => {
  assert.match(parseRecipe('no fences').error, /front-matter/)
  assert.match(parseRecipe('---\nname: a\n---\n').error, /empty body/)
  assert.match(parseRecipe('---\nname: a b\n---\nx').error, /bad recipe name/)
  assert.match(parseRecipe('---\nnonsense\n---\nx').error, /bad front-matter/)
  assert.match(parseRecipe('---\nname: a\nargs: x y\n---\nx').error, /bad arg name/)
})

test('bindArgs: positional, key=value, defaults, rest-joins-last, missing', () => {
  const r = parseRecipe(SRC)
  assert.deepEqual(bindArgs(r, ['src', 'perf', 'be', 'kind']), { values: { path: 'src', focus: 'perf', note: 'be kind' }, missing: [] })
  assert.deepEqual(bindArgs(r, ['src', 'note=hi']).values, { path: 'src', note: 'hi', focus: 'bugs' })
  assert.deepEqual(bindArgs(r, ['focus=x', 'src', 'n']).values, { focus: 'x', path: 'src', note: 'n' })
  assert.deepEqual(bindArgs(r, []).missing, ['path', 'note'])
  // an unknown key=value is just text, not a lost argument
  assert.equal(bindArgs(r, ['a=b', 'c', 'd']).values.path, 'a=b')
})

test('fillRecipe replaces known placeholders and leaves unknown ones', () => {
  const r = parseRecipe(SRC)
  const { values } = bindArgs(r, ['src', 'speed', 'ok'])
  assert.equal(fillRecipe(r, values), 'Look at src for speed. ok {{other}}')
})

test('recipeUsage marks optional args', () => {
  assert.equal(recipeUsage(parseRecipe(SRC)), 'demo <path> [focus=bugs] <note>')
})

test('loadRecipes skips and reports bad files; a missing dir is empty', () => {
  assert.equal(loadRecipes(join(REPO, 'no-such-dir')).recipes.size, 0)
})

test('the shipped recipes are valid, named by file, and use known personas and placeholders', () => {
  const { recipes, problems } = loadRecipes(join(REPO, 'recipes'))
  assert.deepEqual(problems, [])
  for (const n of ['code-review', 'write-tests', 'explain', 'summarize-docs', 'commit-message', 'plan']) assert.ok(recipes.has(n), n)
  const personas = loadPersonas({ personas: { active: 'generalist', definitions: {} } })
  for (const r of recipes.values()) {
    assert.equal(r.file, `${r.name}.md`)
    assert.ok(r.summary !== '', `${r.name} has a summary`)
    if (r.persona !== undefined) assert.ok(personas.has(r.persona), `${r.name}: persona ${r.persona}`)
    const used = [...r.body.matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)].map(m => m[1])
    for (const u of used) assert.ok(r.args.some(a => a.name === u), `${r.name}: {{${u}}} is not an arg`)
  }
  assert.match(recipes.get('commit-message').body, /git diff --staged/)
})
