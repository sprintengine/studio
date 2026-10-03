import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { SecretCipher } from '../platform/secret-cipher'
import { utf8Bytes, utf8Text, type ShellBridge } from './shell-bridge'

// The Studio server's secret cipher on the desktop (phase 6 spec, section 9.1):
// the shell's keychain behind the control channel, so every sealed file stays
// byte-identical to what an in-process build writes and rollback is a flag
// flip with no migration either way.
//
// The real forms are asynchronous (`sealAsync`, `openAsync`), and every store
// that reads or writes a secret in an async path uses them. The one store that
// opens synchronously, the mesh's paired-machine tokens read as it is built,
// is served from what `prime` opened before the server composed its stores; a
// ciphertext nobody primed fails to open there, which that store already
// treats as "keep it for a later launch", never as "overwrite it".
//
// Opened values stay in memory for the server's life, the way the provider
// secret store keeps them, so a secret crosses the channel once.

export type ShellSecretCipher = SecretCipher & {
  sealAsync(plaintext: string): Promise<Buffer>
  openAsync(sealed: Buffer): Promise<string>
  /** Open these ahead of time, so a synchronous `open` of them answers. Failures are skipped. */
  prime(sealed: readonly Buffer[]): Promise<void>
}

export function createShellSecretCipher(bridge: ShellBridge, options: { available: boolean }): ShellSecretCipher {
  let available = options.available
  const opened = new Map<string, string>()
  const remember = (sealed: Buffer, plaintext: string) => opened.set(sealed.toString('base64'), plaintext)

  async function openAsync(sealed: Buffer): Promise<string> {
    const known = opened.get(sealed.toString('base64'))
    if (known !== undefined) return known
    const plaintext = utf8Text(await bridge.cipher.open(new Uint8Array(sealed)))
    remember(sealed, plaintext)
    return plaintext
  }

  return {
    available: () => available,
    seal() {
      throw new Error('The desktop keychain seals asynchronously; use sealSecret.')
    },
    open(sealed) {
      const known = opened.get(sealed.toString('base64'))
      if (known === undefined) throw new Error('This secret was not opened ahead of time; use openSecret.')
      return known
    },
    async sealAsync(plaintext) {
      const sealed = Buffer.from(await bridge.cipher.seal(utf8Bytes(plaintext)))
      remember(sealed, plaintext)
      return sealed
    },
    openAsync,
    async prime(sealed) {
      // The keychain's answer is asked again here: on Linux it can change once
      // the session's keyring unlocks.
      available = await bridge.cipher.available().catch(() => available)
      if (!available) return
      for (const each of sealed) await openAsync(each).catch(() => undefined)
    },
  }
}

/** The sealed tokens the mesh store opens synchronously when it is built: the ones to prime. */
export function meshSealedTokens(dataDir: string): Buffer[] {
  for (const name of ['tailnet-mesh-connections.json', 'tailnet-fleet-connections.json']) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(dataDir, name), 'utf8'))
    } catch {
      continue
    }
    const connections = (parsed as { connections?: unknown }).connections
    if (!Array.isArray(connections)) return []
    return connections.flatMap((entry) => {
      const sealed = (entry as { sealedToken?: unknown } | null)?.sealedToken
      return typeof sealed === 'string' && sealed.length > 0 ? [Buffer.from(sealed, 'base64')] : []
    })
  }
  return []
}
