import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import type { DiagnosticLogInput } from '../../shared/ipc/diagnostics'
import { createNodeStudioPlatform } from '../platform/platform'
import { createUnavailableSecretCipher } from '../platform/secret-cipher'
import { acquireDataDirLock, DATA_DIR_RECORD_FILE } from './data-dir'
import { StudioDataDirBusyError, StudioDataDirUnusableError, takeDataDir } from './take-data-dir'

const directories: string[] = []
function dataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'studio-take-data-dir-'))
  directories.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    chmodSync(directory, 0o700)
    rmSync(directory, { recursive: true, force: true })
  }
})

function platformAt(dir: string, secrets = true) {
  return createNodeStudioPlatform({
    dataDir: dir,
    packaged: false,
    version: '1.0.0',
    ...(secrets ? {} : { secrets: createUnavailableSecretCipher('off') }),
  })
}

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code })
}

test('the desktop starts whatever the lock or the record throws: no permission, a full disk, a busy file', () => {
  for (const code of ['EACCES', 'ENOSPC', 'EBUSY', 'EPERM']) {
    const dir = dataDir()
    const logged: DiagnosticLogInput[] = []
    const taken = takeDataDir(platformAt(dir), 'desktop', {
      acquire: () => {
        throw fsError(code)
      },
      record: () => {
        throw fsError(code)
      },
      log: (diagnostic) => logged.push(diagnostic),
    })
    assert.equal(taken.lock, null, code)
    assert.deepEqual(
      logged.map((entry) => entry.title),
      ['Data directory lock not taken', 'Data directory record not written'],
      code,
    )
    assert.match(logged[0]!.details ?? '', new RegExp(code))
  }
})

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'the desktop starts in a data directory it cannot write, and a server is refused it',
  () => {
    const dir = dataDir()
    chmodSync(dir, 0o500)
    const logged: DiagnosticLogInput[] = []
    const taken = takeDataDir(platformAt(dir), 'desktop', { log: (diagnostic) => logged.push(diagnostic) })
    assert.equal(taken.lock, null)
    assert.ok(logged.some((entry) => /EACCES/.test(entry.details ?? '')))
    assert.throws(() => takeDataDir(platformAt(dir), 'server'), StudioDataDirUnusableError)
  },
)

test('the desktop takes over a lock a previous desktop run left, whatever its host or process says', () => {
  const dir = dataDir()
  // A Mac's host name changes with the network; the old run's process id may be anyone's now.
  assert.ok(acquireDataDirLock(dir, 'desktop', { pid: 1, hostname: 'dev-macbook-air.local', isRunning: () => true }).ok)
  const logged: DiagnosticLogInput[] = []
  const taken = takeDataDir(platformAt(dir), 'desktop', { log: (diagnostic) => logged.push(diagnostic) })
  assert.ok(taken.lock?.isHeld())
  assert.deepEqual(logged, [])
})

test('the desktop displaces a running server and waits for it to exit before opening its sockets', async () => {
  const dir = dataDir()
  assert.ok(acquireDataDirLock(dir, 'server', { pid: 4242 }).ok)
  let running = true
  const logged: DiagnosticLogInput[] = []
  const taken = takeDataDir(platformAt(dir), 'desktop', {
    acquire: (directory, role, deps) =>
      acquireDataDirLock(directory, role, { ...deps, isRunning: (pid) => pid === 4242 && running }),
    isRunning: (pid) => pid === 4242 && running,
    pollMs: 5,
    log: (diagnostic) => logged.push(diagnostic),
  })
  assert.ok(taken.lock?.isHeld())
  assert.match(logged[0]!.message, /pid 4242/)
  let free = false
  void taken.whenFree.then(() => (free = true))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(free, false, 'still waiting while the server runs')
  running = false
  await taken.whenFree
})

test('a server refuses a held directory, an unusable one, and sealing into a desktop one', () => {
  const held = dataDir()
  assert.ok(acquireDataDirLock(held, 'server', { pid: 4242, isRunning: () => true }).ok)
  assert.throws(
    () =>
      takeDataDir(platformAt(held), 'server', {
        acquire: (directory, role) => acquireDataDirLock(directory, role, { isRunning: () => true }),
      }),
    StudioDataDirBusyError,
  )

  const full = dataDir()
  assert.throws(
    () =>
      takeDataDir(platformAt(full), 'server', {
        acquire: () => {
          throw fsError('ENOSPC')
        },
      }),
    (error: unknown) => error instanceof StudioDataDirUnusableError && /ENOSPC/.test(error.message),
  )

  const desktop = dataDir()
  writeFileSync(join(desktop, 'Local State'), '{}')
  assert.throws(() => takeDataDir(platformAt(desktop), 'server'), /keychain sealed/)
  assert.equal(existsSync(join(desktop, 'run', 'studio.lock')), false, 'the lock is let go on refusal')
  // With its secrets off, it may share the directory, and records nothing.
  const shared = takeDataDir(platformAt(desktop, false), 'server')
  assert.ok(shared.lock?.isHeld())
  assert.equal(existsSync(join(desktop, DATA_DIR_RECORD_FILE)), false)
})
