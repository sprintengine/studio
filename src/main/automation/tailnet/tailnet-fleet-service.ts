import { randomBytes } from 'crypto'

import { hashSecret } from '../../mobile/bridge/crypto'
import { hostname } from 'os'

import { backoffDelayMs } from '../../../shared/exponentialBackoff'
import { normalizeTailnetScopes, type TailnetDevice, type TailnetReverseGrant, type TailnetScope } from '../../../shared/tailnet'
import {
  fleetTerminalAccess,
  type FleetAttachResult,
  type FleetBrowse,
  type FleetConnection,
  type FleetEvent,
  type FleetLinkState,
  type FleetLiveState,
  type FleetMachineReachability,
  type FleetPairRequestPhase,
  type FleetCreateTerminalResult,
  type FleetGap,
  type FleetPairResult,
  type FleetRun,
  type FleetTerminal,
  type FleetTerminalEvent,
  type FleetWorkspace,
  type FleetCollectPairingResult,
  type FleetPairRequestView,
  type FleetRequestPairingResult,
  type FleetCheckoutRequest,
  type FleetForgetMachineResult,
  type FleetWorkspaceCheckoutResult,
} from '../../../shared/tailnet-fleet'
import { createTailnetFleetStore, type StoredFleetConnection, type TailnetFleetStore } from './tailnet-fleet-store'
import { tailnetPeerSupports } from './tailnet-routes'
import {
  callRemoteTool,
  formatTailnetEndpoint,
  openRemoteEventsSocket,
  openRemoteTerminalSocket,
  collectPairingFromMachine,
  pairWithMachine,
  parsePairingUrl,
  requestPairingFromMachine,
  type TailnetEndpoint,
  parseTailnetEndpoint,
  readRemoteIdentity,
  type RemoteTerminalSocket,
} from './tailnet-remote-client'
import { asRecord } from '../../../shared/records'

// The Fleet: this Studio driving other machines (MC-2167).
//
// Everything a window needs to work "on the Mini from the laptop" — the paired
// machines, what they hold, and the terminals open on them — with the tokens
// and the sockets kept in main. A window sends keystrokes and receives frames;
// it never holds a credential and never opens a connection.
//
// The reconnect loop is the part that earns its keep. A laptop lid closing, a
// Wi-Fi handover, a peer that sleeps: none of them are errors, and none of them
// should cost a person their scrollback. A dropped socket re-dials, and the
// listener answers a fresh attach with a `replay` — the retained scrollback,
// which is a superset of whatever was missed — so the pane repaints rather than
// showing a hole.

/** First retry is fast (a Wi-Fi blip), then backs off to a quiet poll for a sleeping peer. */
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000
/** After this many failed dials the pane stops saying "reconnecting" and says the peer is not answering. */
const OFFLINE_AFTER_ATTEMPTS = 3
/** A change-feed watch on a machine that is away re-dials this slowly at most; the reachability probe is the other beat. */
const WATCH_RETRY_MAX_MS = 60_000

// ── Staying paired (pair-from-the-scan-and-stay-paired, phases 3, 4, 6) ─────
//
// Main owns the wait on a request this machine made, so closing the panel
// that asked does not abandon it; main checks whether each paired machine
// answers, on the moments that change the answer, so a machine with no pane
// open is not shown as merely "paired" forever; and a request may carry the
// reverse half of a both-ways pairing, minted here for the machine asked.

/**
 * How often a waiting request asks the other machine for an answer. Slow on
 * purpose: the thing being waited on is a person walking to a computer, and
 * every poll is a round trip to a real machine.
 */
const DEFAULT_PAIR_POLL_MS = 2000
/**
 * How long past the other machine's own expiry a request keeps polling
 * before it is called expired HERE — for the case where that machine went
 * to sleep and cannot say so itself.
 */
const PAIR_WAIT_GRACE_MS = 15_000
/**
 * Every paired machine is checked this often while a window is open. Five
 * minutes is a row that is right within a coffee's length, at one small
 * authenticated call per machine per interval.
 */
const DEFAULT_REACHABILITY_INTERVAL_MS = 5 * 60_000
/** A check must be cheap for a sleeping laptop too: three seconds, not the browse's ten. */
const DEFAULT_REACHABILITY_TIMEOUT_MS = 3_000

export type TailnetFleetService = {
  /**
   * Begin the reachability supervisor (phase 4): one check of every paired
   * machine now, and one per interval from here on. Idempotent.
   */
  start(): void
  /**
   * The machine woke, or came back on a network (phase 4): check every
   * paired machine now, and re-dial every attachment that was waiting out a
   * backoff — a lid opening should reconnect at once, not in fifteen seconds.
   */
  onWake(): void
  /**
   * Check whether one paired machine (or every one) answers right now, and
   * report the state after. The row's Retry.
   */
  checkReachability(connectionId?: unknown): Promise<FleetLiveState>
  listConnections(): FleetConnection[]
  pair(input: { pairingUrl: unknown; deviceName?: unknown }): Promise<FleetPairResult>
  /**
   * Ask a machine to pair and wait for someone there to approve it (MC-2233).
   *
   * The outward half stays main's for the same reason `pair` does: the listener
   * refuses any request carrying an `Origin` header, so a window physically
   * cannot dial a peer. The collect secret lives here and is never handed to a
   * renderer. Main also owns the WAIT (phase 3): the poll runs here until the
   * request is answered, lapses, or is cancelled, and every phase is broadcast
   * as a `pair-request` fleet event.
   *
   * `scopes` is what this machine asks to be allowed to do THERE;
   * `reverseScopes` (phase 6) offers the machine asked a device HERE with those
   * scopes, so approving over there pairs both ways in the one exchange.
   * Refused when this machine's own listener is not running: a grant to a
   * listener that is down is a credential pointing at nothing.
   */
  requestPairing(input: {
    endpoint: unknown
    deviceName?: unknown
    /**
     * What to ask that machine to let THIS one do — the outbound half. Sent
     * with the request so the person answering sees the set that was asked
     * for; they still decide what is granted. Absent leaves the far end's
     * default (`TAILNET_STRUCTURED_SCOPES`) in force.
     */
    scopes?: unknown
    reverseScopes?: unknown
  }): Promise<FleetRequestPairingResult>
  /**
   * Poll one request we made, now, and report. The timer polls on its own;
   * this is the one-off a surface may ask for. Lands the connection when
   * the request has been approved.
   */
  collectPairing(requestId: unknown): Promise<FleetCollectPairingResult>
  /** Forget a request we made. The far end's copy lapses on its own; a reverse device minted for it is revoked. */
  cancelPairing(requestId: unknown): void
  /**
   * Adopt the reverse half of a both-ways pairing another machine offered
   * when it asked to drive THIS one (phase 6): the gateway has verified the
   * grant's endpoint is the asker's own address, and a person here approved
   * the request it rode in on. Stored as a machine this Studio can drive.
   */
  adoptReverseGrant(input: { grant: TailnetReverseGrant; askerName: string; peerNode: string | null }): FleetConnection | null
  forget(connectionId: unknown): FleetConnection[]
  /**
   * End a pairing in both directions (remote-settings-rebuild).
   *
   * A person looking at a machine in Settings sees one relationship, not two
   * credentials; Revoke there must not leave the other half live. Either id may
   * be absent — a machine that only ever drove this one has no connection here,
   * and one this machine only ever drove has no device here — and an id that is
   * already gone is not an error, because "we are not paired any more" is the
   * state the caller asked for and the state it gets.
   */
  forgetMachine(input: { deviceId?: unknown; connectionId?: unknown }): FleetForgetMachineResult
  browse(connectionId: unknown): Promise<FleetBrowse>
  listRuns(
    connectionId: unknown,
    workspaceId: unknown
  ): Promise<{ ok: true; runs: FleetRun[] } | { ok: false; code: string; message: string }>
  createTerminal(input: {
    connectionId: unknown
    workspaceId?: unknown
    name?: unknown
    cli?: unknown
    prompt?: unknown
    cliModel?: unknown
    permissionPreset?: unknown
    /** Where the chat runs there (checkout-and-branch-on-remote-create); the current checkout when absent. */
    checkout?: unknown
  }): Promise<FleetCreateTerminalResult>
  /**
   * One remote workspace's checkout facts — branch, trunk, branches,
   * worktrees — over `workspace.checkout` (workspace:read). A pairing that
   * may not read them gets the refusal as its answer, never an empty list
   * dressed as "no branches".
   */
  workspaceCheckout(connectionId: unknown, workspaceId: unknown): Promise<FleetWorkspaceCheckoutResult>
  /**
   * Attach a pane to a remote session. `emit` is the pane's event sink; the
   * caller owns its lifetime and calls `detach` when the pane goes away.
   */
  attachTerminal(input: {
    attachId: string
    connectionId: unknown
    sessionId: unknown
    emit: (event: FleetTerminalEvent) => void
  }): Promise<FleetAttachResult>
  sendInput(attachId: unknown, data: unknown): void
  resizeTerminal(attachId: unknown, cols: unknown, rows: unknown): void
  detachTerminal(attachId: unknown): void
  /**
   * Every attachment held right now with its link state, stamped with the
   * same revision the events carry — the initial read behind `onEvent`, so a
   * window that mounts after a pane went live is not stuck on "paired".
   */
  getLiveState(): FleetLiveState
  shutdown(): void
}

export type TailnetFleetServiceOptions = {
  resolveUserDataDir: () => string
  /** This machine's name, as the other end will list the pairing. */
  resolveDeviceName?: () => string
  /** Tailscale node name for an address, so a machine is listed by name rather than by IP. */
  resolvePeerName?: (address: string) => Promise<string | null>
  /**
   * Whole-app fleet lifecycle for the live-state push (remote-sessions-ux):
   * a machine paired or forgotten, an attachment's link state changing. The
   * per-attachment pty stream stays on its own channel to the owning window;
   * these are the facts chrome in every window may show. Payloads never carry
   * a credential — connections cross this boundary as the store's public view.
   */
  onEvent?: (event: FleetEvent) => void
  /**
   * Mint a device on THIS machine's listener for a machine it is asking to
   * drive (phase 6). Null when nothing is listening here. Absent in a build
   * with no listener at all, which simply never offers the reverse half.
   */
  mintReverseDevice?: (input: { machineName: string; scopes: TailnetScope[] }) => {
    device: TailnetDevice
    deviceToken: string
    endpoint: string
  } | null
  /** Take back a reverse device when the request it was minted for did not complete. */
  revokeReverseDevice?: (deviceId: string) => void
  /**
   * Revoke a device on THIS machine's listener, whatever minted it.
   *
   * Distinct from `revokeReverseDevice`, which undoes a grant this service
   * itself just made when a request failed. This is the inbound half of
   * `forgetMachine`, and it may be a device that arrived by carried code or by
   * approval — nothing this service ever created. Returns whether a device was
   * actually there, so the caller can report which halves it ended.
   */
  revokeInboundDevice?: (deviceId: string) => boolean
  /** Whether a window is open — the reachability timer only runs while one is. Defaults to always. */
  hasWindow?: () => boolean
  /** Injected in tests, which cannot wait minutes. */
  pairPollMs?: number
  reachabilityIntervalMs?: number
  reachabilityTimeoutMs?: number
  createStore?: (options: { resolveUserDataDir: () => string; log?: (message: string) => void }) => TailnetFleetStore
  log?: (message: string) => void
}

/** A fleet event before the service stamps its revision — distributed over the union, member by member. */
type FleetEventBody = FleetEvent extends infer E ? (E extends FleetEvent ? Omit<E, 'revision'> : never) : never

type Attachment = {
  attachId: string
  connectionId: string
  sessionId: string
  emit: (event: FleetTerminalEvent) => void
  socket: RemoteTerminalSocket | null
  /** Set once the pane detaches, so an in-flight reconnect stops instead of resurrecting it. */
  released: boolean
  /** Whether THIS dial got as far as an attach header; reset on every dial. */
  attachedThisDial: boolean
  /** The last refusal the far end sent on this dial, if any. */
  refusalThisDial: string | null
  attempts: number
  retryTimer: ReturnType<typeof setTimeout> | null
  /** Last known size, replayed after a reconnect so the remote pty matches the pane. */
  size: { cols: number; rows: number } | null
  /** The last status frame's state, so a snapshot can say what the pane was last told. */
  state: FleetLinkState
  detail: string
}

export function createTailnetFleetService(options: TailnetFleetServiceOptions): TailnetFleetService {
  const store = (options.createStore ?? createTailnetFleetStore)({
    resolveUserDataDir: options.resolveUserDataDir,
    log: options.log,
  })
  const deviceName = () => (options.resolveDeviceName ?? defaultDeviceName)()
  const attachments = new Map<string, Attachment>()
  const pairPollMs = Math.max(50, options.pairPollMs ?? DEFAULT_PAIR_POLL_MS)
  const reachabilityIntervalMs = Math.max(50, options.reachabilityIntervalMs ?? DEFAULT_REACHABILITY_INTERVAL_MS)
  const reachabilityTimeoutMs = Math.max(50, options.reachabilityTimeoutMs ?? DEFAULT_REACHABILITY_TIMEOUT_MS)
  // Stamped on every broadcast and every snapshot; only ever goes up, so a
  // subscriber can order a late initial read against events already applied.
  let revision = 0
  const broadcast = (event: FleetEventBody): void => {
    revision += 1
    options.onEvent?.({ ...event, revision })
  }

  function connectionFor(connectionId: unknown): StoredFleetConnection | null {
    return typeof connectionId === 'string' ? store.find(connectionId) : null
  }

  async function pair(input: { pairingUrl: unknown; deviceName?: unknown }): Promise<FleetPairResult> {
    const raw = typeof input.pairingUrl === 'string' ? input.pairingUrl : ''
    const parsed = parsePairingUrl(raw)
    if (!parsed) {
      return {
        ok: false,
        code: 'invalid_pairing_link',
        message: 'That is not a pairing link. Copy the whole link from the other machine\'s Settings → Remote.',
      }
    }
    const name = typeof input.deviceName === 'string' && input.deviceName.trim() ? input.deviceName.trim() : deviceName()
    if (!name) {
      return {
        ok: false,
        code: 'device_name_required',
        message: 'This machine has no name to pair under. Name it and try again.',
      }
    }
    const paired = await pairWithMachine({
      endpoint: parsed.endpoint,
      pairingToken: parsed.pairingToken,
      deviceName: name,
    })
    if (!paired.ok) return { ok: false, code: paired.code, message: paired.message }

    // Named by Tailscale where it can be — an address is a correct label and a
    // useless one. The address stays as the fallback rather than an invented name.
    const peerName = (await options.resolvePeerName?.(parsed.endpoint.host).catch(() => null)) ?? null
    try {
      const connection = store.add({
        machineName: peerName ?? parsed.endpoint.host,
        endpoint: formatTailnetEndpoint(parsed.endpoint),
        deviceId: paired.value.deviceId,
        deviceName: paired.value.deviceName,
        deviceToken: paired.value.deviceToken,
        scopes: paired.value.scopes,
        pairedVia: 'link',
      })
      broadcast({ kind: 'machine-paired', connection })
      // It just answered a pairing, so it is reachable — recorded rather
      // than left for the next timer to discover.
      recordReachability(connection, { reachable: true, unauthorized: false, detail: null })
      startWatch(connection.id)
      return { ok: true, connection }
    } catch (error) {
      // The device now exists on the other machine. Saying "paired" over a token
      // we could not keep would leave a live grant nothing here can name — so
      // say exactly what happened and what to do about it.
      return {
        ok: false,
        code: 'pairing_not_saved',
        message:
          `Paired with ${formatTailnetEndpoint(parsed.endpoint)}, but the credential could not be saved here `
          + `(${message(error)}). Revoke this device on that machine and pair again.`,
      }
    }
  }

  // Requests this machine has made and is waiting on. In memory, like the
  // target's own pending list: a request that outlived a restart would be
  // waiting on a moment nobody is still in. The poll lives HERE (phase 3),
  // so the wait outlives whichever panel asked.
  type OutboundRequest = {
    endpoint: TailnetEndpoint
    collectSecret: string
    view: FleetPairRequestView
    /** The reverse half offered to the machine asked (phase 6), or null. */
    reverse: TailnetReverseGrant | null
    timer: ReturnType<typeof setTimeout> | null
    /** A poll is on the wire; the timer must not stack a second. */
    polling: Promise<void> | null
  }
  const outboundRequests = new Map<string, OutboundRequest>()
  // How each request this session ended, so a surface that asks late (a
  // panel that was closed while the answer landed) hears the answer rather
  // than "expired". Bounded: a session makes a handful of requests, ever.
  const settledRequests = new Map<string, FleetCollectPairingResult>()

  function announceRequest(
    request: OutboundRequest,
    phase: FleetPairRequestPhase,
    extra: { connection?: FleetConnection; detail?: string } = {}
  ): void {
    broadcast({ kind: 'pair-request', phase, request: { ...request.view }, ...extra })
  }

  /** End a request here: stop its timer, take back its reverse device, and drop it. */
  function endRequest(request: OutboundRequest, keepReverse: boolean, settled?: FleetCollectPairingResult): void {
    if (request.timer) clearTimeout(request.timer)
    request.timer = null
    outboundRequests.delete(request.view.requestId)
    if (settled) settledRequests.set(request.view.requestId, settled)
    if (request.reverse && !keepReverse) {
      // The device was minted for a pairing that did not complete; leaving it
      // would leave a live grant on this machine that nothing names.
      try {
        options.revokeReverseDevice?.(request.reverse.deviceId)
      } catch (error) {
        options.log?.(`Could not revoke reverse device ${request.reverse.deviceId}: ${message(error)}`)
      }
    }
  }

  function scheduleRequestPoll(request: OutboundRequest): void {
    if (request.timer || !outboundRequests.has(request.view.requestId)) return
    request.timer = setTimeout(() => {
      request.timer = null
      void pollRequest(request)
    }, pairPollMs)
    request.timer.unref?.()
  }

  /** One poll of one request. Resolves when the answer has been applied and announced. */
  function pollRequest(request: OutboundRequest): Promise<void> {
    if (request.polling) return request.polling
    if (!outboundRequests.has(request.view.requestId)) return Promise.resolve()
    request.polling = (async () => {
      const collected = await collectPairingFromMachine({
        endpoint: request.endpoint,
        requestId: request.view.requestId,
        collectSecret: request.collectSecret,
        reverse: request.reverse,
      })
      // Cancelled while the poll was on the wire: whatever it says is moot.
      if (!outboundRequests.has(request.view.requestId)) return
      if (!collected.ok) {
        // A machine that went to sleep mid-wait is not a refusal — keep
        // waiting until its own expiry has clearly passed, then call it.
        const expiresAtMs = Date.parse(request.view.expiresAt)
        if (Number.isFinite(expiresAtMs) && Date.now() > expiresAtMs + PAIR_WAIT_GRACE_MS) {
          endRequest(request, false, { ok: true, status: 'expired' })
          announceRequest(request, 'expired', { detail: collected.message })
          return
        }
        scheduleRequestPoll(request)
        return
      }
      const outcome = collected.value
      if (outcome.status === 'pending') {
        // The far end restates the code and expiry on every poll; keep them
        // current so a card that mounts late shows what is on the other screen.
        request.view = { ...request.view, comparisonCode: outcome.comparisonCode, expiresAt: outcome.expiresAt }
        scheduleRequestPoll(request)
        return
      }
      if (outcome.status !== 'approved') {
        endRequest(request, false, { ok: true, status: outcome.status })
        announceRequest(request, outcome.status, {
          detail:
            outcome.status === 'denied'
              ? `${request.view.machineName} declined the request.`
              : 'The request lapsed before anyone answered it.',
        })
        return
      }
      let connection: FleetConnection
      try {
        connection = store.add({
          machineName: request.view.machineName,
          endpoint: request.view.endpoint,
          deviceId: outcome.deviceId,
          deviceName: outcome.deviceName,
          deviceToken: outcome.deviceToken,
          scopes: outcome.scopes,
          pairedVia: 'request',
        })
      } catch (error) {
        // Same failure the carried-code path has, and the same honesty about it:
        // the device exists over there now, and nothing here can name it. The
        // reverse device stays, though — the other machine now holds its token
        // and will list it, so it must be revocable by name here.
        const detail =
          `${request.view.machineName} approved the request, but the credential could not be saved here `
          + `(${message(error)}). Revoke this device on that machine and ask again.`
        endRequest(request, true, { ok: false, code: 'pairing_not_saved', message: detail })
        announceRequest(request, 'failed', { detail })
        return
      }
      endRequest(request, true, { ok: true, status: 'approved', connection })
      broadcast({ kind: 'machine-paired', connection })
      announceRequest(request, 'approved', { connection })
      recordReachability(connection, { reachable: true, unauthorized: false, detail: null })
      startWatch(connection.id)
    })().finally(() => {
      request.polling = null
    })
    return request.polling
  }

  async function requestPairing(input: {
    endpoint: unknown
    deviceName?: unknown
    scopes?: unknown
    reverseScopes?: unknown
  }): Promise<FleetRequestPairingResult> {
    const endpoint = parseTailnetEndpoint(typeof input.endpoint === 'string' ? input.endpoint : '')
    if (!endpoint) {
      return { ok: false, code: 'invalid_endpoint', message: 'That is not a machine address this can dial.' }
    }
    const name = typeof input.deviceName === 'string' && input.deviceName.trim() ? input.deviceName.trim() : deviceName()
    if (!name) {
      return {
        ok: false,
        code: 'device_name_required',
        message: 'This machine has no name to pair under. Name it and try again.',
      }
    }
    // One request per machine at a time, from here: the far end refuses a
    // second anyway, and two cards waiting on one machine would be two
    // codes for one approval.
    for (const pending of outboundRequests.values()) {
      if (formatTailnetEndpoint(pending.endpoint) === formatTailnetEndpoint(endpoint)) {
        return {
          ok: false,
          code: 'already_waiting',
          message: `A request to ${pending.view.machineName} is already waiting to be answered.`,
        }
      }
    }
    const peerName = (await options.resolvePeerName?.(endpoint.host).catch(() => null)) ?? null
    const machineName = peerName ?? endpoint.host

    // The reverse half first (phase 6): minted before the ask so a listener
    // that is down refuses the whole thing rather than half of it. Only when
    // asked for — a phone, or a person who wants one direction, offers none.
    let reverse: TailnetReverseGrant | null = null
    const reverseScopes = input.reverseScopes === undefined ? null : normalizeTailnetScopes(input.reverseScopes)
    if (reverseScopes) {
      if (!options.mintReverseDevice) {
        return {
          ok: false,
          code: 'reverse_unavailable',
          message: 'This machine cannot be driven back: it has no listener to grant.',
        }
      }
      const minted = options.mintReverseDevice({ machineName, scopes: reverseScopes })
      if (!minted) {
        return {
          ok: false,
          code: 'reverse_unavailable',
          message: 'Turn on Remote here first, or ask without letting that machine drive this one. A grant to a listener that is not running would point at nothing.',
        }
      }
      reverse = {
        endpoint: minted.endpoint,
        machineName: name,
        deviceId: minted.device.id,
        deviceName: minted.device.name,
        deviceToken: minted.deviceToken,
        scopes: minted.device.scopes,
      }
    }

    // The secret stays here; only its hash is sent. Collecting the token later
    // means presenting it, so knowing the request id is not enough to take it.
    const collectSecret = randomBytes(24).toString('base64url')
    // Undefined, not an empty array, when nothing was asked for: the far end's
    // default is the one that applies, and an empty list would read as a
    // request for no access at all.
    const requestScopes = input.scopes === undefined ? undefined : normalizeTailnetScopes(input.scopes)
    const asked = await requestPairingFromMachine({
      endpoint,
      deviceName: name,
      collectHash: hashSecret(collectSecret),
      ...(requestScopes && requestScopes.length > 0 ? { scopes: requestScopes } : {}),
    })
    if (!asked.ok) {
      if (reverse) options.revokeReverseDevice?.(reverse.deviceId)
      return { ok: false, code: asked.code, message: asked.message }
    }

    const view: FleetPairRequestView = {
      requestId: asked.value.requestId,
      endpoint: formatTailnetEndpoint(endpoint),
      machineName,
      comparisonCode: asked.value.comparisonCode,
      expiresAt: asked.value.expiresAt,
      reverseOffered: reverse !== null,
    }
    const request: OutboundRequest = { endpoint, collectSecret, view, reverse, timer: null, polling: null }
    outboundRequests.set(view.requestId, request)
    announceRequest(request, 'waiting')
    scheduleRequestPoll(request)
    return { ok: true, request: view }
  }

  async function collectPairing(requestId: unknown): Promise<FleetCollectPairingResult> {
    const id = typeof requestId === 'string' ? requestId : ''
    const pending = outboundRequests.get(id)
    if (!pending) {
      // Already ended here: say how. Nothing at all under that id — a
      // restart, or an id from another window — reads as expired, which is
      // what it is to this process.
      return settledRequests.get(id) ?? { ok: true, status: 'expired' }
    }
    // Poll now rather than waiting for the timer, then report what the poll
    // applied — the same path the timer takes, so a surface asking cannot
    // race the broadcast to a different answer.
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
    }
    await pollRequest(pending)
    if (outboundRequests.has(id)) return { ok: true, status: 'pending', request: { ...pending.view } }
    return settledRequests.get(id) ?? { ok: true, status: 'expired' }
  }

  function cancelPairing(requestId: unknown): void {
    const pending = outboundRequests.get(typeof requestId === 'string' ? requestId : '')
    if (!pending) return
    endRequest(pending, false, { ok: true, status: 'expired' })
    announceRequest(pending, 'cancelled')
  }

  function adoptReverseGrant(input: {
    grant: TailnetReverseGrant
    askerName: string
    peerNode: string | null
  }): FleetConnection | null {
    const { grant } = input
    // The same machine twice is two real records over there, exactly as a
    // second carried-code pairing is — but a reverse grant arrives without
    // anyone here pressing anything, so a duplicate for an endpoint already
    // paired replaces the old credential rather than stacking a row nobody
    // asked for. The old device over there is named in the log for revoking.
    const existing = store.list().find((entry) => entry.endpoint === grant.endpoint && entry.pairedVia === 'reverse')
    if (existing) {
      options.log?.(
        `Replacing the reverse pairing for ${grant.endpoint}: device "${existing.deviceName}" there is now unused; revoke it in that machine's Remote settings.`
      )
      store.forget(existing.id)
    }
    let connection: FleetConnection
    try {
      connection = store.add({
        machineName: input.peerNode ?? grant.machineName ?? input.askerName,
        endpoint: grant.endpoint,
        deviceId: grant.deviceId,
        deviceName: grant.deviceName,
        deviceToken: grant.deviceToken,
        scopes: grant.scopes,
        pairedVia: 'reverse',
      })
    } catch (error) {
      options.log?.(`Could not keep the reverse pairing from ${input.askerName}: ${message(error)}`)
      return null
    }
    if (existing) {
      stopWatch(existing.id)
      broadcast({ kind: 'machine-forgotten', connectionId: existing.id, machineName: existing.machineName })
    }
    broadcast({ kind: 'machine-paired', connection })
    void probeReachability(connection)
    startWatch(connection.id)
    return connection
  }

  // ── Reachability (phase 4) ────────────────────────────────────────────────
  //
  // One small authenticated call per machine — the identity read, which is
  // also the one that tells "asleep" from "revoked over there" — on the
  // moments that change the answer: start, wake, the interval, a Retry. The
  // browse and the dial feed the same record, so a machine that just
  // answered a person is not shown as "not answering" until the next timer.
  const reachability = new Map<string, FleetMachineReachability>()
  const probes = new Map<string, Promise<void>>()
  let reachabilityTimer: ReturnType<typeof setInterval> | null = null

  function reachabilityFor(connection: FleetConnection): FleetMachineReachability {
    return (
      reachability.get(connection.id) ?? {
        connectionId: connection.id,
        machineName: connection.machineName,
        checking: false,
        reachable: false,
        unauthorized: false,
        checkedAt: null,
        lastReachedAt: connection.lastConnectedAt ? Date.parse(connection.lastConnectedAt) || null : null,
        detail: null,
      }
    )
  }

  function recordReachability(
    connection: FleetConnection,
    answer: { reachable: boolean; unauthorized: boolean; detail: string | null }
  ): void {
    const previous = reachabilityFor(connection)
    const now = Date.now()
    const next: FleetMachineReachability = {
      ...previous,
      machineName: connection.machineName,
      checking: false,
      reachable: answer.reachable,
      unauthorized: answer.unauthorized,
      checkedAt: now,
      lastReachedAt: answer.reachable ? now : previous.lastReachedAt,
      detail: answer.reachable ? null : answer.detail,
    }
    reachability.set(connection.id, next)
    broadcast({ kind: 'machine-reachability', ...next })
  }

  function probeReachability(connection: FleetConnection): Promise<void> {
    const inFlight = probes.get(connection.id)
    if (inFlight) return inFlight
    const checking: FleetMachineReachability = { ...reachabilityFor(connection), checking: true }
    reachability.set(connection.id, checking)
    broadcast({ kind: 'machine-reachability', ...checking })
    const probe = (async () => {
      const stored = store.find(connection.id)
      if (!stored) return
      const identity = await readRemoteIdentity({
        endpoint: endpointOf(stored),
        token: stored.deviceToken,
        timeoutMs: reachabilityTimeoutMs,
      })
      // Forgotten while the probe was out: nothing to record it against.
      if (!store.find(connection.id)) return
      if (identity.ok) {
        store.updateScopes(connection.id, identity.value.scopes)
        store.markConnected(connection.id)
        rememberCapabilities(connection.id, identity.value.capabilities)
        recordReachability(connection, { reachable: true, unauthorized: false, detail: null })
        return
      }
      recordReachability(connection, {
        reachable: false,
        unauthorized: identity.code === 'unauthorized',
        detail: identity.message,
      })
    })().finally(() => {
      probes.delete(connection.id)
    })
    probes.set(connection.id, probe)
    return probe
  }

  async function checkAllReachability(): Promise<void> {
    await Promise.all(store.list().map((connection) => probeReachability(connection)))
  }

  // ── The change feed (2026-09-05) ──────────────────────────────────────────
  //
  // One idle WebSocket per paired machine, on which that machine says its
  // terminal list or workspace list changed. Held for as long as the machine
  // is paired — a watch is a listener, not a browse, and costs nothing while
  // nothing changes — re-dialled with backoff when the machine is away. The
  // Remote band re-reads on the event it produces, which is what let its
  // 30-second timer go: on a machine holding many sessions every one of
  // those timed reads was seconds of the other machine's main thread.
  type Watch = {
    connectionId: string
    socket: RemoteTerminalSocket | null
    retryTimer: ReturnType<typeof setTimeout> | null
    attempts: number
    released: boolean
  }
  const watches = new Map<string, Watch>()
  /**
   * The capability list each machine published, the last time one answered a
   * handshake. Null for a machine that published none, absent for one that has
   * not answered yet.
   *
   * Not persisted: a capability list is a fact about the build running over
   * there right now, and one read off disk would outlive the install that said
   * it.
   */
  const peerCapabilities = new Map<string, string[] | null>()

  /**
   * Record what a machine just said it can do, and bring its change-feed watch
   * into line with it.
   *
   * Both directions, because a capability list changes when the build over
   * there does: a machine that has just said it has no feed should stop being
   * re-dialled now rather than at the next backoff tick, and one that has just
   * gained the feed should be watched without waiting for a restart here.
   * A machine that published no list is left exactly as it was — see the gate
   * in `dialWatch` for why silence is not a denial.
   */
  function rememberCapabilities(connectionId: string, capabilities: string[] | null): void {
    peerCapabilities.set(connectionId, capabilities)
    if (capabilities === null) return
    const watched = watches.has(connectionId)
    const supported = tailnetPeerSupports(capabilities, 'events')
    if (watched && !supported) stopWatch(connectionId)
    // Only while the supervisor is running: outside it, nothing is watched at
    // all, and a probe must not be what starts a socket `start` never asked for.
    else if (!watched && supported && reachabilityTimer) startWatch(connectionId)
  }

  function startWatch(connectionId: string): void {
    if (watches.has(connectionId)) return
    const watch: Watch = { connectionId, socket: null, retryTimer: null, attempts: 0, released: false }
    watches.set(connectionId, watch)
    void dialWatch(watch)
  }

  function stopWatch(connectionId: string): void {
    const watch = watches.get(connectionId)
    if (!watch) return
    watch.released = true
    if (watch.retryTimer) clearTimeout(watch.retryTimer)
    watch.retryTimer = null
    watch.socket?.close('Stopped watching.')
    watch.socket = null
    watches.delete(connectionId)
  }

  async function dialWatch(watch: Watch): Promise<void> {
    if (watch.released) return
    const connection = store.find(watch.connectionId)
    if (!connection) {
      stopWatch(watch.connectionId)
      return
    }
    // The change feed is a capability, not a version: a machine that published a
    // list without `events` has no route to upgrade and would answer every dial
    // with a 404, forever, on a backoff that tops out at a minute. Asked of the
    // capability list rather than of `transportVersion >= 2` so that a peer
    // which back-ports the feed, or a later build that drops it, is read as it
    // describes itself.
    //
    // Only a PUBLISHED list closes this gate. A machine that named none (null)
    // or has not answered a handshake yet (absent) is dialled anyway: the feed
    // shipped a day before the capability list did, so silence there means
    // "unknown", and treating it as a denial would switch off a feed that works.
    const published = peerCapabilities.get(watch.connectionId)
    if (published && !tailnetPeerSupports(published, 'events')) {
      stopWatch(watch.connectionId)
      return
    }
    const opened = await openRemoteEventsSocket({
      endpoint: endpointOf(connection),
      token: connection.deviceToken,
      handlers: {
        onFrame: (frame) => handleWatchFrame(watch, frame),
        onClosed: ({ code, reason }) => {
          watch.socket = null
          if (watch.released) return
          // Revoked over there: a decision, not a blip. The watch ends; the
          // reachability record says why, and a re-pair starts a new one.
          if (code === 4401) {
            const revoked = store.find(watch.connectionId)
            if (revoked) recordReachability(revoked, { reachable: false, unauthorized: true, detail: reason })
            stopWatch(watch.connectionId)
            return
          }
          scheduleWatchRetry(watch)
        },
      },
    })
    if (watch.released) {
      if (opened.ok) opened.value.close('Stopped watching.')
      return
    }
    if (!opened.ok) {
      if (opened.code === 'unauthorized') {
        recordReachability(connection, { reachable: false, unauthorized: true, detail: opened.message })
        stopWatch(watch.connectionId)
        return
      }
      scheduleWatchRetry(watch)
      return
    }
    watch.socket = opened.value
    watch.attempts = 0
    // It answered, so it is reachable — the same record a browse would land.
    if (!reachabilityFor(connection).reachable) {
      recordReachability(connection, { reachable: true, unauthorized: false, detail: null })
    }
  }

  function scheduleWatchRetry(watch: Watch): void {
    if (watch.released || watch.retryTimer) return
    const delayMs = backoffDelayMs(watch.attempts, { baseMs: RECONNECT_BASE_MS, maxMs: WATCH_RETRY_MAX_MS }) ?? WATCH_RETRY_MAX_MS
    watch.attempts += 1
    watch.retryTimer = setTimeout(() => {
      watch.retryTimer = null
      void dialWatch(watch)
    }, delayMs)
    watch.retryTimer.unref?.()
  }

  function handleWatchFrame(watch: Watch, frame: Record<string, unknown>): void {
    if (frame.type !== 'changed') return
    const what = frame.what === 'terminals' ? 'terminals' : frame.what === 'workspaces' ? 'workspaces' : null
    if (!what) return
    const connection = store.find(watch.connectionId)
    if (!connection) return
    broadcast({ kind: 'remote-changed', connectionId: connection.id, machineName: connection.machineName, what })
  }

  function start(): void {
    if (reachabilityTimer) return
    void checkAllReachability()
    for (const connection of store.list()) startWatch(connection.id)
    reachabilityTimer = setInterval(() => {
      // Nobody is looking: a row nobody can see does not need to be right.
      if (options.hasWindow && !options.hasWindow()) return
      void checkAllReachability()
    }, reachabilityIntervalMs)
    reachabilityTimer.unref?.()
  }

  function onWake(): void {
    void checkAllReachability()
    for (const attachment of attachments.values()) {
      if (attachment.released || attachment.socket) continue
      if (!attachment.retryTimer) continue
      // Dial now; the backoff was for a machine that had not changed, and
      // this one just did.
      clearTimeout(attachment.retryTimer)
      attachment.retryTimer = null
      void dial(attachment)
    }
    for (const watch of watches.values()) {
      if (watch.released || watch.socket || !watch.retryTimer) continue
      clearTimeout(watch.retryTimer)
      watch.retryTimer = null
      void dialWatch(watch)
    }
  }

  async function browse(connectionId: unknown): Promise<FleetBrowse> {
    const connection = connectionFor(connectionId)
    if (!connection) return unknownConnectionBrowse(connectionId)

    // Identity first: it is the cheapest authenticated call, so it separates
    // "asleep" from "revoked" before anything else is attempted, and it returns
    // the scopes as they are NOW rather than as they were at pairing.
    const identity = await readRemoteIdentity({ endpoint: endpointOf(connection), token: connection.deviceToken })
    if (!identity.ok) {
      recordReachability(connection, {
        reachable: false,
        unauthorized: identity.code === 'unauthorized',
        detail: identity.message,
      })
      return {
        connectionId: connection.id,
        reachable: false,
        unreachableReason: identity.message,
        unauthorized: identity.code === 'unauthorized',
        scopes: connection.scopes,
        terminalAccess: fleetTerminalAccess(connection.scopes),
        workspaces: [],
        terminals: [],
        gaps: [],
      }
    }
    store.updateScopes(connection.id, identity.value.scopes)
    store.markConnected(connection.id)
    rememberCapabilities(connection.id, identity.value.capabilities)
    recordReachability(connection, { reachable: true, unauthorized: false, detail: null })
    const scopes = identity.value.scopes

    const gaps: FleetGap[] = []
    const [workspaces, terminals] = await Promise.all([
      readWorkspaces(connection, scopes, gaps),
      readTerminals(connection, scopes, gaps),
    ])

    return {
      connectionId: connection.id,
      reachable: true,
      unreachableReason: null,
      unauthorized: false,
      scopes,
      terminalAccess: fleetTerminalAccess(scopes),
      workspaces,
      terminals,
      gaps,
    }
  }

  async function readWorkspaces(
    connection: StoredFleetConnection,
    scopes: TailnetScope[],
    gaps: FleetGap[]
  ): Promise<FleetWorkspace[]> {
    // Asked for only when the grant allows it. A refusal is a real answer and is
    // reported as one — an empty list would say "that machine has no
    // workspaces", which is a different and false statement.
    if (!scopes.some((scope) => scope.startsWith('workspace:'))) {
      gaps.push({
        part: 'workspaces',
        code: 'scope_required',
        message: 'This pairing may not read that machine\'s workspaces.',
      })
      return []
    }
    const answer = await callRemoteTool({
      endpoint: endpointOf(connection),
      token: connection.deviceToken,
      tool: 'workspace.list',
    })
    if (!answer.ok) {
      gaps.push({ part: 'workspaces', code: answer.code, message: answer.message })
      return []
    }
    const entries = Array.isArray(answer.value.workspaces) ? answer.value.workspaces : []
    return entries.flatMap((entry) => {
      const record = asRecord(entry)
      if (!record || typeof record.id !== 'string') return []
      const repository = asRecord(record.repository)
      return [
        {
          id: record.id,
          name: typeof record.name === 'string' ? record.name : record.id,
          mode: typeof record.mode === 'string' ? record.mode : null,
          folderPath: typeof record.folderPath === 'string' ? record.folderPath : null,
          repository:
            repository && typeof repository.canonicalKey === 'string' && repository.canonicalKey
              ? {
                  canonicalKey: repository.canonicalKey,
                  remoteUrl: typeof repository.remoteUrl === 'string' ? repository.remoteUrl : '',
                  name: typeof repository.name === 'string' ? repository.name : repository.canonicalKey,
                }
              : null,
        },
      ]
    })
  }

  async function readTerminals(
    connection: StoredFleetConnection,
    scopes: TailnetScope[],
    gaps: FleetGap[]
  ): Promise<FleetTerminal[]> {
    if (fleetTerminalAccess(scopes) === 'none') {
      gaps.push({
        part: 'terminals',
        code: 'scope_required',
        message: 'This pairing may not see that machine\'s terminals. Pair again with a terminal scope.',
      })
      return []
    }
    const answer = await callRemoteTool({
      endpoint: endpointOf(connection),
      token: connection.deviceToken,
      tool: 'terminal.list',
    })
    if (!answer.ok) {
      gaps.push({ part: 'terminals', code: answer.code, message: answer.message })
      return []
    }
    const entries = Array.isArray(answer.value.terminals) ? answer.value.terminals : []
    return entries.flatMap((entry) => {
      const record = asRecord(entry)
      if (!record || typeof record.sessionId !== 'string') return []
      const state = asRecord(record.agentState)
      return [
        {
          sessionId: record.sessionId,
          kind: record.kind === 'agent' ? 'agent' : 'terminal',
          workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : null,
          agentName: typeof record.agentName === 'string' ? record.agentName : null,
          cli: typeof record.cli === 'string' ? record.cli : null,
          cwd: typeof record.cwd === 'string' ? record.cwd : null,
          processAlive: record.processAlive === true,
          suspended: record.suspended === true,
          phase: typeof state?.phase === 'string' ? state.phase : null,
          phaseSince: typeof state?.since === 'number' && Number.isFinite(state.since) ? state.since : null,
          workspaceName: typeof record.workspaceName === 'string' ? record.workspaceName : null,
          git: terminalGitOf(record.git),
        },
      ]
    })
  }

  async function listRuns(
    connectionId: unknown,
    workspaceId: unknown
  ): Promise<{ ok: true; runs: FleetRun[] } | { ok: false; code: string; message: string }> {
    const connection = connectionFor(connectionId)
    if (!connection) return { ok: false, code: 'unknown_connection', message: 'That machine is not paired here.' }
    if (typeof workspaceId !== 'string' || !workspaceId) {
      return { ok: false, code: 'invalid_arguments', message: 'Name the workspace whose runs to list.' }
    }
    const answer = await callRemoteTool({
      endpoint: endpointOf(connection),
      token: connection.deviceToken,
      tool: 'sprint.list',
      args: { workspaceId },
    })
    if (!answer.ok) return { ok: false, code: answer.code, message: answer.message }
    const entries = Array.isArray(answer.value.runs) ? answer.value.runs : []
    return {
      ok: true,
      runs: entries.flatMap((entry) => {
        const record = asRecord(entry)
        if (!record || typeof record.slug !== 'string') return []
        return [{ slug: record.slug, statePath: typeof record.statePath === 'string' ? record.statePath : '' }]
      }),
    }
  }

  async function workspaceCheckout(connectionId: unknown, workspaceId: unknown): Promise<FleetWorkspaceCheckoutResult> {
    const connection = connectionFor(connectionId)
    if (!connection) return { ok: false, code: 'unknown_connection', message: 'That machine is not paired here.' }
    if (typeof workspaceId !== 'string' || !workspaceId) {
      return { ok: false, code: 'invalid_arguments', message: 'Name the workspace whose checkout to read.' }
    }
    const answer = await callRemoteTool({
      endpoint: endpointOf(connection),
      token: connection.deviceToken,
      tool: 'workspace.checkout',
      args: { workspaceId },
    })
    if (!answer.ok) return { ok: false, code: answer.code, message: answer.message }
    const branches = Array.isArray(answer.value.branches) ? answer.value.branches : []
    const worktrees = Array.isArray(answer.value.worktrees) ? answer.value.worktrees : []
    return {
      ok: true,
      checkout: {
        workspaceId,
        git: answer.value.git === true,
        branch: typeof answer.value.branch === 'string' ? answer.value.branch : null,
        defaultBranch: typeof answer.value.defaultBranch === 'string' ? answer.value.defaultBranch : null,
        branches: branches.flatMap((entry) => {
          const record = asRecord(entry)
          if (!record || typeof record.name !== 'string') return []
          return [{ name: record.name, current: record.current === true }]
        }),
        worktrees: worktrees.flatMap((entry) => {
          const record = asRecord(entry)
          if (!record || typeof record.path !== 'string') return []
          return [{ path: record.path, branch: typeof record.branch === 'string' ? record.branch : null, isMain: record.isMain === true }]
        }),
      },
    }
  }

  /** The checkout request as the wire carries it, or null for anything not that shape. */
  function checkoutRequestOf(value: unknown): FleetCheckoutRequest | null {
    const record = asRecord(value)
    if (!record) return null
    if (record.mode === 'current') return { mode: 'current' }
    if (record.mode === 'worktree') {
      return {
        mode: 'worktree',
        ...(typeof record.name === 'string' && record.name.trim() ? { name: record.name.trim() } : {}),
        ...(typeof record.baseRef === 'string' && record.baseRef.trim() ? { baseRef: record.baseRef.trim() } : {}),
      }
    }
    return null
  }

  async function createTerminal(input: {
    connectionId: unknown
    workspaceId?: unknown
    name?: unknown
    cli?: unknown
    prompt?: unknown
    cliModel?: unknown
    permissionPreset?: unknown
    checkout?: unknown
  }): Promise<FleetCreateTerminalResult> {
    const connection = connectionFor(input.connectionId)
    if (!connection) return { ok: false, code: 'unknown_connection', message: 'That machine is not paired here.' }
    const checkout: FleetCheckoutRequest = checkoutRequestOf(input.checkout) ?? { mode: 'current' }
    // Launch identity forwarded verbatim (remote-sessions-ux /
    // new-chat-on-a-remote-machine): the remote gateway validates every
    // field itself — including refusing `bypass` — and its refusal
    // surfaces to the caller word for word rather than being smoothed here.
    const identity = {
      ...(typeof input.workspaceId === 'string' && input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(typeof input.name === 'string' && input.name ? { name: input.name } : {}),
      ...(typeof input.cli === 'string' && input.cli ? { cli: input.cli } : {}),
      ...(typeof input.prompt === 'string' && input.prompt ? { prompt: input.prompt } : {}),
      ...(typeof input.cliModel === 'string' && input.cliModel ? { cliModel: input.cliModel } : {}),
      ...(typeof input.permissionPreset === 'string' && input.permissionPreset
        ? { permissionPreset: input.permissionPreset }
        : {}),
    }
    // Which tool answers is the checkout's choice, and it is what keeps the
    // scope model honest (checkout-and-branch-on-remote-create): the current
    // checkout is `terminal.create` (terminal:control — a shell in a folder
    // that already exists), a fresh worktree is `agent.launch` with its
    // worktree option (workspace:operate — the mutation that mints it, and
    // the one the audit records). Scope stays a function of the tool's name.
    if (checkout.mode === 'worktree') {
      if (!identity.workspaceId) {
        return { ok: false, code: 'invalid_arguments', message: 'A worktree launch needs the remote workspace id.' }
      }
      const answer = await callRemoteTool({
        endpoint: endpointOf(connection),
        token: connection.deviceToken,
        tool: 'agent.launch',
        args: {
          ...identity,
          worktree: {
            ...(checkout.name ? { name: checkout.name } : {}),
            ...(checkout.baseRef ? { baseRef: checkout.baseRef } : {}),
          },
        },
        timeoutMs: 60_000,
      })
      if (!answer.ok) return { ok: false, code: answer.code, message: answer.message }
      const agent = asRecord(answer.value.agent)
      const terminal = asRecord(agent?.terminal)
      const sessionId = typeof terminal?.sessionId === 'string' ? terminal.sessionId : ''
      if (!sessionId) {
        return {
          ok: false,
          code: 'unreadable_result',
          message: 'That machine started the agent but did not say which session it is, so it cannot be attached.',
        }
      }
      return {
        ok: true,
        sessionId,
        workspaceId: typeof agent?.workspaceId === 'string' ? agent.workspaceId : identity.workspaceId,
        agentId: typeof agent?.agentId === 'string' ? agent.agentId : '',
        title: typeof agent?.name === 'string' && agent.name ? agent.name : 'Terminal',
        checkout: {
          mode: 'worktree',
          branch: typeof answer.value.worktreeBranch === 'string' ? answer.value.worktreeBranch : null,
          worktreePath: typeof answer.value.worktreePath === 'string' ? answer.value.worktreePath : null,
        },
      }
    }
    const answer = await callRemoteTool({
      endpoint: endpointOf(connection),
      token: connection.deviceToken,
      tool: 'terminal.create',
      args: identity,
      // A launch waits on a real CLI starting on another machine; the default
      // read timeout would call a healthy slow start a failure.
      timeoutMs: 60_000,
    })
    if (!answer.ok) return { ok: false, code: answer.code, message: answer.message }
    const sessionId = typeof answer.value.sessionId === 'string' ? answer.value.sessionId : ''
    if (!sessionId) {
      return {
        ok: false,
        code: 'unreadable_result',
        message: 'That machine opened a terminal but did not say which session it is, so it cannot be attached.',
      }
    }
    const terminal = asRecord(answer.value.terminal)
    return {
      ok: true,
      sessionId,
      workspaceId: typeof answer.value.workspaceId === 'string' ? answer.value.workspaceId : '',
      agentId: typeof answer.value.agentId === 'string' ? answer.value.agentId : '',
      title: typeof terminal?.agentName === 'string' && terminal.agentName ? terminal.agentName : 'Terminal',
      // The current checkout's branch is not on this wire: the panel read it
      // through workspace.checkout before asking, and stamps it itself.
      checkout: { mode: 'current', branch: null, worktreePath: null },
    }
  }

  async function attachTerminal(input: {
    attachId: string
    connectionId: unknown
    sessionId: unknown
    emit: (event: FleetTerminalEvent) => void
  }): Promise<FleetAttachResult> {
    const connection = connectionFor(input.connectionId)
    if (!connection) return { ok: false, code: 'unknown_connection', message: 'That machine is not paired here.' }
    if (typeof input.sessionId !== 'string' || !input.sessionId) {
      return { ok: false, code: 'invalid_arguments', message: 'Name the terminal session to attach to.' }
    }
    // Re-attaching the same pane replaces the old attachment rather than
    // stacking a second socket on the same session id — silently: a remount
    // broadcasting `closed` for a session that is `connecting` again a
    // millisecond later would make chrome flicker.
    detachTerminal(input.attachId, { silent: true })

    // Every link-state transition — connecting, live, reconnecting, offline,
    // closed — flows through the pane's status frames, so mirroring them here
    // is the one interception that keeps the broadcast and the pane agreeing.
    const machineName = connection.machineName
    const sessionId = input.sessionId
    const emitAndBroadcast = (event: FleetTerminalEvent): void => {
      if (event.type === 'status') {
        attachment.state = event.state
        attachment.detail = event.detail
        broadcast({
          kind: 'attachment',
          attachId: input.attachId,
          connectionId: connection.id,
          machineName,
          sessionId,
          state: event.state,
          detail: event.detail,
        })
      }
      input.emit(event)
    }

    const attachment: Attachment = {
      attachId: input.attachId,
      connectionId: connection.id,
      sessionId: input.sessionId,
      emit: emitAndBroadcast,
      socket: null,
      released: false,
      attachedThisDial: false,
      refusalThisDial: null,
      attempts: 0,
      retryTimer: null,
      size: null,
      state: 'connecting',
      detail: `Connecting to ${machineName}.`,
    }
    attachments.set(input.attachId, attachment)
    void dial(attachment)
    return { ok: true }
  }

  /** One connect attempt, and the retry schedule when it does not stick. */
  async function dial(attachment: Attachment): Promise<void> {
    if (attachment.released) return
    const connection = store.find(attachment.connectionId)
    if (!connection) {
      finish(attachment, 'That machine is no longer paired here.')
      return
    }
    attachment.attachedThisDial = false
    attachment.refusalThisDial = null
    attachment.emit({
      type: 'status',
      state: attachment.attempts === 0 ? 'connecting' : 'reconnecting',
      detail:
        attachment.attempts === 0
          ? `Connecting to ${connection.machineName}.`
          : `Reconnecting to ${connection.machineName}.`,
    })

    const opened = await openRemoteTerminalSocket({
      endpoint: endpointOf(connection),
      token: connection.deviceToken,
      sessionId: attachment.sessionId,
      handlers: {
        onFrame: (frame) => handleFrame(attachment, frame),
        onClosed: ({ code, reason }) => {
          attachment.socket = null
          // A revoked device (4401) is a decision someone made, not a blip:
          // retrying would be a loop against a door that has been locked.
          if (code === 4401) {
            const revoked = store.find(attachment.connectionId)
            if (revoked) recordReachability(revoked, { reachable: false, unauthorized: true, detail: reason })
            finish(attachment, reason)
            return
          }
          // Neither is a socket the far end opened and then refused — an
          // attach for a session that does not exist there, say, which a
          // restored layout will ask for every time. It closes cleanly, so
          // without this it would look exactly like a network blip and retry
          // forever against something that will never be there.
          if (!attachment.attachedThisDial && attachment.refusalThisDial) {
            finish(attachment, attachment.refusalThisDial)
            return
          }
          scheduleRetry(attachment, reason)
        },
      },
    })

    if (attachment.released) {
      if (opened.ok) opened.value.close('The pane was closed.')
      return
    }
    if (!opened.ok) {
      // A refusal that will not change on retry is reported and ended; anything
      // that looks like a network is retried.
      if (opened.code === 'unauthorized' || opened.code.startsWith('terminal_')) {
        if (opened.code === 'unauthorized') {
          recordReachability(connection, { reachable: false, unauthorized: true, detail: opened.message })
        }
        attachment.emit({ type: 'error', code: opened.code, message: opened.message })
        finish(attachment, opened.message)
        return
      }
      scheduleRetry(attachment, opened.message)
      return
    }

    attachment.socket = opened.value
    attachment.attempts = 0
    store.markConnected(connection.id)
    if (!reachabilityFor(connection).reachable) {
      recordReachability(connection, { reachable: true, unauthorized: false, detail: null })
    }
    attachment.emit({ type: 'status', state: 'live', detail: `Connected to ${connection.machineName}.` })
    // The remote pty is sized for whichever pane attached last; re-sending this
    // pane's size after a reconnect is what stops a resumed session rendering to
    // a stale width.
    if (attachment.size) {
      opened.value.send({ type: 'resize', cols: attachment.size.cols, rows: attachment.size.rows })
    }
  }

  function handleFrame(attachment: Attachment, frame: Record<string, unknown>): void {
    if (attachment.released) return
    const type = frame.type
    if (type === 'replay' && typeof frame.data === 'string') {
      attachment.emit({ type: 'replay', data: frame.data, reason: frame.reason === 'resync' ? 'resync' : 'attach' })
      return
    }
    if (type === 'output' && typeof frame.data === 'string') {
      attachment.emit({ type: 'output', data: frame.data })
      return
    }
    if (type === 'attached') {
      attachment.attachedThisDial = true
      const session = asRecord(frame.session)
      const agentName = typeof session?.agentName === 'string' ? session.agentName : null
      attachment.emit({
        type: 'attached',
        sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : attachment.sessionId,
        // The SERVER's word on what this socket may do, which is the one that
        // governs; the stored scopes are only what we were told at pairing.
        access: frame.scope === 'control' ? 'control' : 'observe',
        title: agentName ?? 'Terminal',
      })
      return
    }
    if (type === 'exit') {
      attachment.emit({ type: 'exit', exitCode: typeof frame.exitCode === 'number' ? frame.exitCode : -1 })
      return
    }
    if (type === 'ended') {
      const reason = typeof frame.reason === 'string' ? frame.reason : 'The session ended on that machine.'
      attachment.emit({ type: 'ended', reason })
      // The session is gone on the other machine; a reconnect would attach to
      // nothing. End the attachment rather than looping.
      finish(attachment, reason)
      return
    }
    if (type === 'error') {
      const text = typeof frame.message === 'string' ? frame.message : 'That machine reported a terminal error.'
      // Remembered only until this dial attaches: an error AFTER the attach (a
      // watch-only socket's refused keystroke) is about one frame, not about
      // the connection, and must not end the pane.
      if (!attachment.attachedThisDial) attachment.refusalThisDial = text
      attachment.emit({
        type: 'error',
        code: typeof frame.code === 'string' ? frame.code : 'error',
        message: text,
      })
    }
  }

  function scheduleRetry(attachment: Attachment, reason: string): void {
    if (attachment.released || attachment.retryTimer) return
    const delayMs = backoffDelayMs(attachment.attempts, { baseMs: RECONNECT_BASE_MS, maxMs: RECONNECT_MAX_MS }) ?? RECONNECT_MAX_MS
    attachment.attempts += 1
    // A sleeping laptop is not an error. Past a few attempts the pane stops
    // promising an imminent reconnection and says plainly that the machine is
    // not answering — while still dialling, so a lid opening just works.
    attachment.emit(
      attachment.attempts > OFFLINE_AFTER_ATTEMPTS
        ? { type: 'status', state: 'offline', detail: reason }
        : { type: 'status', state: 'reconnecting', detail: reason }
    )
    attachment.retryTimer = setTimeout(() => {
      attachment.retryTimer = null
      void dial(attachment)
    }, delayMs)
  }

  /** End an attachment for good and tell the pane why. */
  function finish(attachment: Attachment, reason: string): void {
    if (attachment.released) return
    attachment.released = true
    if (attachment.retryTimer) clearTimeout(attachment.retryTimer)
    attachment.retryTimer = null
    attachment.socket?.close(reason)
    attachment.socket = null
    attachments.delete(attachment.attachId)
    attachment.emit({ type: 'status', state: 'closed', detail: reason })
  }

  function detachTerminal(attachId: unknown, replace?: { silent: boolean }): void {
    const attachment = typeof attachId === 'string' ? attachments.get(attachId) : undefined
    if (!attachment) return
    attachment.released = true
    if (attachment.retryTimer) clearTimeout(attachment.retryTimer)
    attachment.retryTimer = null
    attachment.socket?.close('The pane was closed.')
    attachment.socket = null
    attachments.delete(attachment.attachId)
    if (replace?.silent) return
    // A detach sends no status frame (the pane is already gone), so the
    // broadcast half is announced directly or chrome would count this
    // attachment as live forever.
    broadcast({
      kind: 'attachment',
      attachId: attachment.attachId,
      connectionId: attachment.connectionId,
      machineName: store.find(attachment.connectionId)?.machineName ?? attachment.connectionId,
      sessionId: attachment.sessionId,
      state: 'closed',
      detail: 'The pane was closed.',
    })
  }

  function getLiveState(): FleetLiveState {
    return {
      revision,
      attachments: [...attachments.values()].map((attachment) => ({
        attachId: attachment.attachId,
        connectionId: attachment.connectionId,
        machineName: store.find(attachment.connectionId)?.machineName ?? attachment.connectionId,
        sessionId: attachment.sessionId,
        state: attachment.state,
        detail: attachment.detail,
      })),
      requests: [...outboundRequests.values()].map((request) => ({ ...request.view })),
      reachability: [...reachability.values()].map((entry) => ({ ...entry })),
    }
  }

  /**
   * Drop this machine's credential for one peer, and everything hanging off it.
   *
   * Shared by `forget` and the outbound half of `forgetMachine` so the two can
   * never diverge on what forgetting entails: the reachability record, the live
   * panes (which have no credential left to reconnect with), the watch, the
   * stored token, and the broadcast that tells every window.
   */
  function forgetConnection(connectionId: string): { id: string; machineName: string } | null {
    const forgotten = store.find(connectionId)
    reachability.delete(connectionId)
    peerCapabilities.delete(connectionId)
    for (const attachment of [...attachments.values()]) {
      if (attachment.connectionId === connectionId) finish(attachment, 'This machine was removed from your fleet.')
    }
    stopWatch(connectionId)
    store.forget(connectionId)
    if (forgotten) broadcast({ kind: 'machine-forgotten', connectionId, machineName: forgotten.machineName })
    // Never the stored record itself: it carries the device token, and nothing
    // above this line is allowed to hold one.
    return forgotten ? { id: forgotten.id, machineName: forgotten.machineName } : null
  }

  return {
    start,
    onWake,
    async checkReachability(connectionId): Promise<FleetLiveState> {
      if (typeof connectionId === 'string') {
        const connection = store.find(connectionId)
        if (connection) await probeReachability(connection)
      } else await checkAllReachability()
      return getLiveState()
    },
    listConnections: () => store.list(),
    pair,
    requestPairing,
    collectPairing,
    cancelPairing,
    adoptReverseGrant,
    forgetMachine(input): FleetForgetMachineResult {
      const deviceId = typeof input.deviceId === 'string' && input.deviceId ? input.deviceId : null
      const connectionId = typeof input.connectionId === 'string' && input.connectionId ? input.connectionId : null
      // Inbound first. The outbound forget below tears down live attachments,
      // and doing it in this order means a machine cannot slip a request in
      // through the door we are about to stop watching.
      let revokedDeviceId: string | null = null
      if (deviceId) {
        try {
          revokedDeviceId = options.revokeInboundDevice?.(deviceId) === true ? deviceId : null
        } catch (error) {
          // The outbound half is still worth ending: half a pairing removed is
          // better than none, and the caller sees which half by the nulls.
          options.log?.(`Could not revoke device ${deviceId}: ${message(error)}`)
        }
      }
      const forgotten = connectionId ? forgetConnection(connectionId) : null
      return {
        connections: store.list(),
        revokedDeviceId,
        forgottenConnectionId: forgotten ? forgotten.id : null,
      }
    },

    forget(connectionId): FleetConnection[] {
      if (typeof connectionId === 'string') forgetConnection(connectionId)
      return store.list()
    },
    browse,
    listRuns,
    createTerminal,
    workspaceCheckout,
    attachTerminal,

    sendInput(attachId, data): void {
      const attachment = typeof attachId === 'string' ? attachments.get(attachId) : undefined
      if (!attachment || typeof data !== 'string' || !data) return
      // Dropped while disconnected rather than queued: keystrokes typed at a
      // dead link belong to a screen state that no longer exists, and replaying
      // them into a session on reconnect would run commands nobody re-read.
      attachment.socket?.send({ type: 'input', data })
    },

    resizeTerminal(attachId, cols, rows): void {
      const attachment = typeof attachId === 'string' ? attachments.get(attachId) : undefined
      if (!attachment || !isPositiveInteger(cols) || !isPositiveInteger(rows)) return
      attachment.size = { cols, rows }
      attachment.socket?.send({ type: 'resize', cols, rows })
    },

    detachTerminal,

    getLiveState,

    shutdown(): void {
      for (const attachment of [...attachments.values()]) detachTerminal(attachment.attachId)
      for (const connectionId of [...watches.keys()]) stopWatch(connectionId)
      if (reachabilityTimer) clearInterval(reachabilityTimer)
      reachabilityTimer = null
      for (const request of [...outboundRequests.values()]) {
        // The process is going; the far end's copy lapses on its own. The
        // reverse device stays revocable by name, so it is left alone.
        if (request.timer) clearTimeout(request.timer)
        request.timer = null
      }
      outboundRequests.clear()
    },
  }
}

function unknownConnectionBrowse(connectionId: unknown): FleetBrowse {
  return {
    connectionId: typeof connectionId === 'string' ? connectionId : '',
    reachable: false,
    unreachableReason: 'That machine is not paired here.',
    unauthorized: false,
    scopes: [],
    terminalAccess: 'none',
    workspaces: [],
    terminals: [],
    gaps: [],
  }
}

function endpointOf(connection: StoredFleetConnection): { host: string; port: number } {
  const parsed = parseTailnetEndpoint(connection.endpoint)
  // Unreadable endpoints never reach the store (the reader drops them), so this
  // is the type system's ask rather than a real branch.
  return parsed ?? { host: connection.endpoint, port: 0 }
}

function defaultDeviceName(): string {
  try {
    return hostname().trim()
  } catch {
    return ''
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The checkout summary `terminal.list` rides beside a session
 * (remote-band-in-the-sidebar). Absent or malformed is null — the row then
 * shows no branch — never a zero that claims a measurement.
 */
function terminalGitOf(value: unknown): FleetTerminal['git'] {
  if (!value || typeof value !== 'object') return null
  const git = value as Record<string, unknown>
  const count = (field: unknown): number => (typeof field === 'number' && Number.isFinite(field) ? field : 0)
  return {
    branch: typeof git.branch === 'string' ? git.branch : null,
    additions: count(git.additions),
    deletions: count(git.deletions),
    changedFiles: count(git.changedFiles),
    scope: git.scope === 'worktree' || git.scope === 'branch' ? git.scope : 'folder',
  }
}
