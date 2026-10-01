import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// What every secret the server keeps at rest is sealed with: provider API keys,
// the GitHub token, module secrets, the tokens this machine holds for its
// tailnet peers.
//
// In the desktop this is Electron's `safeStorage` (the OS keychain on macOS,
// DPAPI on Windows, the secret service on Linux), byte for byte: the Electron
// implementation seals exactly what the stores sealed before, so every file an
// earlier build wrote still opens. A standalone server has no `safeStorage`; it
// seals with a data key instead (`createDataKeySecretCipher`), handed over by the
// desktop that spawned it or kept in an owner-only key file
// (`createKeyFileSecretCipher`). The two ciphertexts are not interchangeable, so
// moving a desktop's sealed files to a standalone server means opening them in
// the desktop and sealing them again, once.
//
// Every store keeps its rule for a cipher that is not available: nothing is
// written, and a secret set then lasts for the session only.

export type SecretCipher = {
  /**
   * Whether `seal` and `open` work right now. Asked on every use rather than
   * once: Electron on Linux answers false until the app is ready.
   */
  available(): boolean
  /** Seal a UTF-8 string. Throws when the cipher is not available. */
  seal(plaintext: string): Buffer
  /** Open what `seal` produced. Throws on another key's ciphertext or a damaged one. */
  open(sealed: Buffer): string
}

const DATA_KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
// Leads every sealed value, so a file sealed some other way (a keychain
// ciphertext copied from the desktop, a truncated write) is refused by name
// rather than decrypted into noise.
const MAGIC = Buffer.from('SESC1', 'ascii')

/** AES-256-GCM under a 32-byte data key. */
export function createDataKeySecretCipher(key: Buffer): SecretCipher {
  if (key.length !== DATA_KEY_BYTES) throw new Error(`A data key is ${DATA_KEY_BYTES} bytes, not ${key.length}.`)
  return {
    available: () => true,
    seal(plaintext) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
    },
    open(sealed) {
      const header = MAGIC.length + IV_BYTES + TAG_BYTES
      if (sealed.length < header || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error('This value was not sealed with a Studio data key.')
      }
      const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_BYTES)
      const tag = sealed.subarray(MAGIC.length + IV_BYTES, header)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(sealed.subarray(header)), decipher.final()]).toString('utf8')
    },
  }
}

/** Whether `sealed` is what a data-key cipher writes (whichever key), rather than another cipher's ciphertext. */
export function isDataKeySealed(sealed: Buffer): boolean {
  return sealed.length >= MAGIC.length && sealed.subarray(0, MAGIC.length).equals(MAGIC)
}

/**
 * A cipher that seals and opens nothing, saying why. For a server whose data
 * directory holds secrets another cipher sealed (the desktop's keychain): every
 * store then treats a secret as session-only, never opens what is on disk and
 * never writes over it with ciphertext the desktop could not open.
 */
export function createUnavailableSecretCipher(reason: string): SecretCipher {
  return {
    available: () => false,
    seal: () => {
      throw new Error(reason)
    },
    open: () => {
      throw new Error(reason)
    },
  }
}

/**
 * A data key kept in `keyPath`, created on first use with mode 0600 in a 0700
 * directory. Secrets sealed with it are protected by the OS user boundary, the
 * protection the agent CLIs' own login files have on the same host.
 *
 * The key is read lazily and synchronously, because sealing is synchronous
 * (as `safeStorage` is); a key file that cannot be read or created makes the
 * cipher unavailable rather than throwing out of a store.
 */
export function createKeyFileSecretCipher(options: { keyPath: string }): SecretCipher {
  let cipher: SecretCipher | null = null
  const load = (): SecretCipher | null => {
    if (cipher) return cipher
    try {
      cipher = createDataKeySecretCipher(readOrCreateKey(options.keyPath))
    } catch {
      cipher = null
    }
    return cipher
  }
  const required = (): SecretCipher => {
    const loaded = load()
    if (!loaded) throw new Error(`The secret key file ${options.keyPath} cannot be read or created.`)
    return loaded
  }
  return {
    available: () => load() !== null,
    seal: (plaintext) => required().seal(plaintext),
    open: (sealed) => required().open(sealed),
  }
}

function readOrCreateKey(keyPath: string): Buffer {
  try {
    return checkedKey(readFileSync(keyPath), keyPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 })
  try {
    // `wx`: two processes creating the key at once must agree on one of them,
    // so the loser reads the winner's key instead of overwriting it.
    writeFileSync(keyPath, randomBytes(DATA_KEY_BYTES), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  // `mode` is filtered through the umask on creation; the key is the owner's only.
  chmodSync(keyPath, 0o600)
  return checkedKey(readFileSync(keyPath), keyPath)
}

function checkedKey(key: Buffer, keyPath: string): Buffer {
  if (key.length !== DATA_KEY_BYTES) throw new Error(`${keyPath} is not a Studio data key.`)
  return key
}
