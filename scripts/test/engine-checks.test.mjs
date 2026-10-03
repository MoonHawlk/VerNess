/**
 * T-452: each "why the engine cannot start" check is a pure function over injected facts; the
 * only real I/O here is a temp dir and a throwaway local TCP server.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'

import {
  checkBinary, checkDisk, checkHostEnv, checkModelsDir, checkPort, estimateModelBytes, hintForLog,
  lastErrorLine, parseOllamaHost, probePort, runChecks,
} from '../lib/engine-checks.mjs'
import { hiddenStartCommand, startBackground } from '../lib/util.mjs'

const GB = 1024 ** 3
const fsOf = (exists, writable = () => true) => ({ exists, writable })

test('OLLAMA_MODELS on a missing drive names the drive', () => {
  const dir = join(tmpdir(), 'finess-gone', 'Models')
  const root = parse(dir).root
  const f = checkModelsDir({ env: { OLLAMA_MODELS: dir }, fs: fsOf(() => false) })
  assert.equal(f.id, 'models-dir')
  assert.match(f.message, new RegExp(`drive ${root.replaceAll('\\', '\\\\')}`))
  assert.match(f.fix, /plug the drive in/)
})

test('OLLAMA_MODELS: unset, existing, creatable and unwritable cases', () => {
  const dir = join(tmpdir(), 'finess-x', 'models')
  const root = parse(dir).root
  assert.equal(checkModelsDir({ env: {}, fs: fsOf(() => false) }), undefined)
  assert.equal(checkModelsDir({ env: { OLLAMA_MODELS: dir }, fs: fsOf(p => p === dir || p === root) }), undefined)
  // parent exists and is writable: the engine creates the folder
  assert.equal(checkModelsDir({ env: { OLLAMA_MODELS: dir }, fs: fsOf(p => p === root || p === tmpdir()) }), undefined)
  const ro = checkModelsDir({ env: { OLLAMA_MODELS: dir }, fs: fsOf(p => p === root || p === tmpdir(), () => false) })
  assert.match(ro.message, /cannot be created/)
  const ro2 = checkModelsDir({ env: { OLLAMA_MODELS: dir }, fs: fsOf(p => p === dir || p === root, () => false) })
  assert.match(ro2.message, /not writable/)
})

test('OLLAMA_MODELS against a real temp dir', () => {
  const t = mkdtempSync(join(tmpdir(), 'finess-ec-'))
  try {
    const fs = fsOf(existsSync)
    mkdirSync(join(t, 'ok'))
    assert.equal(checkModelsDir({ env: { OLLAMA_MODELS: join(t, 'ok') }, fs }), undefined)
    assert.equal(checkModelsDir({ env: { OLLAMA_MODELS: join(t, 'new', 'deeper') }, fs }), undefined)
  } finally { rmSync(t, { recursive: true, force: true }) }
})

test('OLLAMA_HOST pointing elsewhere than the route', () => {
  const base = 'http://127.0.0.1:11434/v1'
  assert.equal(checkHostEnv({ env: {}, baseURL: base }), undefined)
  assert.equal(checkHostEnv({ env: { OLLAMA_HOST: '127.0.0.1:11434' }, baseURL: base }), undefined)
  assert.equal(checkHostEnv({ env: { OLLAMA_HOST: 'localhost' }, baseURL: base }), undefined)
  assert.equal(checkHostEnv({ env: { OLLAMA_HOST: '0.0.0.0:11434' }, baseURL: base }), undefined)
  const other = checkHostEnv({ env: { OLLAMA_HOST: 'http://10.0.0.5:9999' }, baseURL: base })
  assert.match(other.message, /OLLAMA_HOST=http:\/\/10\.0\.0\.5:9999 differs/)
  assert.match(other.fix, /unset OLLAMA_HOST/)
  assert.deepEqual(parseOllamaHost('box:8080'), { host: 'box', port: 8080 })
})

test('port taken by something that is not the engine', () => {
  assert.equal(checkPort({ port: 11434, portOpen: false, engineAnswering: false }), undefined)
  assert.equal(checkPort({ port: 11434, portOpen: true, engineAnswering: true }), undefined)
  const f = checkPort({ port: 11434, portOpen: true, engineAnswering: false })
  assert.match(f.message, /port 11434 is taken/)
})

test('probePort sees a real listener and a closed port', async () => {
  const srv = createServer().listen(0, '127.0.0.1')
  await new Promise(r => srv.once('listening', r))
  const { port } = srv.address()
  assert.equal(await probePort('127.0.0.1', port), true)
  await new Promise(r => srv.close(r))
  assert.equal(await probePort('127.0.0.1', port), false)
})

test('engine binary missing', () => {
  assert.equal(checkBinary({ binary: '0.5.1' }), undefined)
  assert.match(checkBinary({ binary: undefined }).message, /not on PATH/)
})

test('free disk below the chosen model size', () => {
  assert.ok(estimateModelBytes('llama3.1:8b') > 4 * GB)
  assert.equal(estimateModelBytes('deepseek-chat'), undefined)
  const low = checkDisk({ model: 'llama3.1:8b', modelInstalled: false, freeBytes: 1 * GB, dir: 'D:\\m' })
  assert.match(low.message, /1\.0 GB free .*llama3\.1:8b needs about/)
  assert.equal(checkDisk({ model: 'llama3.1:8b', modelInstalled: false, freeBytes: 50 * GB, dir: 'x' }), undefined)
  assert.equal(checkDisk({ model: 'llama3.1:8b', modelInstalled: true, freeBytes: 1 * GB, dir: 'x' }), undefined)
  assert.equal(checkDisk({ model: 'deepseek-chat', modelInstalled: false, freeBytes: 1, dir: 'x' }), undefined)
})

test('runChecks collects findings in order and is empty when healthy', () => {
  const ok = { env: {}, fs: fsOf(() => true), baseURL: 'http://127.0.0.1:11434/v1', port: 11434, portOpen: false, engineAnswering: false, binary: '1', model: 'qwen3:4b', modelInstalled: false, freeBytes: 99 * GB, dir: 'x' }
  assert.deepEqual(runChecks(ok), [])
  const bad = runChecks({ ...ok, binary: undefined, portOpen: true })
  assert.deepEqual(bad.map(f => f.id), ['binary', 'port'])
})

test('server log: last error line and its fix hint', () => {
  const log = 'time=1 level=INFO msg="starting"\nError: mkdir E:\\Models: The system cannot find the path specified.\n\n'
  const line = lastErrorLine(log)
  assert.match(line, /^Error: mkdir E:/)
  assert.match(hintForLog(line, { OLLAMA_MODELS: 'E:\\Models' }), /OLLAMA_MODELS=E:\\Models is missing or not writable/)
  assert.match(hintForLog('listen tcp 127.0.0.1:11434: bind: Only one usage of each socket address'), /holds the port/)
  assert.match(hintForLog('write: no space left on device'), /disk is full/)
  assert.equal(hintForLog('something odd'), undefined)
  assert.equal(lastErrorLine(''), undefined)
})

test('startBackground can send stderr to a file (command shape and a real child)', async () => {
  assert.match(hiddenStartCommand('ollama.exe', ['serve'], 'C:\\r\\engine.log'), /-WindowStyle Hidden -RedirectStandardError 'C:\\r\\engine\.log' -PassThru/)
  assert.doesNotMatch(hiddenStartCommand('ollama.exe', ['serve']), /Redirect/)
  const t = mkdtempSync(join(tmpdir(), 'finess-ec-'))
  try {
    const errFile = join(t, 'run', 'engine.log')
    const r = startBackground(process.execPath, ['-e', 'console.error("boom: cannot find the path")'], { errFile, cwd: t })
    assert.ok(r.pid > 0, r.error)
    let text = ''
    for (let i = 0; i < 40 && !text.includes('boom'); i++) {
      await new Promise(res => setTimeout(res, 100))
      try { text = readFileSync(errFile, 'utf8') } catch { /* not yet */ }
    }
    assert.match(text, /boom: cannot find the path/)
  } finally { rmSync(t, { recursive: true, force: true }) }
})
