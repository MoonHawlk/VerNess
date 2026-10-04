/**
 * The environment FiNess gives an engine it starts: the route's context window, flash attention,
 * and an optional quantized KV cache.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { engineEnv } from '../model.mjs'

test('engineEnv carries the context window, flash attention and a valid KV cache type', () => {
  assert.deepEqual(engineEnv({ contextWindow: 65536 }), { OLLAMA_CONTEXT_LENGTH: '65536', OLLAMA_FLASH_ATTENTION: '1' })
  assert.deepEqual(engineEnv({ contextWindow: 65536, kvCache: 'q8_0' }), { OLLAMA_CONTEXT_LENGTH: '65536', OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0' })
  assert.deepEqual(engineEnv({ flashAttention: false, kvCache: 'bogus' }), {})
})

test('machineModelOverrides takes the window and KV cache from this machine\'s environment', async () => {
  const { machineModelOverrides } = await import('../finess.mjs')
  const base = { contextWindow: 32768, kvCache: undefined, id: 'm' }
  assert.deepEqual(machineModelOverrides(base, { FINESS_CONTEXT_WINDOW: '65536', FINESS_KV_CACHE: 'q8_0' }), { contextWindow: 65536, kvCache: 'q8_0', id: 'm' })
  assert.deepEqual(machineModelOverrides(base, { FINESS_CONTEXT_WINDOW: 'lots', FINESS_KV_CACHE: 'q2' }), base)
  assert.deepEqual(machineModelOverrides(base, {}), base)
})
