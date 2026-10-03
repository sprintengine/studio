import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

// The exit of a WSL server is read on Windows, whose own signal numbers are
// not Linux's (its SIGABRT is 22): the server ran in Linux, and `wsl.exe`
// passes Linux's number on. Read here with Windows's table in place.
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  const signals = { SIGHUP: 1, SIGINT: 2, SIGILL: 4, SIGABRT: 22, SIGFPE: 8, SIGKILL: 9, SIGSEGV: 11, SIGTERM: 15 }
  const constants = { ...os.constants, signals }
  return { ...os, constants, default: { ...os, constants } }
})

test("a server's exit is read by Linux's signal numbers, on Windows too", async () => {
  const { describeServerExit } = await import('./wsl-server-starter')
  assert.equal(describeServerExit({ code: 6, signal: null, stderrTail: '' }), 'killed by SIGABRT')
  assert.equal(describeServerExit({ code: 134, signal: null, stderrTail: '' }), 'killed by SIGABRT')
  assert.equal(describeServerExit({ code: 22, signal: null, stderrTail: '' }), 'exit code 22')
  assert.equal(describeServerExit({ code: 9, signal: null, stderrTail: '' }), 'killed')
})
