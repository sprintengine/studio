import { randomBytes, timingSafeEqual } from 'crypto'
import { chmodSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import { hashSecret } from '../../mobile/bridge/crypto'
import {
  normalizeTailnetScopes,
  type TailnetDevice,
  type TailnetPairingState,
  type TailnetScope,
} from '../../../shared/tailnet'

// Possession-based device pairing for the tailnet listener (epic Decision 3).
//
// A one-time pairing token is minted by the desktop and exchanged, exactly
// once, for a long-lived scoped device token. Only the SHA-256 of the device
// token is persisted: the plaintext exists in this process for the length of
// the pairing response and never again, so a stolen store file cannot be
// replayed against the listener.
//
// The outstanding pairing OFFER, by contrast, never reaches disk at all: it is
// in-memory state on this store, so an app restart invalidates an unredeemed
// pairing rather than leaving one live across a reboot nobody connected it to.
//
// That cost is real now that codes run to 30 days rather than 10 minutes: the
// restart sweep discards live codes far more often than stale ones, and the
// stated 30-day window is only ever as long as this process runs. Persisting the
// offer's hash the way the device tokens are persisted would fix it and would
// leak no credential — a hash cannot be presented to `redeemPairing`, which
// hashes what it is given and compares. It is deliberately not done yet; the
// window it would widen is how long a forgotten offer stays redeemable, which is
// a decision about the product and not about this file.

export const TAILNET_DEVICES_FILENAME = 'tailnet-remote-devices.json'

/**
 * Long enough that a code minted once stays usable across a working month, so
 * pairing a new machine is never a race against a countdown.
 *
 * The ceiling is not really this number: the offer is in-memory only (see the
 * note above), so an app restart invalidates it well before 30 days on any
 * machine that is not left running. What the long TTL buys is that the code
 * lives as long as the app does, rather than lapsing under a still-open window.
 * Anything minting a code — Settings, or `tailnet.offer_pairing` on the gateway
 * — says so, because "30 days" and "until this app restarts" are not the same
 * promise and only one of them is kept.
 *
 * A longer window is not a longer guessing window: the token is 24 random bytes
 * (192 bits), so it is unguessable at any TTL. What it does widen is how long an
 * unredeemed offer lingers — hence "works once", the Settings cancel action, and
 * the fact that a wrong guess never burns the outstanding offer.
 */
export const DEFAULT_PAIRING_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** How often a device's last-seen reaches disk. In memory it is always current. */
const LAST_SEEN_PERSIST_INTERVAL_MS = 60 * 1000

export type { TailnetDevice, TailnetPairingState }

export type TailnetPairingOffer = {
  /** The one-time token. Returned once at mint; never stored, never re-readable. */
  token: string
  scopes: TailnetScope[]
  expiresAt: string
}

export type TailnetPairingResult =
  | { ok: true; device: TailnetDevice; deviceToken: string }
  | { ok: false; code: 'pairing_not_offered' | 'pairing_expired' | 'pairing_invalid' | 'invalid_device_name'; message: string }

export type TailnetDeviceStore = {
  listDevices(): TailnetDevice[]
  /** Replace any outstanding pairing with a fresh one (the Settings "regenerate" action). */
  offerPairing(input: { scopes: TailnetScope[]; ttlMs?: number }): TailnetPairingOffer
  getPairingState(): TailnetPairingState | null
  cancelPairing(): void
  redeemPairing(input: { token: unknown; deviceName: unknown }): TailnetPairingResult
  /** The device this bearer token belongs to, or null. Reads live state, so a revoke lands on the next call. */
  authenticate(bearerToken: string | null | undefined): TailnetDevice | null
  revokeDevice(deviceId: string): boolean
  /** Fires with the revoked device id so live streams for it can be closed. */
  onDeviceRevoked(listener: (deviceId: string) => void): () => void
  recordSeen(deviceId: string, peerNode: string | null): void
}

type StoredDevice = TailnetDevice & { tokenHash: string }

export function createTailnetDeviceStore(options: {
  resolveUserDataDir: () => string
  now?: () => Date
  log?: (message: string) => void
}): TailnetDeviceStore {
  const now = options.now ?? (() => new Date())
  const revokeListeners = new Set<(deviceId: string) => void>()
  let devices: StoredDevice[] = readDevices(options.resolveUserDataDir(), options.log)
  let pairing: { tokenHash: string; scopes: TailnetScope[]; expiresAtMs: number } | null = null

  function persist(): void {
    const path = join(options.resolveUserDataDir(), TAILNET_DEVICES_FILENAME)
    const body = `${JSON.stringify({ version: 1, devices }, null, 2)}\n`
    writeFileSync(path, body, { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(path, 0o600)
  }

  return {
    listDevices: () => devices.map(publicDevice),

    offerPairing(input): TailnetPairingOffer {
      const token = `mcpair_${randomBytes(24).toString('base64url')}`
      const scopes = normalizeTailnetScopes(input.scopes)
      const expiresAtMs = now().getTime() + Math.max(1000, input.ttlMs ?? DEFAULT_PAIRING_TTL_MS)
      pairing = { tokenHash: hashSecret(token), scopes, expiresAtMs }
      return { token, scopes, expiresAt: new Date(expiresAtMs).toISOString() }
    },

    getPairingState: () =>
      pairing && pairing.expiresAtMs > now().getTime()
        ? { scopes: pairing.scopes, expiresAt: new Date(pairing.expiresAtMs).toISOString() }
        : null,

    cancelPairing(): void {
      pairing = null
    },

    redeemPairing(input): TailnetPairingResult {
      if (!pairing) {
        return { ok: false, code: 'pairing_not_offered', message: 'No pairing is being offered. Generate a pairing code in Settings first.' }
      }
      if (pairing.expiresAtMs <= now().getTime()) {
        pairing = null
        return { ok: false, code: 'pairing_expired', message: 'That pairing code has expired. Generate a new one in Settings.' }
      }
      const presented = typeof input.token === 'string' ? input.token : ''
      if (!secretsMatch(hashSecret(presented), pairing.tokenHash)) {
        // A wrong code does not burn the outstanding pairing: that would let any
        // unauthenticated caller on the tailnet cancel a pairing the user is
        // mid-way through by guessing once.
        return { ok: false, code: 'pairing_invalid', message: 'That pairing code is not valid.' }
      }
      const name = typeof input.deviceName === 'string' ? input.deviceName.trim().slice(0, 120) : ''
      if (!name) {
        return { ok: false, code: 'invalid_device_name', message: 'A device name is required so the pairing is identifiable in Settings.' }
      }
      const deviceToken = `mctn_${randomBytes(32).toString('base64url')}`
      const stored: StoredDevice = {
        id: `tnd_${randomBytes(9).toString('base64url')}`,
        name,
        scopes: pairing.scopes,
        createdAt: now().toISOString(),
        lastSeenAt: null,
        lastPeerNode: null,
        tokenHash: hashSecret(deviceToken),
      }
      // One-time by construction: the offer is consumed whether or not the
      // persist below succeeds, so a failed write cannot leave a live code.
      pairing = null
      devices = [...devices, stored]
      persist()
      return { ok: true, device: publicDevice(stored), deviceToken }
    },

    authenticate(bearerToken): TailnetDevice | null {
      if (typeof bearerToken !== 'string' || !bearerToken) return null
      const presented = hashSecret(bearerToken)
      for (const device of devices) {
        if (secretsMatch(presented, device.tokenHash)) return publicDevice(device)
      }
      return null
    },

    revokeDevice(deviceId): boolean {
      const next = devices.filter((device) => device.id !== deviceId)
      if (next.length === devices.length) return false
      devices = next
      persist()
      for (const listener of revokeListeners) {
        try {
          listener(deviceId)
        } catch (error) {
          options.log?.(`Tailnet revoke listener threw: ${message(error)}`)
        }
      }
      return true
    },

    onDeviceRevoked(listener): () => void {
      revokeListeners.add(listener)
      return () => revokeListeners.delete(listener)
    },

    recordSeen(deviceId, peerNode): void {
      const device = devices.find((candidate) => candidate.id === deviceId)
      if (!device) return
      const seenAtMs = now().getTime()
      const previousMs = device.lastSeenAt ? Date.parse(device.lastSeenAt) : Number.NaN
      const peerChanged = (device.lastPeerNode ?? null) !== peerNode
      device.lastSeenAt = new Date(seenAtMs).toISOString()
      device.lastPeerNode = peerNode
      // In-memory is always current; the FILE is not rewritten per request.
      // Last-seen is a diagnostic to the nearest minute, and a busy remote
      // client would otherwise mean one synchronous disk write per tool call.
      if (!peerChanged && Number.isFinite(previousMs) && seenAtMs - previousMs < LAST_SEEN_PERSIST_INTERVAL_MS) return
      try {
        persist()
      } catch (error) {
        // Diagnostics, not authorization: a failed write must not fail the
        // request the device is making.
        options.log?.(`Tailnet device last-seen write failed: ${message(error)}`)
      }
    },
  }
}

function publicDevice(device: StoredDevice | TailnetDevice): TailnetDevice {
  return {
    id: device.id,
    name: device.name,
    scopes: [...device.scopes],
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    lastPeerNode: device.lastPeerNode,
  }
}

function readDevices(userDataDir: string, log?: (message: string) => void): StoredDevice[] {
  let raw: string
  try {
    raw = readFileSync(join(userDataDir, TAILNET_DEVICES_FILENAME), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') log?.(`Could not read ${TAILNET_DEVICES_FILENAME}: ${message(error)}`)
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    const entries = isRecord(parsed) && Array.isArray(parsed.devices) ? parsed.devices : []
    // A malformed entry is dropped, never repaired into a device with guessed
    // scopes: an unreadable grant is not a grant.
    return entries.flatMap((entry) => (isStoredDevice(entry) ? [normalizeStored(entry)] : []))
  } catch (error) {
    log?.(`${TAILNET_DEVICES_FILENAME} is not valid JSON (${message(error)}); no tailnet device is trusted until it is fixed.`)
    return []
  }
}

function isStoredDevice(value: unknown): value is StoredDevice {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    typeof value.tokenHash === 'string' &&
    value.tokenHash.length > 0 &&
    typeof value.createdAt === 'string' &&
    Array.isArray(value.scopes)
  )
}

function normalizeStored(value: StoredDevice): StoredDevice {
  return {
    id: value.id,
    name: value.name.slice(0, 120),
    scopes: normalizeTailnetScopes(value.scopes),
    createdAt: value.createdAt,
    lastSeenAt: typeof value.lastSeenAt === 'string' ? value.lastSeenAt : null,
    lastPeerNode: typeof value.lastPeerNode === 'string' ? value.lastPeerNode : null,
    tokenHash: value.tokenHash,
  }
}

/** Constant-time comparison of two hex digests; length-mismatch short-circuits safely. */
function secretsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
