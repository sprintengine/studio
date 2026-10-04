import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'vitest'

import type { HelperProcess } from '../../main/hosts/wsl-helper-client'
import { WslSetupError } from '../../main/hosts/wsl-setup-error'
import { describeServerExit, lastErrorLine, startWslServer } from './wsl-server-starter'

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
    once: (event: string, listener: (...args: never[]) => void) =>
      events.once(event, listener as (...args: unknown[]) => void),
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

// What a library warns about while a chat works, as the server's stderr had
// it on a PC when the server was killed: none of it is why the server stopped.
const SDK_WARNINGS = [
  "(node:6993) [SDK_TOOL_HOOK_SHADOWED] Warning: the tool hook will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call",
  '(Use `node --trace-warnings ...` to show where the warning was created)',
  "(node:6993) [SDK_TOOL_HOOK_SHADOWED] Warning: the tool hook will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call",
  '[studio-server] ready in 812 ms: gateway /home/dev/.local/share/sprintengine-studio/data/run/gateway.sock',
].join('\n')

test('a killed server is said to be killed, whichever way the kill arrives, and never by its warnings', () => {
  // `wsl.exe` passes the signal's number on as its exit code.
  assert.equal(describeServerExit({ code: 9, signal: null, stderrTail: SDK_WARNINGS }), 'killed')
  // A shell says 128 + n; Node itself names the signal.
  assert.equal(describeServerExit({ code: 137, signal: null, stderrTail: '' }), 'killed')
  assert.equal(describeServerExit({ code: null, signal: 'SIGKILL', stderrTail: SDK_WARNINGS }), 'killed')
  assert.equal(describeServerExit({ code: 15, signal: null, stderrTail: '' }), 'killed by SIGTERM')
  assert.equal(describeServerExit({ code: null, signal: 'SIGSEGV', stderrTail: '' }), 'killed by SIGSEGV')
})

test('an exit code is said with the last line that says what went wrong, or alone', () => {
  assert.equal(describeServerExit({ code: 1, signal: null, stderrTail: SDK_WARNINGS }), 'exit code 1')
  const crashed = `${SDK_WARNINGS}\nTypeError: Cannot read properties of undefined (reading 'id')\n    at Object.<anonymous> (/home/dev/server.cjs:1:2)\n${SDK_WARNINGS}`
  assert.equal(
    describeServerExit({ code: 70, signal: null, stderrTail: crashed }),
    "exit code 70: TypeError: Cannot read properties of undefined (reading 'id')",
  )
  assert.equal(lastErrorLine(SDK_WARNINGS), null)
  assert.equal(
    lastErrorLine('RangeError: Maximum call stack size exceeded'),
    'RangeError: Maximum call stack size exceeded',
  )
  assert.equal(describeServerExit({ code: null, signal: null, stderrTail: '' }), 'no exit code')
})
