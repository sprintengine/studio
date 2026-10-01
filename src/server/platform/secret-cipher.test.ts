import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import {
  createDataKeySecretCipher,
  createKeyFileSecretCipher,
  createUnavailableSecretCipher,
  isDataKeySealed,
} from './secret-cipher'

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

test('an unreadable key file makes the cipher unavailable instead of throwing out of a store', () => {
  const keyPath = join(tempDir(), 'secret-key')
  writeFileSync(keyPath, 'not a key')
  const cipher = createKeyFileSecretCipher({ keyPath })
  assert.equal(cipher.available(), false)
  assert.throws(() => cipher.seal('value'), /cannot be read or created/)
})

test("a data key's ciphertext is recognised as such, and an unavailable cipher says why it is", () => {
  assert.equal(isDataKeySealed(createDataKeySecretCipher(Buffer.alloc(32, 9)).seal('value')), true)
  assert.equal(isDataKeySealed(Buffer.from('v10 keychain bytes')), false)
  const cipher = createUnavailableSecretCipher('Sealed by the desktop.')
  assert.equal(cipher.available(), false)
  assert.throws(() => cipher.seal('value'), /Sealed by the desktop/)
  assert.throws(() => cipher.open(Buffer.from('x')), /Sealed by the desktop/)
})
