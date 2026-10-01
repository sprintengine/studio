import type { SecretCipher } from '../../src/server/platform/secret-cipher'

// Test-only stand-in for the platform's `SecretCipher` (Electron's
// `safeStorage` in the app), for the stores that take it as an injected option.
//
// The "ciphertext" is a reversible scramble, not the plaintext with a prefix:
// a token that leaks onto disk then shows up as itself in the file, and a test
// asserting the file does not contain it can actually fail. `available` is a
// box so a suite can take encryption away between two launches of a store.

export type SecretCipherStandIn = SecretCipher & {
  /** How many times `seal` ran — each is a keychain round trip in the app. */
  readonly seals: number
}

export function createSecretCipherStandIn(available: { value: boolean } = { value: true }): SecretCipherStandIn {
  const scramble = (bytes: Buffer): Buffer => Buffer.from(bytes.map((byte) => byte ^ 0x5a))
  let seals = 0
  return {
    available: () => available.value,
    seal(plaintext: string): Buffer {
      if (!available.value) throw new Error('Encryption is not available.')
      seals += 1
      return scramble(Buffer.from(plaintext, 'utf8'))
    },
    open(sealed: Buffer): string {
      if (!available.value) throw new Error('Decryption is not available.')
      return scramble(sealed).toString('utf8')
    },
    get seals() {
      return seals
    },
  }
}
