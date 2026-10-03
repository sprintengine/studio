import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { acquireDataDirLock } from '../../server/core/data-dir'
import { createMcpSocketServer } from './mcp-socket-server'

// The gateway's socket path is shared by every Studio process on a data
// directory. A file found there at start is removed only by the run lock's
// holder: anyone else listening there holds the lock, and removing their
// socket would cut off their agents.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'se-stale-socket-'))
  dirs.push(dir)
  return dir
}

const skipOnWindows = test.skipIf(process.platform === 'win32')

skipOnWindows('the run lock holder replaces a stale socket file', async () => {
  const dataDir = scratch()
  const socketPath = join(dataDir, 'automation.sock')
  writeFileSync(socketPath, '')
  const taken = acquireDataDirLock(dataDir, 'server')
  assert.ok(taken.ok)
  const server = createMcpSocketServer({
    socketPath,
    serverName: 'sprintengine-automation',
    serverVersion: '0.0.0-test',
    resolveTools: () => [],
    mayRemoveStaleSocket: () => taken.lock.isHeld(),
  })
  await server.start()
  assert.equal(server.isRunning(), true)
  await server.stop()
  taken.lock.release()
})

skipOnWindows('a process without the run lock leaves the file and does not listen', async () => {
  const dataDir = scratch()
  const socketPath = join(dataDir, 'automation.sock')
  writeFileSync(socketPath, '')
  const taken = acquireDataDirLock(dataDir, 'server')
  assert.ok(taken.ok)
  const logged: string[] = []
  const server = createMcpSocketServer({
    socketPath,
    serverName: 'sprintengine-automation',
    serverVersion: '0.0.0-test',
    resolveTools: () => [],
    // Another process took the lock over: this one no longer holds it.
    mayRemoveStaleSocket: () => false,
    log: (message) => logged.push(message),
  })
  await assert.rejects(server.start())
  assert.equal(server.isRunning(), false)
  assert.equal(existsSync(socketPath), true, 'the file is left for its owner')
  assert.match(logged.join('\n'), /does not hold the run lock/)
  taken.lock.release()
})
