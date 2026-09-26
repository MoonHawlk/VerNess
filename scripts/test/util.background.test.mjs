/**
 * `hiddenStartCommand` builds the PowerShell line that starts a server in a hidden console on
 * Windows (so its helpers never flash terminal windows). Quoting must survive both the Windows
 * command line and PowerShell.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { hiddenStartCommand } from '../lib/util.mjs'

test('plain executable and argument', () => {
  assert.equal(hiddenStartCommand('ollama.exe', ['serve']), "(Start-Process -FilePath 'ollama.exe' -ArgumentList 'serve' -WindowStyle Hidden -PassThru).Id")
})

test('no arguments omits -ArgumentList (an empty list is an error)', () => {
  assert.equal(hiddenStartCommand('C:\\x\\laya-serve.exe', []), "(Start-Process -FilePath 'C:\\x\\laya-serve.exe' -WindowStyle Hidden -PassThru).Id")
})

test('spaces, quotes and apostrophes are quoted for both layers', () => {
  const cmd = hiddenStartCommand("C:\\Program Files\\it's\\a.exe", ['a b', 'say "hi"', ''])
  assert.equal(cmd, `(Start-Process -FilePath 'C:\\Program Files\\it''s\\a.exe' -ArgumentList '"a b" "say \\"hi\\"" ""' -WindowStyle Hidden -PassThru).Id`)
})
