import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'vitest'

import type { HelperProcess } from '../../main/hosts/wsl-helper-client'
import { WslSetupError } from '../../main/hosts/wsl-setup-error'
import { startWslServer } from './wsl-server-starter'

// What `wsl.exe` says about itself is UTF-16LE with CRLF line ends, unlike
// anything the server prints: the starter reads it as text before it
// classifies it or shows it to the person.

function failingWslExe(stderr: Buffer, code: number): HelperProcess {
  const events = new EventEmitter()
  const stdout = new PassThrough()
  const err = new PassThrough()
  const stdin = new PassThrough()
  stdin.resume()
  setImmediate(() => {
    err.end(stderr)
    stdout.end()
    err.once('end', () => setImmediate(() => events.emit('close', code, null)))
    err.resume()
  })
  return {
    stdin,
    stdout,
    stderr: err,
    kill: () => undefined,
    once: (event: string, listener: (...args: never[]) => void) => events.once(event, listener),
  } as HelperProcess
}

test("wsl.exe's own UTF-16 message is read as words, and a missing distribution is said so", async () => {
  const message =
    'There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n'
  const error = await startWslServer({
    distro: 'Ubuntu',
    spawnShell: () => failingWslExe(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(message, 'utf16le')]), 1),
    launchScript: async () => 'true',
    install: async () => assert.fail('nothing to install'),
    prewarm: async () => undefined,
    envelopeFor: () => assert.fail('it never booted'),
    maxAttempts: 1,
  }).catch((caught: unknown) => caught)
  assert.ok(error instanceof WslSetupError)
  assert.equal(error.code, 'distro-missing')
  assert.match(error.message, /no distribution with the supplied name/u)
  assert.doesNotMatch(error.message, /[\0\r]/u)
})

test('a start that fails in words other than the classified ones shows them without NULs', async () => {
  const error = await startWslServer({
    distro: 'Ubuntu',
    spawnShell: () => failingWslExe(Buffer.from('The virtual machine could not be started.\r\n', 'utf16le'), 1),
    launchScript: async () => 'true',
    install: async () => assert.fail('nothing to install'),
    prewarm: async () => undefined,
    envelopeFor: () => assert.fail('it never booted'),
    maxAttempts: 1,
  }).catch((caught: unknown) => caught)
  assert.ok(error instanceof WslSetupError)
  assert.match(error.message, /The virtual machine could not be started\./u)
  assert.doesNotMatch(error.message, /[\0\r]/u)
})
