// Test-only stand-in for Electron's `safeStorage`, for the stores that take it
// as an injected option rather than importing `electron`.
//
// The "ciphertext" is a reversible scramble, not the plaintext with a prefix:
// a token that leaks onto disk then shows up as itself in the file, and a test
// asserting the file does not contain it can actually fail. `available` is a
// box so a suite can take encryption away between two launches of a store.

export type SafeStorageStandIn = {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  /** How many times `encryptString` ran — each is a keychain round trip in the app. */
  readonly encryptions: number
}

export function createSafeStorageStandIn(available: { value: boolean } = { value: true }): SafeStorageStandIn {
  const scramble = (bytes: Buffer): Buffer => Buffer.from(bytes.map((byte) => byte ^ 0x5a))
  let encryptions = 0
  return {
    isEncryptionAvailable: () => available.value,
    encryptString(value: string): Buffer {
      if (!available.value) throw new Error('Encryption is not available.')
      encryptions += 1
      return scramble(Buffer.from(value, 'utf8'))
    },
    decryptString(value: Buffer): string {
      if (!available.value) throw new Error('Decryption is not available.')
      return scramble(value).toString('utf8')
    },
    get encryptions() {
      return encryptions
    },
  }
}
