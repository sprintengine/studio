import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { createDataKeySecretCipher } from '../platform/secret-cipher'
import {
  acquireDataDirLock,
  DATA_DIR_LOCK_FILE,
  DATA_DIR_RECORD_FILE,
  readDataDirSecrets,
  recordDataDirSecrets,
} from './data-dir'

const directories: string[] = []
function dataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'studio-data-dir-'))
  directories.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const host = 'build-box'
const running =
  (...pids: number[]) =>
  (pid: number) =>
    pids.includes(pid)

test('one core holds the lock; a second is refused by name until the first releases it', () => {
  const dir = dataDir()
  const first = acquireDataDirLock(dir, 'desktop', { pid: 100, hostname: host, isRunning: running(100, 200) })
  assert.ok(first.ok)
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(dir, 'run')).mode & 0o077, 0)
    assert.equal(statSync(first.lock.path).mode & 0o777, 0o600)
  }

  const second = acquireDataDirLock(dir, 'server', { pid: 200, hostname: host, isRunning: running(100, 200) })
  assert.equal(second.ok, false)
  assert.ok(!second.ok)
  assert.deepEqual({ role: second.holder.role, pid: second.holder.pid }, { role: 'desktop', pid: 100 })
  assert.match(second.message, /SprintEngine Studio \(pid 100 on build-box\) has this data directory open/)

  first.lock.release()
  first.lock.release()
  const third = acquireDataDirLock(dir, 'server', { pid: 200, hostname: host, isRunning: running(200) })
  assert.ok(third.ok)
  third.lock.release()
})

test('a lock whose process is gone, or that names this very process, is taken over', () => {
  const dir = dataDir()
  assert.ok(acquireDataDirLock(dir, 'server', { pid: 100, hostname: host, isRunning: running(100) }).ok)
  // 100 crashed without releasing.
  const next = acquireDataDirLock(dir, 'server', { pid: 300, hostname: host, isRunning: running(300) })
  assert.ok(next.ok)
  // A container restarts its only process with the same id.
  const again = acquireDataDirLock(dir, 'server', { pid: 300, hostname: host, isRunning: running(300) })
  assert.ok(again.ok)
  // The first lock object no longer owns the file, and must not remove it.
  next.lock.release()
  assert.equal(JSON.parse(readFileSync(join(dir, DATA_DIR_LOCK_FILE), 'utf8')).pid, 300)
  again.lock.release()
})

test('a lock from another machine is never presumed abandoned', () => {
  const dir = dataDir()
  assert.ok(acquireDataDirLock(dir, 'server', { pid: 100, hostname: 'mac-mini', isRunning: running() }).ok)
  const here = acquireDataDirLock(dir, 'server', { pid: 200, hostname: host, isRunning: running(200) })
  assert.equal(here.ok, false)
})

test('an unreadable lock is someone mid-write until it has stayed unreadable a while', () => {
  const dir = dataDir()
  mkdirSync(join(dir, 'run'))
  writeFileSync(join(dir, DATA_DIR_LOCK_FILE), '{"role":')
  assert.equal(acquireDataDirLock(dir, 'server', { pid: 1, hostname: host, isRunning: running(1) }).ok, false)
  const old = new Date(Date.now() - 60_000)
  utimesSync(join(dir, DATA_DIR_LOCK_FILE), old, old)
  assert.ok(acquireDataDirLock(dir, 'server', { pid: 1, hostname: host, isRunning: running(1) }).ok)
})

test.skipIf(process.platform === 'win32')("a server refuses a directory a running app's profile lock names", () => {
  const dir = dataDir()
  symlinkSync(`${host}-4242`, join(dir, 'SingletonLock'))
  const refused = acquireDataDirLock(dir, 'server', { pid: 1, hostname: host, isRunning: running(1, 4242) })
  assert.equal(refused.ok, false)
  assert.ok(!refused.ok && refused.holder.role === 'desktop' && refused.holder.pid === 4242)
  // The app itself holds that lock, and a stale one says nothing.
  assert.ok(acquireDataDirLock(dir, 'desktop', { pid: 4242, hostname: host, isRunning: running(4242) }).ok)
  const stale = dataDir()
  symlinkSync(`${host}-4242`, join(stale, 'SingletonLock'))
  assert.ok(acquireDataDirLock(stale, 'server', { pid: 1, hostname: host, isRunning: running(1) }).ok)
})

test('a directory says whose cipher seals it: its record, else what it holds', () => {
  const fresh = dataDir()
  assert.equal(readDataDirSecrets(fresh), null)
  recordDataDirSecrets(fresh, 'server-key')
  // The first record stands.
  recordDataDirSecrets(fresh, 'desktop-keychain')
  assert.equal(readDataDirSecrets(fresh), 'server-key')
  assert.equal(JSON.parse(readFileSync(join(fresh, DATA_DIR_RECORD_FILE), 'utf8')).secrets, 'server-key')

  // A desktop profile from before the record existed: Chromium's own files.
  const profile = dataDir()
  writeFileSync(join(profile, 'Local State'), '{}')
  assert.equal(readDataDirSecrets(profile), 'desktop-keychain')

  // Or a secret sealed by something other than a data key.
  const sealed = dataDir()
  mkdirSync(join(sealed, 'provider-secrets'))
  writeFileSync(
    join(sealed, 'provider-secrets', 'openai.bin'),
    createDataKeySecretCipher(Buffer.alloc(32, 3)).seal('k'),
  )
  assert.equal(readDataDirSecrets(sealed), null)
  writeFileSync(join(sealed, 'github-token.bin'), Buffer.from('v10 keychain bytes'))
  assert.equal(readDataDirSecrets(sealed), 'desktop-keychain')
})
