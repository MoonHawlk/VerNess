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
