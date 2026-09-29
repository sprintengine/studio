import { randomBytes } from 'crypto'

import { hashSecret } from './secret-hash'
import { hostname } from 'os'

import { backoffDelayMs } from '../../../shared/exponentialBackoff'
import {
  normalizeTailnetScopes,
  type TailnetDevice,
  type TailnetReverseGrant,
  type TailnetScope,
} from '../../../shared/tailnet'
import {
  type MeshBrowse,
  type MeshConnection,
  type MeshEvent,
  type MeshLiveState,
  type MeshMachineReachability,
  type MeshPairRequestPhase,
  type MeshCreateConversationResult,
  type MeshGap,
  type MeshPairResult,
  type MeshWorkspace,
  type MeshCollectPairingResult,
  type MeshPairRequestView,
  type MeshRequestPairingResult,
  type MeshForgetMachineResult,
  type MeshWorkspaceCheckoutResult,
  type MeshConversationCommandResult,
  type MeshConversationFrame,
  type MeshConversationImageResult,
  type MeshConversationListResult,
} from '../../../shared/tailnet-mesh'
import type {
  ConversationPageResult,
  ConversationToolDetailResult,
  ConversationTurnDiffResult,
} from '../../../shared/conversation-runtime'
import { createRemoteConversationCache } from './tailnet-remote-conversation-cache'
import {
  createRemoteConversations,
  meshConversationKeyOf,
  type RemoteConversationsOptions,
} from './tailnet-remote-conversations'
import { createTailnetMeshStore, type StoredMeshConnection, type TailnetMeshStore } from './tailnet-mesh-store'
import { tailnetPeerSupports } from './tailnet-routes'
import {
  callRemoteTool,
  fetchRemoteConversationImage,
  formatTailnetEndpoint,
  openRemoteEventsSocket,
  collectPairingFromMachine,
  pairWithMachine,
  parsePairingUrl,
  requestPairingFromMachine,
  type TailnetEndpoint,
  parseTailnetEndpoint,
  readRemoteIdentity,
  type RemoteJsonSocket,
} from './tailnet-remote-client'
import { asRecord } from '../../../shared/records'
import { powerActivity, type PowerActivity } from '../../power-activity'

// The Mesh: this Studio driving other machines.
//
// Everything a window needs to work "on the Mini from the laptop" — the paired
// machines, what they hold, and the conversations running on them — with the
// tokens and the sockets kept in main. A window sends commands and receives
// frames; it never holds a credential and never opens a connection.

/** A change-feed watch re-dials fast at first (a Wi-Fi blip), then backs off. */
const WATCH_RETRY_BASE_MS = 500
/** A watch on a machine that is away re-dials this slowly at most; the reachability probe is the other beat. */
const WATCH_RETRY_MAX_MS = 60_000
/**
 * A watch that has failed this many dials in a row stops dialling and waits
 * for the machine to come back (see "Machines that stopped answering").
 */
const WATCH_AWAY_AFTER_ATTEMPTS = 4
/**
 * How often a machine that stopped answering is asked again while someone can
 * see a window: one small identity read, which, when it answers, re-dials
 * every watch and followed conversation parked on that machine.
 */
const AWAY_RECHECK_BASE_MS = 15_000
const AWAY_RECHECK_MAX_MS = 60_000
/** The person coming back to the app asks a machine that stopped answering at most this often. */
const AWAY_FOCUS_RECHECK_MIN_MS = 10_000
/** Every wait between dials to an absent machine is this many times longer on battery. */
const BATTERY_STRETCH = 4
/**
 * The kinds of change a machine's feed reports that this one reads. Anything
 * else — the `terminals` an older build still announces — names a list this
 * machine no longer reads.
 */
const CHANGE_KINDS = ['workspaces', 'conversations'] as const
type ChangeKind = (typeof CHANGE_KINDS)[number]

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

export type TailnetMeshService = {
  /**
   * Begin the reachability supervisor (phase 4): one check of every paired
   * machine now, and one per interval from here on. Idempotent.
   */
  start(): void
  /**
   * The machine woke, or came back on a network (phase 4): check every
   * paired machine now, and re-dial every watch and followed conversation
   * that was waiting out a backoff — a lid opening should reconnect at once,
   * not in a minute.
   */
  onWake(): void
  /**
   * Check whether one paired machine (or every one) answers right now, and
   * report the state after. The row's Retry.
   */
  checkReachability(connectionId?: unknown): Promise<MeshLiveState>
  listConnections(): MeshConnection[]
  pair(input: { pairingUrl: unknown; deviceName?: unknown }): Promise<MeshPairResult>
  /**
   * Ask a machine to pair and wait for someone there to approve it.
   *
   * The outward half stays main's for the same reason `pair` does: the listener
   * refuses any request carrying an `Origin` header, so a window physically
   * cannot dial a peer. The collect secret lives here and is never handed to a
   * renderer. Main also owns the WAIT (phase 3): the poll runs here until the
   * request is answered, lapses, or is cancelled, and every phase is broadcast
   * as a `pair-request` mesh event.
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
     * default (every scope, `TAILNET_SCOPES`) in force.
     */
    scopes?: unknown
    reverseScopes?: unknown
  }): Promise<MeshRequestPairingResult>
  /**
   * Poll one request we made, now, and report. The timer polls on its own;
   * this is the one-off a surface may ask for. Lands the connection when
   * the request has been approved.
   */
  collectPairing(requestId: unknown): Promise<MeshCollectPairingResult>
  /** Forget a request we made. The far end's copy lapses on its own; a reverse device minted for it is revoked. */
  cancelPairing(requestId: unknown): void
  /**
   * Adopt the reverse half of a both-ways pairing another machine offered
   * when it asked to drive THIS one (phase 6): the gateway has verified the
   * grant's endpoint is the asker's own address, and a person here approved
   * the request it rode in on. Stored as a machine this Studio can drive.
   */
  adoptReverseGrant(input: {
    grant: TailnetReverseGrant
    askerName: string
    peerNode: string | null
  }): MeshConnection | null
  forget(connectionId: unknown): MeshConnection[]
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
  forgetMachine(input: { deviceId?: unknown; connectionId?: unknown }): MeshForgetMachineResult
  browse(connectionId: unknown): Promise<MeshBrowse>
  /**
   * Start a chat agent in a remote workspace (`conversation:operate`). The
   * chat runs there, in that machine's conversation runtime; a pane here
   * follows it over the conversation stream by the ids this returns.
   */
  createConversation(input: {
    connectionId: unknown
    workspaceId?: unknown
    cli?: unknown
    prompt?: unknown
    cliModel?: unknown
    permissionPreset?: unknown
  }): Promise<MeshCreateConversationResult>
  /**
   * One remote workspace's checkout facts — branch, trunk, branches,
   * worktrees — over `workspace.checkout` (workspace:read). A pairing that
   * may not read them gets the refusal as its answer, never an empty list
   * dressed as "no branches".
   */
  workspaceCheckout(connectionId: unknown, workspaceId: unknown): Promise<MeshWorkspaceCheckoutResult>
  /**
   * The requests still waiting and each machine's last reachability answer,
   * stamped with the same revision the events carry — the initial read behind
   * `onEvent`, so a window that mounts mid-wait is not stuck on "paired".
   */
  getLiveState(): MeshLiveState
  /**
   * The conversations a paired machine holds, over its conversation socket.
   * The identity read comes first, as for a browse, so the access reported is
   * the grant as it stands now.
   */
  listConversations(connectionId: unknown): Promise<MeshConversationListResult>
  /**
   * Follow one conversation on a paired machine. `emit` receives the kept
   * copy at once (when there is one), then the link state and live frames,
   * until `unfollowConversation`. Windows showing the same conversation
   * share one socket.
   */
  followConversation(input: {
    followId: string
    key: unknown
    turnLimit?: unknown
    emit: (frame: MeshConversationFrame) => void
  }): Promise<{ ok: true } | { ok: false; code: string; message: string }>
  unfollowConversation(followId: unknown): void
  conversationLoadEarlier(input: {
    key: unknown
    beforeCursor: unknown
    turnLimit?: unknown
  }): Promise<ConversationPageResult>
  conversationCommand(input: { key: unknown; command: unknown }): Promise<MeshConversationCommandResult>
  conversationToolDetail(input: { key: unknown; toolUseId: unknown }): Promise<ConversationToolDetailResult>
  conversationTurnDiff(input: { key: unknown; turnSeq: unknown; path?: unknown }): Promise<ConversationTurnDiffResult>
  /**
   * The picture one step of a followed conversation made or looked at, fetched
   * from the machine it runs on. Refused without asking for a machine whose
   * last handshake did not name `conversation-images`.
   */
  conversationToolImage(input: { key: unknown; toolUseId: unknown }): Promise<MeshConversationImageResult>
  shutdown(): void
}

export type TailnetMeshServiceOptions = {
  resolveUserDataDir: () => string
  /** This machine's name, as the other end will list the pairing. */
  resolveDeviceName?: () => string
  /** Tailscale node name for an address, so a machine is listed by name rather than by IP. */
  resolvePeerName?: (address: string) => Promise<string | null>
  /**
   * Whole-app mesh lifecycle for the live-state push (remote-sessions-ux):
   * a machine paired or forgotten, answering or not, a request's wait moving
   * on. These are the facts chrome in every window may show. Payloads never
   * carry a credential — connections cross this boundary as the store's
   * public view.
   */
  onEvent?: (event: MeshEvent) => void
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
  /**
   * Whether a window someone could be looking at is open: the reachability
   * timer, and the re-checks of a machine that stopped answering, only run
   * while one is. Defaults to always.
   */
  hasWindow?: () => boolean
  /** Focus, lock and battery, for the loops above; the process-wide instance unless a test passes its own. */
  activity?: Pick<PowerActivity, 'isOnBattery' | 'isScreenLocked' | 'onFocusChange'>
  /** Injected in tests, which cannot wait minutes. */
  pairPollMs?: number
  reachabilityIntervalMs?: number
  reachabilityTimeoutMs?: number
  createStore?: (options: { resolveUserDataDir: () => string; log?: (message: string) => void }) => TailnetMeshStore
  /** Timing for followed conversations; tests shorten it. */
  conversations?: Pick<
    RemoteConversationsOptions,
    'retry' | 'requestTimeoutMs' | 'commandTimeoutMs' | 'listTimeoutMs' | 'livenessTimeoutMs' | 'saveDelayMs'
  >
  log?: (message: string) => void
}

/** A mesh event before the service stamps its revision — distributed over the union, member by member. */
type MeshEventBody = MeshEvent extends infer E ? (E extends MeshEvent ? Omit<E, 'revision'> : never) : never

export function createTailnetMeshService(options: TailnetMeshServiceOptions): TailnetMeshService {
  const store = (options.createStore ?? createTailnetMeshStore)({
    resolveUserDataDir: options.resolveUserDataDir,
    log: options.log,
  })
  const deviceName = () => (options.resolveDeviceName ?? defaultDeviceName)()
  const pairPollMs = Math.max(50, options.pairPollMs ?? DEFAULT_PAIR_POLL_MS)
  const reachabilityIntervalMs = Math.max(50, options.reachabilityIntervalMs ?? DEFAULT_REACHABILITY_INTERVAL_MS)
  const reachabilityTimeoutMs = Math.max(50, options.reachabilityTimeoutMs ?? DEFAULT_REACHABILITY_TIMEOUT_MS)
  const activity = options.activity ?? powerActivity
  const stretch = (): number => (activity.isOnBattery() ? BATTERY_STRETCH : 1)
  /** Someone could be looking: a window is up and the screen is not locked. */
  const someoneLooking = (): boolean => (options.hasWindow?.() ?? true) && !activity.isScreenLocked()
  // Stamped on every broadcast and every snapshot; only ever goes up, so a
  // subscriber can order a late initial read against events already applied.
  let revision = 0
  const broadcast = (event: MeshEventBody): void => {
    revision += 1
    options.onEvent?.({ ...event, revision })
  }

  // Conversations followed on paired machines, with their copy kept on disk so
  // a restart resumes rather than replays. Every answer (or refusal) on their
  // sockets feeds the machine's reachability record.
  const remoteConversations = createRemoteConversations({
    ...options.conversations,
    cache: createRemoteConversationCache({ resolveUserDataDir: options.resolveUserDataDir, log: options.log }),
    resolveConnection: (connectionId) => {
      const stored = store.find(connectionId)
      return stored
        ? {
            id: stored.id,
            machineName: stored.machineName,
            endpoint: endpointOf(stored),
            token: stored.deviceToken,
            scopes: stored.scopes,
          }
        : null
    },
    onUnauthorized: (connectionId, detail) => {
      const connection = store.find(connectionId)
      if (connection) recordReachability(connection, { reachable: false, unauthorized: true, detail })
    },
    onReachable: (connectionId) => {
      const connection = store.find(connectionId)
      if (!connection) return
      store.markConnected(connection.id)
      if (!reachabilityFor(connection).reachable)
        recordReachability(connection, { reachable: true, unauthorized: false, detail: null })
      machineBack(connection.id)
    },
    onAway: (connectionId) => noteMachineAway(connectionId),
    isOnBattery: () => activity.isOnBattery(),
    log: options.log,
  })

  function connectionFor(connectionId: unknown): StoredMeshConnection | null {
    return typeof connectionId === 'string' ? store.find(connectionId) : null
  }

  async function pair(input: { pairingUrl: unknown; deviceName?: unknown }): Promise<MeshPairResult> {
    const raw = typeof input.pairingUrl === 'string' ? input.pairingUrl : ''
    const parsed = parsePairingUrl(raw)
    if (!parsed) {
      return {
        ok: false,
        code: 'invalid_pairing_link',
        message: "That is not a pairing link. Copy the whole link from the other machine's Settings → Remote.",
      }
    }
    const name =
      typeof input.deviceName === 'string' && input.deviceName.trim() ? input.deviceName.trim() : deviceName()
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
      syncReachabilityTimer()
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
          `Paired with ${formatTailnetEndpoint(parsed.endpoint)}, but the credential could not be saved here ` +
          `(${message(error)}). Revoke this device on that machine and pair again.`,
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
    view: MeshPairRequestView
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
  const settledRequests = new Map<string, MeshCollectPairingResult>()

  function announceRequest(
    request: OutboundRequest,
    phase: MeshPairRequestPhase,
    extra: { connection?: MeshConnection; detail?: string } = {},
  ): void {
    broadcast({ kind: 'pair-request', phase, request: { ...request.view }, ...extra })
  }

  /** End a request here: stop its timer, take back its reverse device, and drop it. */
  function endRequest(request: OutboundRequest, keepReverse: boolean, settled?: MeshCollectPairingResult): void {
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
      let connection: MeshConnection
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
          `${request.view.machineName} approved the request, but the credential could not be saved here ` +
          `(${message(error)}). Revoke this device on that machine and ask again.`
        endRequest(request, true, { ok: false, code: 'pairing_not_saved', message: detail })
        announceRequest(request, 'failed', { detail })
        return
      }
      endRequest(request, true, { ok: true, status: 'approved', connection })
      broadcast({ kind: 'machine-paired', connection })
      syncReachabilityTimer()
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
  }): Promise<MeshRequestPairingResult> {
    const endpoint = parseTailnetEndpoint(typeof input.endpoint === 'string' ? input.endpoint : '')
    if (!endpoint) {
      return { ok: false, code: 'invalid_endpoint', message: 'That is not a machine address this can dial.' }
    }
    const name =
      typeof input.deviceName === 'string' && input.deviceName.trim() ? input.deviceName.trim() : deviceName()
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
          message:
            'Turn on Remote here first, or ask without letting that machine drive this one. A grant to a listener that is not running would point at nothing.',
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

    const view: MeshPairRequestView = {
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

  async function collectPairing(requestId: unknown): Promise<MeshCollectPairingResult> {
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
  }): MeshConnection | null {
    const { grant } = input
    // The same machine twice is two real records over there, exactly as a
    // second carried-code pairing is — but a reverse grant arrives without
    // anyone here pressing anything, so a duplicate for an endpoint already
    // paired replaces the old credential rather than stacking a row nobody
    // asked for. The old device over there is named in the log for revoking.
    const existing = store.list().find((entry) => entry.endpoint === grant.endpoint && entry.pairedVia === 'reverse')
    if (existing) {
      options.log?.(
        `Replacing the reverse pairing for ${grant.endpoint}: device "${existing.deviceName}" there is now unused; revoke it in that machine's Remote settings.`,
      )
      store.forget(existing.id)
    }
    let connection: MeshConnection
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
    syncReachabilityTimer()
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
  const reachability = new Map<string, MeshMachineReachability>()
  const probes = new Map<string, Promise<void>>()
  let reachabilityTimer: ReturnType<typeof setInterval> | null = null
  /** `start` was called: the supervisor runs, and the change feed is watched. */
  let supervising = false

  function reachabilityFor(connection: MeshConnection): MeshMachineReachability {
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
    connection: MeshConnection,
    answer: { reachable: boolean; unauthorized: boolean; detail: string | null },
  ): void {
    const previous = reachabilityFor(connection)
    const now = Date.now()
    const next: MeshMachineReachability = {
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
    // Whatever answered, the machine is back: whatever was parked waiting for
    // it dials now rather than at the next re-check.
    if (answer.reachable) resumeMachine(connection.id)
  }

  function probeReachability(connection: MeshConnection): Promise<void> {
    const inFlight = probes.get(connection.id)
    if (inFlight) return inFlight
    const checking: MeshMachineReachability = { ...reachabilityFor(connection), checking: true }
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
  // workspace list or conversation list changed. Held for as long as the machine
  // is paired — a watch is a listener, not a browse, and costs nothing while
  // nothing changes — re-dialled with backoff when the machine is away. The
  // Remote band re-reads on the event it produces, which is what let its
  // 30-second timer go: on a machine holding many sessions every one of
  // those timed reads was seconds of the other machine's main thread.
  type Watch = {
    connectionId: string
    socket: RemoteJsonSocket | null
    retryTimer: ReturnType<typeof setTimeout> | null
    attempts: number
    released: boolean
    /** Between a dial's ticket and its socket; a second dial then would orphan a socket. */
    dialing: boolean
    /** Stopped dialling after failing long enough; waits for the machine to come back. */
    parked: boolean
    /**
     * The revision of each kind of change as the far end last reported it,
     * or null before the first `hello`. A reconnect whose `hello` names a
     * different one missed that change and says so, as a push would have.
     */
    revisions: Partial<Record<ChangeKind, number>> | null
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
    else if (!watched && supported && supervising) startWatch(connectionId)
  }

  function startWatch(connectionId: string): void {
    if (watches.has(connectionId)) return
    const watch: Watch = {
      connectionId,
      socket: null,
      retryTimer: null,
      attempts: 0,
      released: false,
      dialing: false,
      parked: false,
      revisions: null,
    }
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
    if (watch.released || watch.dialing || watch.socket?.isOpen()) return
    watch.parked = false
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
    let socket: RemoteJsonSocket | null = null
    watch.dialing = true
    let opened: Awaited<ReturnType<typeof openRemoteEventsSocket>>
    try {
      opened = await openRemoteEventsSocket({
        endpoint: endpointOf(connection),
        token: connection.deviceToken,
        handlers: {
          // The first frame (`hello`) can arrive with the handshake, before the
          // socket is handed back, so frames are judged by the watch alone.
          onFrame: (frame) => {
            if (!watch.released && (!socket || watch.socket === socket)) handleWatchFrame(watch, frame)
          },
          onClosed: ({ code, reason }) => {
            // A socket this watch already let go of (recycled on a wake) is not news.
            if (!socket || watch.socket !== socket) return
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
    } finally {
      watch.dialing = false
    }
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
    socket = opened.value
    if (!socket.isOpen()) {
      // Closed before it was handed back (its first bytes carried the close):
      // a failed dial, not an open watch.
      scheduleWatchRetry(watch)
      return
    }
    watch.socket = socket
    watch.attempts = 0
    // It answered, so it is reachable — the same record a browse would land.
    if (!reachabilityFor(connection).reachable) {
      recordReachability(connection, { reachable: true, unauthorized: false, detail: null })
    }
    machineBack(connection.id)
  }

  function scheduleWatchRetry(watch: Watch): void {
    if (watch.released || watch.retryTimer || watch.parked) return
    if (watch.attempts >= WATCH_AWAY_AFTER_ATTEMPTS) {
      // Away: stop dialling on a timer of its own. It used to re-dial every
      // minute for as long as the machine was paired — from a tray with no
      // window, on battery, all night. The machine's re-check (or a wake, or
      // any other answer from it) brings the watch back.
      watch.parked = true
      noteMachineAway(watch.connectionId)
      return
    }
    const maxMs = WATCH_RETRY_MAX_MS * stretch()
    const delayMs = backoffDelayMs(watch.attempts, { baseMs: WATCH_RETRY_BASE_MS, maxMs }) ?? maxMs
    watch.attempts += 1
    watch.retryTimer = setTimeout(() => {
      watch.retryTimer = null
      void dialWatch(watch)
    }, delayMs)
    watch.retryTimer.unref?.()
  }

  function handleWatchFrame(watch: Watch, frame: Record<string, unknown>): void {
    const connection = store.find(watch.connectionId)
    if (!connection) return
    const changed = (what: ChangeKind): void => {
      broadcast({ kind: 'remote-changed', connectionId: connection.id, machineName: connection.machineName, what })
    }
    if (frame.type === 'hello') {
      // Where the far end stands. On a reconnect, a kind whose revision moved
      // changed while this watch was away — asleep, parked, recycled — and is
      // reported as the push it missed would have been.
      const revisions = asRecord(frame.revisions)
      if (!revisions) return
      const previous = watch.revisions
      const next: Partial<Record<ChangeKind, number>> = {}
      for (const what of CHANGE_KINDS) {
        const revision = revisions[what]
        if (typeof revision !== 'number') continue
        next[what] = revision
        if (previous && previous[what] !== revision) changed(what)
      }
      watch.revisions = next
      return
    }
    if (frame.type !== 'changed') return
    const what = CHANGE_KINDS.find((kind) => kind === frame.what)
    if (!what) return
    if (watch.revisions && typeof frame.revision === 'number') watch.revisions[what] = frame.revision
    changed(what)
  }

  // ── Machines that stopped answering ───────────────────────────────────────
  //
  // A followed conversation and a change-feed watch each used to re-dial a
  // sleeping machine on their own backoff, forever: a ticket request and a
  // link frame every fifteen seconds per open pane, and a dial a minute per
  // paired machine, with or without a window. Now each gives up after a few
  // quick tries and parks, and the machine is asked again by one small
  // identity read, only while someone could be looking, backing off to a
  // minute (four on battery). Anything that shows the machine is back — that
  // read, a browse, a list, a wake, the person returning to the app — dials
  // everything parked on it at once.
  type AwayMachine = { attempts: number; timer: ReturnType<typeof setTimeout> | null; lastCheckAt: number }
  const awayMachines = new Map<string, AwayMachine>()

  function noteMachineAway(connectionId: string): void {
    if (!store.find(connectionId)) return
    let away = awayMachines.get(connectionId)
    if (!away) {
      away = { attempts: 0, timer: null, lastCheckAt: 0 }
      awayMachines.set(connectionId, away)
    }
    armAwayRecheck(connectionId, away)
  }

  function armAwayRecheck(connectionId: string, away: AwayMachine): void {
    // Nobody can see a window: nothing is re-checked until someone can (the
    // focus listener below) or the machine wakes.
    if (away.timer || !someoneLooking()) return
    const delayMs =
      (backoffDelayMs(away.attempts, { baseMs: AWAY_RECHECK_BASE_MS, maxMs: AWAY_RECHECK_MAX_MS }) ??
        AWAY_RECHECK_MAX_MS) * stretch()
    away.timer = setTimeout(() => {
      away.timer = null
      if (awayMachines.get(connectionId) !== away) return
      away.attempts += 1
      void recheckAway(connectionId, away)
    }, delayMs)
    away.timer.unref?.()
  }

  async function recheckAway(connectionId: string, away: AwayMachine): Promise<void> {
    const connection = store.find(connectionId)
    if (!connection) {
      awayMachines.delete(connectionId)
      return
    }
    // Nothing is waiting on it any more (the pane closed, the watch ended):
    // there is no one to tell, so no one to ask for.
    if (!remoteConversations.parkedOn(connectionId) && watches.get(connectionId)?.parked !== true) {
      forgetAway(connectionId)
      return
    }
    if (!someoneLooking()) return
    away.lastCheckAt = Date.now()
    // An answer resumes everything parked on the machine, through
    // `recordReachability`; no answer leaves it parked for the next re-check.
    await probeReachability(connection)
    if (awayMachines.get(connectionId) === away) armAwayRecheck(connectionId, away)
  }

  /**
   * The machine answered a dial of ours. Its re-check stops, and whatever
   * else is still parked on it dials now: the reachability record may already
   * have said "reachable", so `recordReachability` would not have resumed it.
   */
  function machineBack(connectionId: string): void {
    forgetAway(connectionId)
    resumeMachine(connectionId)
  }

  /** Dial everything parked on one machine, now. */
  function resumeMachine(connectionId: string): void {
    remoteConversations.resume(connectionId)
    const watch = watches.get(connectionId)
    if (watch?.parked) void dialWatch(watch)
  }

  function forgetAway(connectionId: string): void {
    const away = awayMachines.get(connectionId)
    if (away?.timer) clearTimeout(away.timer)
    awayMachines.delete(connectionId)
  }

  // Coming back to the app is when a stale "not answering" is noticed: ask
  // each absent machine once, and re-arm the re-checks a hidden window held.
  const releaseFocus = activity.onFocusChange((focused) => {
    if (!focused) return
    for (const [connectionId, away] of awayMachines) {
      if (Date.now() - away.lastCheckAt < AWAY_FOCUS_RECHECK_MIN_MS) {
        armAwayRecheck(connectionId, away)
        continue
      }
      if (away.timer) clearTimeout(away.timer)
      away.timer = null
      void recheckAway(connectionId, away)
    }
  })

  // ── The supervisor ────────────────────────────────────────────────────────

  /** The five-minute check runs only while there is a machine to check. */
  function syncReachabilityTimer(): void {
    const wanted = supervising && store.list().length > 0
    if (wanted && !reachabilityTimer) {
      reachabilityTimer = setInterval(() => {
        // Nobody is looking: a row nobody can see does not need to be right.
        if (!someoneLooking()) return
        void checkAllReachability()
      }, reachabilityIntervalMs)
      reachabilityTimer.unref?.()
    } else if (!wanted && reachabilityTimer) {
      clearInterval(reachabilityTimer)
      reachabilityTimer = null
    }
  }

  function start(): void {
    if (supervising) return
    supervising = true
    void checkAllReachability()
    for (const connection of store.list()) startWatch(connection.id)
    syncReachabilityTimer()
  }

  function onWake(): void {
    void checkAllReachability()
    remoteConversations.onWake()
    for (const away of awayMachines.values()) {
      // A new network, perhaps: the re-checks start again from the quick end.
      away.attempts = 0
      if (away.timer) clearTimeout(away.timer)
      away.timer = null
    }
    for (const watch of watches.values()) {
      if (watch.released || watch.dialing) continue
      if (watch.socket) {
        // A watch that looks open across a sleep may be talking to nobody:
        // the far end, or a middlebox, dropped it while this machine could
        // not hear, and nothing flows on it until something changes, so
        // nothing would ever say so. One cheap dial per machine, only on a
        // wake; its `hello` reports whatever changed meanwhile.
        const stale = watch.socket
        watch.socket = null
        stale.close('Reconnecting after a wake.')
      }
      if (watch.retryTimer) clearTimeout(watch.retryTimer)
      watch.retryTimer = null
      void dialWatch(watch)
    }
  }

  function browse(connectionId: unknown): Promise<MeshBrowse> {
    const connection = connectionFor(connectionId)
    if (!connection) return Promise.resolve(unknownConnectionBrowse(connectionId))
    return browseNow(connection)
  }

  async function browseNow(connection: StoredMeshConnection): Promise<MeshBrowse> {
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
        workspaces: [],
        gaps: [],
      }
    }
    store.updateScopes(connection.id, identity.value.scopes)
    store.markConnected(connection.id)
    rememberCapabilities(connection.id, identity.value.capabilities)
    recordReachability(connection, { reachable: true, unauthorized: false, detail: null })
    const scopes = identity.value.scopes

    const gaps: MeshGap[] = []
    const workspaces = await readWorkspaces(connection, scopes, gaps)

    return {
      connectionId: connection.id,
      reachable: true,
      unreachableReason: null,
      unauthorized: false,
      scopes,
      workspaces,
      gaps,
    }
  }

  async function readWorkspaces(
    connection: StoredMeshConnection,
    scopes: TailnetScope[],
    gaps: MeshGap[],
  ): Promise<MeshWorkspace[]> {
    // Asked for only when the grant allows it. A refusal is a real answer and is
    // reported as one — an empty list would say "that machine has no
    // workspaces", which is a different and false statement.
    if (!scopes.some((scope) => scope.startsWith('workspace:'))) {
      gaps.push({
        part: 'workspaces',
        code: 'scope_required',
        message: "This pairing may not read that machine's workspaces.",
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

  async function workspaceCheckout(connectionId: unknown, workspaceId: unknown): Promise<MeshWorkspaceCheckoutResult> {
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
          return [
            {
              path: record.path,
              branch: typeof record.branch === 'string' ? record.branch : null,
              isMain: record.isMain === true,
            },
          ]
        }),
      },
    }
  }

  async function createConversation(input: {
    connectionId: unknown
    workspaceId?: unknown
    cli?: unknown
    prompt?: unknown
    cliModel?: unknown
    permissionPreset?: unknown
  }): Promise<MeshCreateConversationResult> {
    const connection = connectionFor(input.connectionId)
    if (!connection) return { ok: false, code: 'unknown_connection', message: 'That machine is not paired here.' }
    if (typeof input.workspaceId !== 'string' || !input.workspaceId) {
      return { ok: false, code: 'invalid_arguments', message: 'Name the remote workspace to start the chat in.' }
    }
    // Forwarded verbatim: the remote validates every field, and its refusal
    // reaches the caller word for word.
    const answer = await callRemoteTool({
      endpoint: endpointOf(connection),
      token: connection.deviceToken,
      tool: 'conversation.create',
      args: {
        workspaceId: input.workspaceId,
        ...(typeof input.cli === 'string' && input.cli ? { cli: input.cli } : {}),
        ...(typeof input.prompt === 'string' && input.prompt ? { prompt: input.prompt } : {}),
        ...(typeof input.cliModel === 'string' && input.cliModel ? { cliModel: input.cliModel } : {}),
        ...(typeof input.permissionPreset === 'string' && input.permissionPreset
          ? { permissionPreset: input.permissionPreset }
          : {}),
      },
      // Starting a chat starts its CLI over there; a healthy slow start is not a failure.
      timeoutMs: 60_000,
    })
    if (!answer.ok) {
      // A machine on a build from before `conversation.create` does not have
      // the tool; say that rather than pass on the gateway's bare refusal.
      if (answer.code === 'rpc_error' && /Unknown tool/u.test(answer.message)) {
        return {
          ok: false,
          code: answer.code,
          message: `${connection.machineName} cannot start chat agents yet. Update SprintEngine Studio there to start one from here.`,
        }
      }
      return { ok: false, code: answer.code, message: answer.message }
    }
    const conversation = asRecord(answer.value.conversation)
    const workspaceId = typeof conversation?.workspaceId === 'string' ? conversation.workspaceId : ''
    const agentId = typeof conversation?.agentId === 'string' ? conversation.agentId : ''
    if (!workspaceId || !agentId) {
      return {
        ok: false,
        code: 'unreadable_result',
        message: 'That machine started the chat but did not say which one it is, so it cannot be opened.',
      }
    }
    return {
      ok: true,
      workspaceId,
      agentId,
      title: typeof conversation?.name === 'string' && conversation.name ? conversation.name : 'Chat',
      providerId: typeof conversation?.providerId === 'string' ? conversation.providerId : '',
      modelId: typeof conversation?.modelId === 'string' ? conversation.modelId : '',
    }
  }

  function getLiveState(): MeshLiveState {
    return {
      revision,
      requests: [...outboundRequests.values()].map((request) => ({ ...request.view })),
      reachability: [...reachability.values()].map((entry) => ({ ...entry })),
    }
  }

  async function listConversationsNow(connection: StoredMeshConnection): Promise<MeshConversationListResult> {
    const identity = await readRemoteIdentity({ endpoint: endpointOf(connection), token: connection.deviceToken })
    if (!identity.ok) {
      recordReachability(connection, {
        reachable: false,
        unauthorized: identity.code === 'unauthorized',
        detail: identity.message,
      })
      return { ok: false, code: identity.code, message: identity.message }
    }
    store.updateScopes(connection.id, identity.value.scopes)
    store.markConnected(connection.id)
    rememberCapabilities(connection.id, identity.value.capabilities)
    recordReachability(connection, { reachable: true, unauthorized: false, detail: null })
    // A published list without the lane is a machine that cannot answer;
    // one that published none is asked anyway and answers for itself.
    if (identity.value.capabilities && !tailnetPeerSupports(identity.value.capabilities, 'conversations')) {
      return {
        ok: false,
        code: 'conversations_unsupported',
        message: `${connection.machineName} does not serve conversations. Update Studio there to follow them from here.`,
      }
    }
    // Model switching is a capability of its own: a machine that does not
    // name it lists no catalog and refuses the command, so its chats keep
    // the model they have and the picker says so.
    const listed = await remoteConversations.list(connection.id)
    return listed.ok
      ? { ...listed, modelSwitch: tailnetPeerSupports(identity.value.capabilities, 'conversation-models') }
      : listed
  }

  /**
   * Drop this machine's credential for one peer, and everything hanging off it.
   *
   * Shared by `forget` and the outbound half of `forgetMachine` so the two can
   * never diverge on what forgetting entails: the reachability record, the
   * watch, the followed conversations (which have no credential left to
   * reconnect with), the stored token, and the broadcast that tells every window.
   */
  function forgetConnection(connectionId: string): { id: string; machineName: string } | null {
    const forgotten = store.find(connectionId)
    reachability.delete(connectionId)
    peerCapabilities.delete(connectionId)
    forgetAway(connectionId)
    stopWatch(connectionId)
    // Its followed conversations end, and what was kept of them goes too: a
    // transcript from a machine no longer paired is not this machine's to keep.
    void remoteConversations.forgetConnection(connectionId, 'This machine was removed from your mesh.')
    store.forget(connectionId)
    syncReachabilityTimer()
    if (forgotten) broadcast({ kind: 'machine-forgotten', connectionId, machineName: forgotten.machineName })
    // Never the stored record itself: it carries the device token, and nothing
    // above this line is allowed to hold one.
    return forgotten ? { id: forgotten.id, machineName: forgotten.machineName } : null
  }

  return {
    start,
    onWake,
    async checkReachability(connectionId): Promise<MeshLiveState> {
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
    forgetMachine(input): MeshForgetMachineResult {
      const deviceId = typeof input.deviceId === 'string' && input.deviceId ? input.deviceId : null
      const connectionId = typeof input.connectionId === 'string' && input.connectionId ? input.connectionId : null
      // Inbound first. The outbound forget below tears down followed
      // conversations, and doing it in this order means a machine cannot slip a
      // request in through the door we are about to stop watching.
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

    forget(connectionId): MeshConnection[] {
      if (typeof connectionId === 'string') forgetConnection(connectionId)
      return store.list()
    },
    browse,
    createConversation,
    workspaceCheckout,

    async listConversations(connectionId): Promise<MeshConversationListResult> {
      const connection = connectionFor(connectionId)
      if (!connection) return { ok: false, code: 'unknown_connection', message: 'That machine is not paired here.' }
      return listConversationsNow(connection)
    },

    async followConversation(input) {
      const key = meshConversationKeyOf(input.key)
      if (!key) return { ok: false, code: 'invalid_arguments', message: 'Name the machine and conversation to follow.' }
      return remoteConversations.follow({
        followId: input.followId,
        key,
        ...(isPositiveInteger(input.turnLimit) && input.turnLimit <= 100 ? { turnLimit: input.turnLimit } : {}),
        emit: input.emit,
      })
    },

    unfollowConversation(followId): void {
      if (typeof followId === 'string') remoteConversations.unfollow(followId)
    },

    async conversationLoadEarlier(input): Promise<ConversationPageResult> {
      const key = meshConversationKeyOf(input.key)
      if (!key || !isNonNegativeInteger(input.beforeCursor))
        return { ok: false, message: 'Name the conversation and where to page back from.' }
      return remoteConversations.loadEarlier(
        key,
        input.beforeCursor,
        isPositiveInteger(input.turnLimit) && input.turnLimit <= 100 ? input.turnLimit : undefined,
      )
    },

    async conversationCommand(input): Promise<MeshConversationCommandResult> {
      const key = meshConversationKeyOf(input.key)
      if (!key) return { ok: false, code: 'invalid_arguments', message: 'Name the conversation to send to.' }
      return remoteConversations.command(key, input.command)
    },

    async conversationToolDetail(input): Promise<ConversationToolDetailResult> {
      const key = meshConversationKeyOf(input.key)
      if (!key || typeof input.toolUseId !== 'string' || !input.toolUseId || input.toolUseId.length > 200)
        return { ok: false, code: 'invalid_input', message: 'Name the conversation and the tool call.' }
      return remoteConversations.toolDetail(key, input.toolUseId)
    },

    async conversationToolImage(input): Promise<MeshConversationImageResult> {
      const key = meshConversationKeyOf(input.key)
      if (!key || typeof input.toolUseId !== 'string' || !input.toolUseId || input.toolUseId.length > 200)
        return { ok: false, code: 'invalid_arguments', message: 'Name the conversation and the tool call.' }
      const connection = connectionFor(key.connectionId)
      if (!connection) return { ok: false, code: 'unknown_connection', message: 'That machine is not paired here.' }
      // A machine that said what it can do and left this out cannot serve it.
      // One that has not said yet is asked, and answers for itself.
      const unsupported = `This picture is on ${connection.machineName}, which does not share pictures yet.`
      const capabilities = peerCapabilities.get(connection.id)
      if (capabilities && !tailnetPeerSupports(capabilities, 'conversation-images'))
        return { ok: false, code: 'images_unsupported', message: unsupported }
      const fetched = await fetchRemoteConversationImage({
        endpoint: endpointOf(connection),
        token: connection.deviceToken,
        workspaceId: key.workspaceId,
        agentId: key.agentId,
        toolUseId: input.toolUseId,
      })
      if (!fetched.ok) {
        if (fetched.code === 'unauthorized')
          recordReachability(connection, { reachable: false, unauthorized: true, detail: fetched.message })
        // A build from before the route answers it as any unknown route.
        if (fetched.code === 'not_found' || fetched.code === 'http_404')
          return { ok: false, code: 'images_unsupported', message: unsupported }
        return fetched
      }
      return {
        ok: true,
        dataUrl: `data:${fetched.value.mediaType};base64,${fetched.value.bytes.toString('base64')}`,
      }
    },

    async conversationTurnDiff(input): Promise<ConversationTurnDiffResult> {
      const key = meshConversationKeyOf(input.key)
      if (!key || !isNonNegativeInteger(input.turnSeq)) return { ok: false, message: 'Name the conversation and turn.' }
      const path = typeof input.path === 'string' && input.path.length <= 4096 ? input.path : undefined
      return remoteConversations.turnDiff(key, input.turnSeq, path)
    },

    getLiveState,

    shutdown(): void {
      releaseFocus()
      for (const connectionId of [...awayMachines.keys()]) forgetAway(connectionId)
      supervising = false
      remoteConversations.shutdown()
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

function unknownConnectionBrowse(connectionId: unknown): MeshBrowse {
  return {
    connectionId: typeof connectionId === 'string' ? connectionId : '',
    reachable: false,
    unreachableReason: 'That machine is not paired here.',
    unauthorized: false,
    scopes: [],
    workspaces: [],
    gaps: [],
  }
}

function endpointOf(connection: StoredMeshConnection): { host: string; port: number } {
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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
