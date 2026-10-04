import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

import { pluginOnSurface } from '../finess.mjs'

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')

/** Load client.js the way the substrate's module table does, with React stubbed. */
function loadClient() {
  let loaded
  const window = { __ModuleLoader__: { load: m => { loaded = m } } }
  vm.runInNewContext(read('packages/client-ui-brand/client.js'), { window, encodeURIComponent })
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) }
  return loaded.factory(id => { assert.equal(id, 'react'); return React })
}

test('the bundle registers under the package id', () => {
  let id
  vm.runInNewContext(read('packages/client-ui-brand/client.js'), { window: { __ModuleLoader__: { load: m => { id = m.id } } }, encodeURIComponent })
  assert.equal(id, JSON.parse(read('packages/client-ui-brand/package.json')).name)
})

test('apply occupies exactly the three brand slots', () => {
  const api = loadClient()
  assert.deepEqual([...api.inject], ['slots'])
  const registered = []
  const injected = []
  const slots = {
    inject: (key, cb) => { injected.push(key); const r = cb(); if (r?.[Symbol.iterator] && typeof r !== 'function') for (const _ of r) { /* run the yields */ } },
    register: (opts, component) => { registered.push([opts.name, component, opts.priority]); return () => {} },
  }
  api.apply({ slots, effect: () => {} })
  assert.deepEqual(injected, ['sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark'])
  assert.deepEqual(registered.map(r => r[0]), ['sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark'])
  assert.equal(registered[0][1], api.Mark)
  assert.equal(registered[1][1], api.Name)
  assert.ok(registered.every(r => r[2] < 0), 'below the official brand (priority 0), or the single slot throws')
})

test('mark is an accessible svg that honours size; name says FiNess', () => {
  const api = loadClient()
  const mark = api.Mark({ size: 34, className: 'x' })
  assert.equal(mark.type, 'svg')
  assert.equal(mark.props.width, 34)
  assert.equal(mark.props.role, 'img')
  assert.equal(mark.props['aria-label'], 'FiNess')
  assert.equal(api.Name().children[0], 'FiNess')
})

test('brandDocument rewrites the substrate title and restores it', () => {
  const api = loadClient()
  const attrs = {}
  const link = { getAttribute: k => attrs[k] ?? null, setAttribute: (k, v) => { attrs[k] = v }, removeAttribute: k => { delete attrs[k] } }
  const doc = { title: 'DSH Local Build', querySelector: () => null, querySelectorAll: () => [link], head: null }
  const undo = api.brandDocument(doc)
  assert.equal(doc.title, 'FiNess')
  assert.match(attrs.href, /^data:image\/svg\+xml,/)
  undo()
  assert.equal(doc.title, 'DSH Local Build')
  assert.equal(attrs.href, undefined)
})

test('the web row is configured for the web surface only', () => {
  const cfg = JSON.parse(read('finess.config.json').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[\]}])/g, '$1'))
  const row = cfg.settings.plugins.find(p => p.package === '@finess/client-ui-brand')
  assert.ok(row)
  assert.equal(row.path, 'packages/client-ui-brand')
  assert.equal(pluginOnSurface(row, 'web'), true)
  assert.equal(pluginOnSurface(row, 'headless'), false)
  const pkg = JSON.parse(read('packages/client-ui-brand/package.json'))
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './client.js')
})
