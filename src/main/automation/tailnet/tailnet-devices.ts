import { randomBytes, randomInt, timingSafeEqual } from 'crypto'
import { chmodSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import { hashSecret } from '../../mobile/bridge/crypto'
import {
  normalizeTailnetScopes,
  PAIR_REQUEST_CODE_ATTEMPTS,
  type TailnetDevice,
  type TailnetDeviceOrigin,
  type TailnetPairingState,
  type TailnetPairRequest,
  type TailnetPairRequestOutcome,
  type TailnetScope,
} from '../../../shared/tailnet'
import { isRecord } from '../../../shared/records'

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

/**
 * How long a pairing request waits for someone to answer it (MC-2233).
 *
 * Short on purpose, and for the opposite reason to the offer's 30 days. An
 * offer sits inert until someone redeems it; a REQUEST is a live prompt on
 * another person's screen, and one that outlives the moment it was made is
 * something they are asked to adjudicate long after the context is gone. Five
 * minutes is long enough to walk to the other machine and short enough that a
 * forgotten request is not still approvable tomorrow.
 */
export const DEFAULT_PAIR_REQUEST_TTL_MS = 5 * 60 * 1000

/**
 * How long an APPROVED request keeps its token collectable.
 *
 * The token is handed to the poll that collects it and to nothing else, so this
 * only bounds how long it waits for a client that may have died between asking
 * and collecting.
 */
const APPROVED_COLLECT_TTL_MS = 5 * 60 * 1000

/** After a denial, how long that peer is refused before it may ask again. */
const DENY_COOLDOWN_MS = 60 * 1000

/**
 * Caps on pending requests: one per peer, and a ceiling across all of them.
 *
 * This is the new attack surface the approval path opens — any peer on the
 * tailnet can make a prompt appear here — so the panel can never be buried, and
 * a denied peer cannot immediately ask again. Neither cap is authorization;
 * they exist so a nuisance stays a nuisance.
 */
const MAX_PENDING_REQUESTS_PER_PEER = 1
const MAX_PENDING_REQUESTS = 8

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

export type TailnetPairRequestResult =
  | { ok: true; request: TailnetPairRequest }
  | {
      ok: false
      code: 'invalid_device_name' | 'invalid_collect_hash' | 'too_many_requests' | 'denied_recently'
      message: string
    }

export type TailnetPairApprovalResult =
  | { ok: true; device: TailnetDevice }
  | { ok: false; code: 'request_not_found' | 'code_required'; message: string }
  /**
   * The typed code did not match (pair-from-the-scan-and-stay-paired,
   * phase 2). `attemptsLeft` is what the card may still offer; `declined`
   * says the last allowed try was just spent and the request is gone.
   */
  | { ok: false; code: 'code_mismatch'; message: string; attemptsLeft: number; declined: boolean }

/**
 * What the collect poll answers, plus — for the gateway only — who asked, so
 * an approved collect can carry the asker's reverse grant to the fleet. The
 * `asker` never reaches the wire.
 */
export type TailnetCollectOutcome = TailnetPairRequestOutcome & {
  asker?: { deviceName: string; peerNode: string | null; peerAddress: string }
}

export type TailnetDeviceStore = {
  listDevices(): TailnetDevice[]
  /**
   * Replace any outstanding pairing with a fresh one (the Settings "regenerate"
   * action). `origin` is what the redeemed device will record as where it came
   * from — a carried code from Settings, or an agent that minted it.
   */
  offerPairing(input: { scopes: TailnetScope[]; ttlMs?: number; origin?: TailnetDeviceOrigin }): TailnetPairingOffer
  /**
   * Mint a device directly, with no exchange (phase 6): the reverse half of a
   * both-ways pairing, granted by THIS machine to the one it is asking to
   * drive. The token is returned once, to travel inside the collect.
   */
  mintDevice(input: { name: string; scopes: TailnetScope[]; origin: TailnetDeviceOrigin }): {
    device: TailnetDevice
    deviceToken: string
  }
  getPairingState(): TailnetPairingState | null
  cancelPairing(): void
  redeemPairing(input: { token: unknown; deviceName: unknown }): TailnetPairingResult
  /** The device this bearer token belongs to, or null. Reads live state, so a revoke lands on the next call. */
  authenticate(bearerToken: string | null | undefined): TailnetDevice | null
  revokeDevice(deviceId: string): boolean
  /** Fires with the revoked device id so live streams for it can be closed. */
  onDeviceRevoked(listener: (deviceId: string) => void): () => void
  recordSeen(deviceId: string, peerNode: string | null): void

  // ── Pairing by approval here (MC-2233) ─────────────────────────────────
  // The mirror of the offer above: instead of a code minted here and carried
  // away, a peer asks and a person answers. Nothing redeemable crosses the
  // wire in either direction until the approval mints it.

  /** Record a peer's request to pair. Refused rather than queued when capped. */
  requestPairing(input: {
    deviceName: unknown
    peerNode: string | null
    peerAddress: string
    /** SHA-256 of the secret the asker must present to collect. */
    collectHash: unknown
  }): TailnetPairRequestResult
  /** Requests still awaiting an answer here. Never includes answered ones. */
  listPairRequests(): TailnetPairRequest[]
  /**
   * Drop every request still waiting — the listener they arrived through is
   * going away, and a request nobody can collect must not stay answerable.
   * Returns the ids dropped so the caller can announce them as cancelled,
   * not lapsed. Approved-but-uncollected records are left alone: their
   * collect window is the asker's, and a listener re-enabled within it
   * should still hand the token over.
   */
  cancelPairRequests(): string[]
  /**
   * Approve one, minting the device with exactly the scopes named here.
   *
   * `code` is the six digits the asker's screen shows, typed by the person
   * approving: it proves they can see that screen, which is the binding the
   * comparison code was always for — now enforced rather than trusted. Three
   * wrong codes decline the request.
   */
  approvePairRequest(input: { id: string; scopes: TailnetScope[]; code: unknown }): TailnetPairApprovalResult
  denyPairRequest(id: string): boolean
  /**
   * What the requester polls. Yields the device token to exactly one call, and
   * only to a caller presenting the secret whose hash the request carried.
   */
  collectPairRequest(id: string, collectSecret: string): TailnetCollectOutcome
}

type StoredDevice = TailnetDevice & { tokenHash: string }

export function createTailnetDeviceStore(options: {
  resolveUserDataDir: () => string
  now?: () => Date
  /** How long an inbound pair request waits for an answer. Injected by tests that drive expiry for real. */
  pairRequestTtlMs?: number
  log?: (message: string) => void
}): TailnetDeviceStore {
  const now = options.now ?? (() => new Date())
  const pairRequestTtlMs = Math.max(1, options.pairRequestTtlMs ?? DEFAULT_PAIR_REQUEST_TTL_MS)
  const revokeListeners = new Set<(deviceId: string) => void>()
  let devices: StoredDevice[] = readDevices(options.resolveUserDataDir(), options.log)
  let pairing: {
    tokenHash: string
    scopes: TailnetScope[]
    expiresAtMs: number
    origin: TailnetDeviceOrigin
  } | null = null

  // Pending pair requests, and the peers currently in a post-denial cooldown.
  // In memory for the same reason the offer is: a request is a live prompt, and
  // one that survived a restart would be asking about a moment that is gone.
  type PendingState =
    | { kind: 'pending' }
    | {
        kind: 'approved'
        deviceId: string
        deviceName: string
        deviceToken: string
        scopes: TailnetScope[]
        collectableUntilMs: number
      }
    | { kind: 'denied' }
  const pairRequests = new Map<
    string,
    { request: TailnetPairRequest; collectHash: string; state: PendingState; codeAttempts: number }
  >()
  const deniedPeers = new Map<string, number>()

  function persist(): void {
    const path = join(options.resolveUserDataDir(), TAILNET_DEVICES_FILENAME)
    const body = `${JSON.stringify({ version: 1, devices }, null, 2)}\n`
    writeFileSync(path, body, { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(path, 0o600)
  }

  // The one place a device and its token come into existence, so the two
  // pairing paths cannot drift in what they create.
  function mintDevice(
    name: string,
    scopes: TailnetScope[],
    origin: TailnetDeviceOrigin
  ): { device: TailnetDevice; deviceToken: string } {
    const deviceToken = `mctn_${randomBytes(32).toString('base64url')}`
    const stored: StoredDevice = {
      id: `tnd_${randomBytes(9).toString('base64url')}`,
      name,
      scopes: normalizeTailnetScopes(scopes),
      createdAt: now().toISOString(),
      lastSeenAt: null,
      lastPeerNode: null,
      origin: { kind: origin.kind, by: origin.by ? origin.by.slice(0, 120) : null },
      tokenHash: hashSecret(deviceToken),
    }
    devices = [...devices, stored]
    persist()
    return { device: publicDevice(stored), deviceToken }
  }

  // Drops what nobody can act on any more: lapsed requests, approvals nobody
  // came back for, and expired cooldowns. Called from every entry point below,
  // so a store that is never read does not accumulate.
  function prunePairRequests(): void {
    const nowMs = now().getTime()
    for (const [id, entry] of pairRequests) {
      const deadline =
        entry.state.kind === 'approved' ? entry.state.collectableUntilMs : Date.parse(entry.request.expiresAt)
      if (Number.isFinite(deadline) && deadline <= nowMs) pairRequests.delete(id)
    }
    for (const [address, untilMs] of deniedPeers) if (untilMs <= nowMs) deniedPeers.delete(address)
  }

  /**
   * Six digits, uniformly drawn, and unique among the requests on screen.
   *
   * Uniqueness is the point: two prompts showing the same digits would make
   * the comparison meaningless at exactly the moment it matters.
   */
  function nextComparisonCode(): string {
    const taken = new Set([...pairRequests.values()].map((entry) => entry.request.comparisonCode))
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
      if (!taken.has(code)) return code
    }
    return String(randomInt(0, 1_000_000)).padStart(6, '0')
  }

  return {
    listDevices: () => devices.map(publicDevice),

    offerPairing(input): TailnetPairingOffer {
      const token = `mcpair_${randomBytes(24).toString('base64url')}`
      const scopes = normalizeTailnetScopes(input.scopes)
      const expiresAtMs = now().getTime() + Math.max(1000, input.ttlMs ?? DEFAULT_PAIRING_TTL_MS)
      pairing = { tokenHash: hashSecret(token), scopes, expiresAtMs, origin: input.origin ?? { kind: 'code', by: null } }
      return { token, scopes, expiresAt: new Date(expiresAtMs).toISOString() }
    },

    mintDevice(input): { device: TailnetDevice; deviceToken: string } {
      const name = input.name.trim().slice(0, 120) || 'Unnamed machine'
      return mintDevice(name, input.scopes, input.origin)
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
      const { scopes, origin } = pairing
      // One-time by construction: the offer is consumed whether or not the
      // persist below succeeds, so a failed write cannot leave a live code.
      pairing = null
      const minted = mintDevice(name, scopes, origin)
      return { ok: true, device: minted.device, deviceToken: minted.deviceToken }
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

    requestPairing(input): TailnetPairRequestResult {
      prunePairRequests()
      const name = typeof input.deviceName === 'string' ? input.deviceName.trim().slice(0, 120) : ''
      if (!name) {
        return {
          ok: false,
          code: 'invalid_device_name',
          message: 'A device name is required so the request is identifiable when it is answered.',
        }
      }
      const collectHash = typeof input.collectHash === 'string' ? input.collectHash.trim() : ''
      if (!collectHash) {
        // Refused rather than defaulted to an unbound request: a client that
        // forgot the field would otherwise get a token anyone with the id could
        // take, which is exactly what this field exists to prevent.
        return {
          ok: false,
          code: 'invalid_collect_hash',
          message: 'A collect hash is required, so the token can only be collected by the machine that asked.',
        }
      }
      const nowMs = now().getTime()
      const deniedUntilMs = deniedPeers.get(input.peerAddress)
      if (deniedUntilMs !== undefined && deniedUntilMs > nowMs) {
        // A denial is an answer. Letting the peer re-ask immediately would turn
        // "no" into a prompt the person has to keep dismissing.
        return {
          ok: false,
          code: 'denied_recently',
          message: 'That request was declined. Wait a minute before asking again.',
        }
      }
      const pendingHere = [...pairRequests.values()].filter((entry) => entry.state.kind === 'pending')
      const fromThisPeer = pendingHere.filter((entry) => entry.request.peerAddress === input.peerAddress)
      if (fromThisPeer.length >= MAX_PENDING_REQUESTS_PER_PEER || pendingHere.length >= MAX_PENDING_REQUESTS) {
        return {
          ok: false,
          code: 'too_many_requests',
          message: 'There is already a pairing request waiting to be answered on that machine.',
        }
      }
      const request: TailnetPairRequest = {
        id: `tpr_${randomBytes(12).toString('base64url')}`,
        deviceName: name,
        peerNode: input.peerNode,
        peerAddress: input.peerAddress,
        comparisonCode: nextComparisonCode(),
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + pairRequestTtlMs).toISOString(),
      }
      pairRequests.set(request.id, { request, collectHash, state: { kind: 'pending' }, codeAttempts: 0 })
      return { ok: true, request }
    },

    listPairRequests(): TailnetPairRequest[] {
      prunePairRequests()
      return [...pairRequests.values()]
        .filter((entry) => entry.state.kind === 'pending')
        .map((entry) => ({ ...entry.request }))
    },

    cancelPairRequests(): string[] {
      prunePairRequests()
      const cancelled: string[] = []
      for (const [id, entry] of pairRequests) {
        if (entry.state.kind !== 'pending') continue
        pairRequests.delete(id)
        cancelled.push(id)
      }
      return cancelled
    },

    approvePairRequest(input): TailnetPairApprovalResult {
      prunePairRequests()
      const entry = pairRequests.get(input.id)
      if (!entry || entry.state.kind !== 'pending') {
        // Covers unknown, already-answered and lapsed alike: in every one of
        // them there is no live request to approve, and the panel's next read
        // will show that.
        return {
          ok: false,
          code: 'request_not_found',
          message: 'That pairing request is no longer waiting to be answered.',
        }
      }
      // The typed code. Digits only, so "481 972" read off a screen with a
      // space in it is the same answer as "481972".
      const typed = typeof input.code === 'string' ? input.code.replace(/\D/gu, '') : ''
      if (!typed) {
        return {
          ok: false,
          code: 'code_required',
          message: 'Type the six-digit code shown on the asking machine to allow it.',
        }
      }
      if (!secretsMatch(typed, entry.request.comparisonCode)) {
        entry.codeAttempts += 1
        const attemptsLeft = Math.max(0, PAIR_REQUEST_CODE_ATTEMPTS - entry.codeAttempts)
        if (attemptsLeft === 0) {
          // The last allowed try: declined, with the same cooldown a Decline
          // gives, so the asker is told "no" rather than left waiting on a
          // request nobody can approve any more.
          pairRequests.set(input.id, { ...entry, state: { kind: 'denied' } })
          deniedPeers.set(entry.request.peerAddress, now().getTime() + DENY_COOLDOWN_MS)
          return {
            ok: false,
            code: 'code_mismatch',
            message: 'That code did not match. The request has been declined; ask again from the other machine.',
            attemptsLeft: 0,
            declined: true,
          }
        }
        return {
          ok: false,
          code: 'code_mismatch',
          message:
            attemptsLeft === 1
              ? 'That code did not match. One more try before the request is declined.'
              : `That code did not match. ${attemptsLeft} tries left.`,
          attemptsLeft,
          declined: false,
        }
      }
      // The scopes are whatever the person ticked, NOT anything the requester
      // asked for: a peer must not be able to influence what approving it
      // grants. An empty tick-list is a real answer — a device with no scopes
      // can authenticate and call nothing.
      const scopes = normalizeTailnetScopes(input.scopes)
      const minted = mintDevice(entry.request.deviceName, scopes, {
        kind: 'approval',
        by: entry.request.peerNode ?? entry.request.peerAddress ?? null,
      })
      pairRequests.set(input.id, {
        request: entry.request,
        collectHash: entry.collectHash,
        codeAttempts: entry.codeAttempts,
        state: {
          kind: 'approved',
          deviceId: minted.device.id,
          deviceName: minted.device.name,
          deviceToken: minted.deviceToken,
          scopes: minted.device.scopes,
          collectableUntilMs: now().getTime() + APPROVED_COLLECT_TTL_MS,
        },
      })
      return { ok: true, device: minted.device }
    },

    denyPairRequest(id): boolean {
      prunePairRequests()
      const entry = pairRequests.get(id)
      if (!entry || entry.state.kind !== 'pending') return false
      pairRequests.set(id, { ...entry, state: { kind: 'denied' } })
      deniedPeers.set(entry.request.peerAddress, now().getTime() + DENY_COOLDOWN_MS)
      return true
    },

    collectPairRequest(id, collectSecret): TailnetCollectOutcome {
      prunePairRequests()
      const entry = pairRequests.get(id)
      // An unknown id reports expired rather than getting an answer of its own:
      // there is nothing useful to tell a caller about an id it invented.
      if (!entry) return { status: 'expired' }
      // A wrong secret answers exactly what an unknown id answers, so a caller
      // holding an id it should not have cannot even learn that it is real.
      // Note this does NOT burn the request — same reasoning as a wrong pairing
      // code: a guess must not be able to cancel a pairing in flight.
      if (!secretsMatch(hashSecret(typeof collectSecret === 'string' ? collectSecret : ''), entry.collectHash)) {
        return { status: 'expired' }
      }
      if (entry.state.kind === 'denied') return { status: 'denied' }
      if (entry.state.kind === 'pending') {
        return {
          status: 'pending',
          comparisonCode: entry.request.comparisonCode,
          expiresAt: entry.request.expiresAt,
        }
      }
      // Approved: the token goes to this one call and the record goes with it,
      // so a second poll — or anyone replaying the id — gets nothing.
      const { deviceId, deviceName, deviceToken, scopes } = entry.state
      pairRequests.delete(id)
      return {
        status: 'approved',
        deviceId,
        deviceName,
        deviceToken,
        scopes,
        asker: {
          deviceName: entry.request.deviceName,
          peerNode: entry.request.peerNode,
          peerAddress: entry.request.peerAddress,
        },
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
    origin: { kind: device.origin.kind, by: device.origin.by },
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
    // A record from before origins were kept says so, rather than guessing
    // one: "unknown" is a true statement about it and "code" would not be.
    origin: readOrigin(value.origin),
    tokenHash: value.tokenHash,
  }
}

const ORIGIN_KINDS: ReadonlySet<string> = new Set(['code', 'approval', 'agent', 'reverse', 'unknown'])

function readOrigin(value: unknown): TailnetDeviceOrigin {
  if (!isRecord(value) || typeof value.kind !== 'string' || !ORIGIN_KINDS.has(value.kind)) {
    return { kind: 'unknown', by: null }
  }
  return {
    kind: value.kind as TailnetDeviceOrigin['kind'],
    by: typeof value.by === 'string' && value.by ? value.by.slice(0, 120) : null,
  }
}

/** Constant-time comparison of two hex digests; length-mismatch short-circuits safely. */
function secretsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
