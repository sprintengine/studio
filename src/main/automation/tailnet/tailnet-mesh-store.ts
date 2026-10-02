import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes, randomUUID } from 'crypto'

import { installedStudioPlatform } from '../../../server/platform/platform'
import type { SecretCipher } from '../../../server/platform/secret-cipher'
import { normalizeTailnetScopes, type TailnetScope } from '../../../shared/tailnet'
import type { MeshConnection } from '../../../shared/tailnet-mesh'
import { isRecord } from '../../../shared/records'

// The tokens THIS machine holds for OTHER machines.
//
// The mirror image of `tailnet-devices.ts`, and deliberately not the same file:
// that one stores hashes of credentials other machines present to us, which is
// all a verifier needs. This one stores credentials we present elsewhere, so
// the token itself has to come back — but only in this process, just before it
// is sent. On disk each token is sealed with the platform's secret cipher (the
// OS keychain, through Electron's `safeStorage`, in the desktop), the way the
// provider secrets and the sign-in refresh token are.
// A file that any process running as this user can read would otherwise hand
// that process every machine this one is paired with.
//
// When the OS cannot encrypt, this matches those stores too: the token is kept
// in memory for the session and never written, so a pairing made then does not
// survive a restart. A plaintext token never reaches the disk from here.
//
// The file is still mode 0600 and replaced by a rename, so a reader never sees
// half of it. A person can end the remaining risk from either end: forget the
// connection here, or revoke the device on the machine that issued it.
// Revocation lands on our very next request, so the stored token becomes inert
// without us being told.

export const TAILNET_MESH_FILENAME = 'tailnet-mesh-connections.json'
/**
 * The name the store had before the client side was called the mesh. A profile
 * that still holds it is moved to the current name on first read, so an update
 * keeps every pairing and leaves no second copy of the tokens behind.
 */
export const LEGACY_TAILNET_MESH_FILENAME = 'tailnet-fleet-connections.json'

/** A stored connection, with the credential the public view omits. */
export type StoredMeshConnection = MeshConnection & { deviceToken: string }

/**
 * The file format. 2 seals each token (`sealedToken`, base64 of the
 * cipher's output); 1 held it as plaintext and is rewritten as 2 the
 * first time it is read.
 */
const MESH_FILE_VERSION = 2

/** In memory: the token for use, and its ciphertext so a rewrite need not ask the keychain again. */
type MeshEntry = StoredMeshConnection & { sealedToken: string | null }

export type TailnetMeshStore = {
  /** Public view: no tokens. This is what IPC returns. */
  list(): MeshConnection[]
  /** Internal view, for the client that must actually authenticate. */
  find(connectionId: string): StoredMeshConnection | null
  add(input: {
    machineName: string
    endpoint: string
    deviceId: string
    deviceName: string
    deviceToken: string
    scopes: TailnetScope[]
    pairedVia: MeshConnection['pairedVia']
  }): MeshConnection
  /** Record what the remote says our grants are now; they can narrow without us being told. */
  updateScopes(connectionId: string, scopes: TailnetScope[]): void
  markConnected(connectionId: string): void
  forget(connectionId: string): boolean
}

export function createTailnetMeshStore(options: {
  resolveUserDataDir: () => string
  /** Production reads the installed platform's cipher; tests inject a stand-in. */
  cipher?: SecretCipher | null
  now?: () => Date
  log?: (message: string) => void
}): TailnetMeshStore {
  const now = options.now ?? (() => new Date())
  const cipher = options.cipher === undefined ? platformCipher() : options.cipher
  const loaded = read(options.resolveUserDataDir(), cipher, options.log)
  let connections: MeshEntry[] = loaded.connections
  // Sealed records this session could not open (the keychain said no, or is
  // not there yet). They are written back exactly as read: a launch without
  // the keychain must not delete pairings a later launch can still open.
  const unopened = loaded.unopened

  function encryptionAvailable(): boolean {
    try {
      return cipher?.available() === true
    } catch {
      return false
    }
  }

  function seal(entry: MeshEntry): string | null {
    if (entry.sealedToken) return entry.sealedToken
    if (!cipher || !encryptionAvailable()) return null
    entry.sealedToken = cipher.seal(entry.deviceToken).toString('base64')
    return entry.sealedToken
  }

  function persist(): void {
    const path = join(options.resolveUserDataDir(), TAILNET_MESH_FILENAME)
    // A connection whose token cannot be sealed is left out of the file
    // entirely: session-only, the way the other secret stores fall back.
    const onDisk = connections.flatMap((entry) => {
      const sealedToken = seal(entry)
      return sealedToken ? [{ ...publicConnection(entry), sealedToken }] : []
    })
    const body = `${JSON.stringify({ version: MESH_FILE_VERSION, connections: [...onDisk, ...unopened] }, null, 2)}\n`
    replaceFileAtomically(path, body)
  }

  function safePersist(context: string): void {
    try {
      persist()
    } catch (error) {
      // Diagnostics only. Losing a last-connected timestamp must not fail the
      // browse a person is waiting on.
      options.log?.(`Could not write ${TAILNET_MESH_FILENAME} (${context}): ${message(error)}`)
    }
  }

  if (loaded.plaintextRead) {
    // The first read of a file written before tokens were sealed: rewrite it
    // now rather than at the next change, so the plaintext does not sit there
    // until something happens to be edited.
    try {
      persist()
      if (!encryptionAvailable()) {
        options.log?.(
          `This system cannot encrypt secrets, so the tokens for ${connections.length} paired machine(s) were removed from ${TAILNET_MESH_FILENAME}. They work until the app quits; pair those machines again after that.`,
        )
      }
    } catch (error) {
      options.log?.(`Could not rewrite ${TAILNET_MESH_FILENAME} with sealed tokens: ${message(error)}`)
    }
  }

  return {
    list: () => connections.map(publicConnection),

    find: (connectionId) => {
      const entry = connections.find((candidate) => candidate.id === connectionId)
      return entry ? { ...publicConnection(entry), deviceToken: entry.deviceToken } : null
    },

    add(input): MeshConnection {
      const stored: MeshEntry = {
        id: `tnc_${randomBytes(9).toString('base64url')}`,
        machineName: input.machineName.slice(0, 120),
        endpoint: input.endpoint,
        deviceId: input.deviceId,
        deviceName: input.deviceName.slice(0, 120),
        scopes: normalizeTailnetScopes(input.scopes),
        pairedAt: now().toISOString(),
        lastConnectedAt: null,
        pairedVia: input.pairedVia,
        deviceToken: input.deviceToken,
        sealedToken: null,
      }
      // Pairing twice with the same machine issues a SECOND device over there,
      // so both records are real and both are listed. Silently replacing the
      // first would leave a device paired on the other machine that nothing
      // here could ever name for revocation.
      const previous = connections
      connections = [...connections, stored]
      try {
        // Unlike last-seen, this write is the whole point of pairing: a token we
        // cannot persist is a pairing that will not survive a restart, so the
        // failure must reach the caller.
        persist()
        if (!stored.sealedToken) {
          options.log?.(
            `This system cannot encrypt secrets, so the pairing with ${stored.machineName} lasts until the app quits.`,
          )
        }
      } catch (error) {
        // And it must not leave a connection listed that the next launch will
        // not have — the caller tells the person to revoke and pair again, and a
        // row still sitting in the list would contradict that advice.
        connections = previous
        throw error
      }
      return publicConnection(stored)
    },

    updateScopes(connectionId, scopes): void {
      const entry = connections.find((candidate) => candidate.id === connectionId)
      if (!entry) return
      const next = normalizeTailnetScopes(scopes)
      if (sameScopes(entry.scopes, next)) return
      entry.scopes = next
      safePersist('scopes')
    },

    markConnected(connectionId): void {
      const entry = connections.find((candidate) => candidate.id === connectionId)
      if (!entry) return
      entry.lastConnectedAt = now().toISOString()
      safePersist('last-connected')
    },

    forget(connectionId): boolean {
      const next = connections.filter((entry) => entry.id !== connectionId)
      if (next.length === connections.length) return false
      connections = next
      persist()
      return true
    },
  }
}

function publicConnection(entry: MeshConnection): MeshConnection {
  return {
    id: entry.id,
    machineName: entry.machineName,
    endpoint: entry.endpoint,
    deviceId: entry.deviceId,
    deviceName: entry.deviceName,
    scopes: [...entry.scopes],
    pairedAt: entry.pairedAt,
    lastConnectedAt: entry.lastConnectedAt,
    pairedVia: entry.pairedVia,
  }
}

function sameScopes(left: readonly TailnetScope[], right: readonly TailnetScope[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index])
}

type ReadResult = {
  connections: MeshEntry[]
  unopened: Record<string, unknown>[]
  /** A token was read as plaintext, so the file must be rewritten sealed. */
  plaintextRead: boolean
}

function read(userDataDir: string, cipher: SecretCipher | null, log?: (message: string) => void): ReadResult {
  const empty: ReadResult = { connections: [], unopened: [], plaintextRead: false }
  const path = migrateLegacyFile(userDataDir, log)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') log?.(`Could not read ${TAILNET_MESH_FILENAME}: ${message(error)}`)
    return empty
  }
  let entries: unknown[]
  try {
    const parsed: unknown = JSON.parse(raw)
    entries = isRecord(parsed) && Array.isArray(parsed.connections) ? parsed.connections : []
  } catch (error) {
    log?.(`${TAILNET_MESH_FILENAME} is not valid JSON (${message(error)}); no machine is paired until it is fixed.`)
    return empty
  }
  const result: ReadResult = { connections: [], unopened: [], plaintextRead: false }
  for (const entry of entries) {
    // A half-readable entry is dropped rather than repaired: a connection with a
    // guessed endpoint would send this machine's credential somewhere nobody chose.
    if (!isRecord(entry) || !hasConnectionFields(entry)) continue
    if (typeof entry.sealedToken === 'string' && entry.sealedToken.length > 0) {
      const token = openToken(entry.sealedToken, cipher, log)
      if (token === null) result.unopened.push(entry)
      else result.connections.push(normalize(entry, token, entry.sealedToken))
      continue
    }
    if (typeof entry.deviceToken === 'string' && entry.deviceToken.length > 0) {
      result.plaintextRead = true
      result.connections.push(normalize(entry, entry.deviceToken, null))
    }
  }
  return result
}

/** The token inside a sealed record, or null when this session cannot open it. */
function openToken(sealed: string, cipher: SecretCipher | null, log?: (message: string) => void): string | null {
  try {
    if (!cipher || !cipher.available()) return null
    const token = cipher.open(Buffer.from(sealed, 'base64'))
    return token.length > 0 ? token : null
  } catch (error) {
    log?.(`Could not open a sealed token in ${TAILNET_MESH_FILENAME}; it is kept for a later launch: ${message(error)}`)
    return null
  }
}

/**
 * The file to read: the current one, after moving a legacy-named one into its
 * place. A move that fails reads the legacy file where it is, so the pairings
 * still load; the next write lands under the current name.
 */
function migrateLegacyFile(userDataDir: string, log?: (message: string) => void): string {
  const current = join(userDataDir, TAILNET_MESH_FILENAME)
  const legacy = join(userDataDir, LEGACY_TAILNET_MESH_FILENAME)
  if (existsSync(current) || !existsSync(legacy)) return current
  try {
    renameSync(legacy, current)
    return current
  } catch (error) {
    log?.(`Could not move ${LEGACY_TAILNET_MESH_FILENAME} to ${TAILNET_MESH_FILENAME}: ${message(error)}`)
    return legacy
  }
}

function hasConnectionFields(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.endpoint === 'string' &&
    value.endpoint.length > 0 &&
    typeof value.deviceId === 'string' &&
    typeof value.pairedAt === 'string'
  )
}

function normalize(value: Record<string, unknown>, deviceToken: string, sealedToken: string | null): MeshEntry {
  const endpoint = value.endpoint as string
  return {
    id: value.id as string,
    machineName:
      typeof value.machineName === 'string' && value.machineName ? value.machineName.slice(0, 120) : endpoint,
    endpoint,
    deviceId: value.deviceId as string,
    deviceName: typeof value.deviceName === 'string' ? value.deviceName.slice(0, 120) : '',
    scopes: normalizeTailnetScopes(value.scopes),
    pairedAt: value.pairedAt as string,
    lastConnectedAt: typeof value.lastConnectedAt === 'string' ? value.lastConnectedAt : null,
    // A record from before this was kept says so rather than guessing a path.
    pairedVia: readPairedVia(value.pairedVia),
    deviceToken,
    sealedToken,
  }
}

/**
 * Replace the file through a temporary one and a rename, so a crash mid-write
 * leaves the old file or the new one and never a truncated list of pairings.
 * The temporary is created 0600, so no token is readable for even a moment.
 */
function replaceFileAtomically(path: string, body: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // Nothing was left behind, or nothing more can be done about it.
    }
    throw error
  }
}

/**
 * The installed platform's cipher, or null when no platform is installed (a
 * plain-Node test that injected none). Null reads as "cannot encrypt", which
 * keeps tokens in memory only, as it did outside Electron.
 */
function platformCipher(): SecretCipher | null {
  return installedStudioPlatform()?.secrets ?? null
}

const PAIRED_VIA: ReadonlySet<string> = new Set(['link', 'request', 'reverse', 'unknown'])

function readPairedVia(value: unknown): MeshConnection['pairedVia'] {
  return typeof value === 'string' && PAIRED_VIA.has(value) ? (value as MeshConnection['pairedVia']) : 'unknown'
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
