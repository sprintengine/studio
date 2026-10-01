import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
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

/** How long a key file that could not be loaded is left alone before the next try. */
const FAILED_LOAD_RETRY_MS = 5_000

export type KeyFileSecretCipherOptions = {
  keyPath: string
  /** Makes a new key file the current user's only; defaults to `restrictToOwner`. */
  restrict?: (path: string) => void
  now?: () => number
}

/**
 * A data key kept in `keyPath`, created on first use and readable by the
 * current user only (mode 0600 in a 0700 directory; an owner-only ACL on
 * Windows). Secrets sealed with it are protected by the OS user boundary, the
 * protection the agent CLIs' own login files have on the same host.
 *
 * The key is read lazily and synchronously, because sealing is synchronous
 * (as `safeStorage` is). A key file that cannot be read or created makes the
 * cipher unavailable rather than throwing out of a store, and the failure is
 * remembered for a few seconds, so a store asking `available()` before every
 * seal does not read the disk each time.
 */
export function createKeyFileSecretCipher(options: KeyFileSecretCipherOptions): SecretCipher {
  const now = options.now ?? Date.now
  const restrict = options.restrict ?? restrictToOwner
  let cipher: SecretCipher | null = null
  let failure: { at: number; message: string } | null = null
  const load = (): SecretCipher | null => {
    if (cipher) return cipher
    if (failure && now() - failure.at < FAILED_LOAD_RETRY_MS) return null
    try {
      cipher = createDataKeySecretCipher(readOrCreateKey(options.keyPath, restrict))
      failure = null
    } catch (error) {
      failure = { at: now(), message: error instanceof Error ? error.message : String(error) }
    }
    return cipher
  }
  const required = (): SecretCipher => {
    const loaded = load()
    if (!loaded)
      throw new Error(failure?.message ?? `The secret key file ${options.keyPath} cannot be read or created.`)
    return loaded
  }
  return {
    available: () => load() !== null,
    seal: (plaintext) => required().seal(plaintext),
    open: (sealed) => required().open(sealed),
  }
}

function readOrCreateKey(keyPath: string, restrict: (path: string) => void): Buffer {
  const existing = readExistingKey(keyPath)
  if (existing) return existing
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 })
  // The key is written whole under a name nobody else reads, made the owner's,
  // and only then linked into place. A link fails if the name exists, so two
  // processes creating a key at once agree on the one that landed first, and
  // a crash part-way never leaves a short key where a reader would find it.
  const temporary = `${keyPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, randomBytes(DATA_KEY_BYTES), { mode: 0o600, flag: 'wx' })
    restrict(temporary)
    try {
      linkSync(temporary, keyPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally {
    rmSync(temporary, { force: true })
  }
  const created = readExistingKey(keyPath)
  if (!created) throw new Error(`The secret key file ${keyPath} vanished as it was created.`)
  return created
}

/** The key at `keyPath`, null when there is none, and an error that says how to recover when it is damaged. */
function readExistingKey(keyPath: string): Buffer | null {
  let key: Buffer
  try {
    key = readFileSync(keyPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (key.length !== DATA_KEY_BYTES) {
    // Never replaced here: a key is the only way to open what was sealed with
    // it, and deciding that those secrets are lost is the owner's call.
    throw new Error(
      `The secret key file ${keyPath} is damaged (${key.length} bytes, not ${DATA_KEY_BYTES}), so no secret can ` +
        `be stored or read. Move it aside and restart: a new key is made, and the API keys and tokens stored ` +
        `before have to be entered again.`,
    )
  }
  return key
}

/**
 * Make `path` readable and writable by the current user only. On POSIX the
 * file was created 0600, which the umask can only narrow. On Windows the mode
 * means nothing, so inheritance is cut and the only entry left is the current
 * user's.
 */
export function restrictToOwner(path: string): void {
  if (process.platform !== 'win32') return
  execFileSync('icacls', windowsOwnerOnlyAclArgs(path), { stdio: 'ignore', windowsHide: true })
}

/** The `icacls` arguments that leave `path` with one full-control entry, the current user's. */
export function windowsOwnerOnlyAclArgs(path: string, env: Record<string, string | undefined> = process.env): string[] {
  const user = env.USERNAME?.trim() || userInfo().username
  const domain = env.USERDOMAIN?.trim()
  return [path, '/inheritance:r', '/grant:r', `${domain ? `${domain}\\${user}` : user}:F`]
}
