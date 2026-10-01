import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { createDataKeySecretCipher, createKeyFileSecretCipher, windowsOwnerOnlyAclArgs } from './secret-cipher'

const directories: string[] = []
function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'secret-cipher-'))
  directories.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('a data key seals and opens, and the ciphertext does not carry the plaintext', () => {
  const cipher = createDataKeySecretCipher(Buffer.alloc(32, 7))
  const sealed = cipher.seal('sk-test-value ✓')
  assert.equal(sealed.includes(Buffer.from('sk-test-value')), false)
  assert.equal(cipher.open(sealed), 'sk-test-value ✓')
  // A fresh IV per seal: the same value twice is two different files.
  assert.notDeepEqual(cipher.seal('same'), cipher.seal('same'))
})

test('a value sealed under another key, or some other way, is refused', () => {
  const sealed = createDataKeySecretCipher(Buffer.alloc(32, 1)).seal('value')
  assert.throws(() => createDataKeySecretCipher(Buffer.alloc(32, 2)).open(sealed))
  // What the desktop's keychain cipher writes is not ours to open.
  assert.throws(
    () => createDataKeySecretCipher(Buffer.alloc(32, 1)).open(Buffer.from('v10 keychain bytes')),
    /data key/,
  )
  assert.throws(() => createDataKeySecretCipher(Buffer.alloc(16)), /32 bytes/)
})

test('the key file is created once, owner-only, and reused by the next cipher', () => {
  const keyPath = join(tempDir(), 'run', 'secret-key')
  const first = createKeyFileSecretCipher({ keyPath })
  assert.equal(first.available(), true)
  const sealed = first.seal('token')
  if (process.platform !== 'win32') {
    assert.equal(statSync(keyPath).mode & 0o777, 0o600)
    assert.equal(statSync(join(keyPath, '..')).mode & 0o077, 0)
  }
  const key = readFileSync(keyPath)
  const second = createKeyFileSecretCipher({ keyPath })
  assert.equal(second.open(sealed), 'token')
  assert.deepEqual(readFileSync(keyPath), key)
})

test('a damaged key file makes the cipher unavailable, says how to recover, and is never replaced', () => {
  for (const contents of ['', 'short key']) {
    const keyPath = join(tempDir(), 'secret-key')
    writeFileSync(keyPath, contents)
    const cipher = createKeyFileSecretCipher({ keyPath })
    assert.equal(cipher.available(), false)
    assert.throws(() => cipher.seal('value'), /is damaged .* Move it aside and restart/)
    assert.equal(readFileSync(keyPath, 'utf8'), contents, 'the damaged key is left for the owner to deal with')
  }
})

test('a failed load is remembered for a moment, so asking before every seal does not reread the disk', () => {
  const keyPath = join(tempDir(), 'secret-key')
  writeFileSync(keyPath, 'short key')
  let clock = 0
  const cipher = createKeyFileSecretCipher({ keyPath, now: () => clock })
  assert.equal(cipher.available(), false)
  writeFileSync(keyPath, Buffer.alloc(32, 9))
  clock += 1_000
  assert.equal(cipher.available(), false, 'still within the pause')
  clock += 5_000
  assert.equal(cipher.available(), true, 'the next try after the pause reads the repaired key')
})

test('a key is made whole and owner-only before it is linked into place, and a key that landed first wins', () => {
  const dir = tempDir()
  const keyPath = join(dir, 'run', 'secret-key')
  const restricted: string[] = []
  const winner = Buffer.alloc(32, 3)
  const cipher = createKeyFileSecretCipher({
    keyPath,
    restrict: (path) => {
      restricted.push(path)
      assert.equal(readFileSync(path).length, 32, 'the bytes are all there before anyone can read the key')
      // Another process links its key in while this one is still restricting.
      writeFileSync(keyPath, winner)
    },
  })
  const sealed = cipher.seal('token')
  assert.equal(restricted.length, 1)
  assert.notEqual(restricted[0], keyPath, 'the temporary file is restricted, not the published name')
  assert.deepEqual(readFileSync(keyPath), winner, 'the loser does not overwrite the winner')
  assert.equal(createDataKeySecretCipher(winner).open(sealed), 'token', 'and seals with the winner')
  assert.deepEqual(readdirSync(join(dir, 'run')), ['secret-key'], 'no temporary file is left behind')
})

test('on Windows the key file is left with one full-control entry, the current user', () => {
  assert.deepEqual(
    windowsOwnerOnlyAclArgs('C:\\Users\\dev\\studio\\run\\secret-key', { USERNAME: 'dev', USERDOMAIN: 'BUILD-BOX' }),
    ['C:\\Users\\dev\\studio\\run\\secret-key', '/inheritance:r', '/grant:r', 'BUILD-BOX\\dev:F'],
  )
  assert.deepEqual(windowsOwnerOnlyAclArgs('C:\\key', { USERNAME: 'dev' }).at(-1), 'dev:F')
})
