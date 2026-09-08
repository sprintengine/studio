// Tailnet remote control: contracts shared between the main-process listener
// (src/main/automation/tailnet/) and the surfaces that configure it.
//
// The listener itself is opt-in and bound to the Tailscale interface address
// only.

/**
 * Per-device scopes, mirroring the gateway's tool families.
 *
 * Read and operate are separate grants so "watch my sprints from the laptop"
 * does not carry the power to cancel them. `terminal:observe` /
 * `terminal:control` are a distinct tier (epic Decision 4): control means
 * arbitrary shell on the host and is never implied by the structured-command
 * scopes. They are declared before the terminal children of the epic land so a
 * device paired today cannot silently acquire remote shell later.
 */
export const TAILNET_SCOPES = [
  'workspace:read',
  'workspace:operate',
  'sprint:read',
  'sprint:operate',
  'backlog:read',
  'backlog:operate',
  'terminal:observe',
  'terminal:control',
] as const

export type TailnetScope = (typeof TAILNET_SCOPES)[number]

/** Every scope except the terminal tier — what a structured-command device asks for. */
export const TAILNET_STRUCTURED_SCOPES: readonly TailnetScope[] = TAILNET_SCOPES.filter(
  (scope) => !scope.startsWith('terminal:')
)

export function isTailnetScope(value: unknown): value is TailnetScope {
  return typeof value === 'string' && (TAILNET_SCOPES as readonly string[]).includes(value)
}

export function normalizeTailnetScopes(value: unknown): TailnetScope[] {
  if (!Array.isArray(value)) return []
  const unique = new Set<TailnetScope>()
  // Anything outside the vocabulary is dropped rather than rejected, which is
  // also how a device paired against a retired tool family loads: it keeps every
  // scope that still means something and silently loses the ones that do not.
  for (const entry of value) if (isTailnetScope(entry)) unique.add(entry)
  // Stable vocabulary order, so a stored device and a freshly minted one compare equal.
  return TAILNET_SCOPES.filter((scope) => unique.has(scope))
}

/**
 * Whether a set of granted scopes satisfies a required one.
 *
 * `operate` implies `read` within its family: a device trusted to cancel a
 * sprint is necessarily trusted to see it, and granting them separately would
 * only produce devices that mutate blind. The implication is one-way — no
 * amount of read access ever confers operate — and never crosses families.
 */
export function tailnetScopeGrantsAccess(granted: ReadonlySet<TailnetScope>, required: TailnetScope): boolean {
  if (granted.has(required)) return true
  // The terminal tier names its halves for what they do rather than read/operate,
  // but the implication is the same one: a device trusted to TYPE into a
  // terminal is necessarily trusted to watch it. One-way, and it never reaches
  // the structured families.
  if (required === 'terminal:observe') return granted.has('terminal:control')
  if (!required.endsWith(':read')) return false
  return granted.has(`${required.slice(0, -':read'.length)}:operate` as TailnetScope)
}

/**
 * How a paired device came to exist (pair-from-the-scan-and-stay-paired,
 * phase 5). Recorded at mint and never changed: the answer to "what is
 * this row?" when a person cannot place a device in their list.
 *
 * - `code`: someone redeemed a carried pairing link (the QR / URL path).
 * - `approval`: a person here allowed a request from another machine; `by`
 *   is the peer node the transport proved, when whois resolved it.
 * - `agent`: an agent on this machine minted it through
 *   `tailnet.offer_pairing`; `by` is the agent's name.
 * - `reverse`: the other half of a both-ways pairing — THIS machine asked to
 *   drive another, and granted it a device here in the same exchange; `by`
 *   is that machine's name.
 * - `unknown`: a record from before origins were kept.
 */
export type TailnetDeviceOrigin = {
  kind: 'code' | 'approval' | 'agent' | 'reverse' | 'unknown'
  by: string | null
}

/** A paired device, as any surface may see it. The device token is never part of this. */
export type TailnetDevice = {
  id: string
  name: string
  scopes: TailnetScope[]
  createdAt: string
  /** Last authenticated request, or null for a device that has never connected. */
  lastSeenAt: string | null
  /** Tailscale node name resolved at the last request; null when whois was unavailable. */
  lastPeerNode: string | null
  origin: TailnetDeviceOrigin
}

/** An outstanding pairing offer — what it grants and when it lapses, never the code. */
export type TailnetPairingState = {
  scopes: TailnetScope[]
  expiresAt: string
}

export type TailnetRemoteStatus = {
  /** The user's setting. False in every build until someone turns it on. */
  enabled: boolean
  running: boolean
  /** `address:port` while running, for the pairing URL. */
  endpoint: string | null
  port: number
  /** This machine's Tailscale address, or null when Tailscale is not up. */
  tailnetAddress: string | null
  /** Why the listener is not running when it was asked to be. */
  lastError: string | null
  /** Whether pairing and reachability events raise OS notifications (phase 3). Defaults on. */
  notifications: boolean
  devices: TailnetDevice[]
  pairing: TailnetPairingState | null
  /** Requests from other machines waiting to be approved or denied here. */
  pairRequests: TailnetPairRequest[]
}

export const TAILNET_GET_STATUS_CHANNEL = 'tailnet:get-status'
export const TAILNET_SET_ENABLED_CHANNEL = 'tailnet:set-enabled'
export const TAILNET_OFFER_PAIRING_CHANNEL = 'tailnet:offer-pairing'
export const TAILNET_CANCEL_PAIRING_CHANNEL = 'tailnet:cancel-pairing'
export const TAILNET_REVOKE_DEVICE_CHANNEL = 'tailnet:revoke-device'

/** What `offer-pairing` returns: the one-time code, shown once and never re-readable. */
export type TailnetPairingOfferView = {
  token: string
  scopes: TailnetScope[]
  expiresAt: string
  /** Full pairing URL when the listener is up, so a QR encodes one scannable string. */
  pairingUrl: string | null
}

/**
 * A pairing request waiting for a person to answer it on the machine being
 * driven (MC-2233).
 *
 * The other pairing path — a code minted here and carried to the other machine
 * — stays exactly as it was: a machine with nobody in front of it cannot
 * approve anything, which is the normal case for a server and a common one for
 * a desktop in another room. This adds a path rather than replacing one.
 */
export type TailnetPairRequest = {
  id: string
  /** The name the requesting client asked to be known by, once paired. */
  deviceName: string
  /**
   * Tailscale's name for the requesting node, or null when `whois` could not
   * resolve it. Null is shown as the bare address and marked unverified rather
   * than dropped: refusing an unresolvable peer would make the feature dead on
   * any machine without the Tailscale CLI, which is most of them.
   */
  peerNode: string | null
  /** The tailnet address the request arrived from. */
  peerAddress: string
  /**
   * Six digits, shown on BOTH machines so the person approving can see they are
   * answering the request that was actually made.
   *
   * It carries no authority and is not a secret: authority is the human
   * pressing Allow. That is the whole reason it can be six digits — as a
   * carried credential it would be a million-value space against an endpoint
   * with no rate limit, which is seconds of brute force.
   */
  comparisonCode: string
  createdAt: string
  expiresAt: string
}

/**
 * What a client sends to ask, and must present to collect.
 *
 * The request id alone is 12 random bytes and so unguessable — but unguessable
 * is not BOUND. Without this, anything that learned an id (a log, a proxy, a
 * shoulder) could collect the device token the approval minted. The asker mints
 * a secret, sends only its SHA-256, and presents the secret to collect, so the
 * token can only be taken by the connection that asked for it.
 */
export type TailnetPairRequestCredential = {
  /** Sent on the request. The plaintext never leaves the asking machine. */
  collectHash: string
}

/** What a requesting client learns when it polls its own request. */
export type TailnetPairRequestOutcome =
  | { status: 'pending'; comparisonCode: string; expiresAt: string }
  | {
      status: 'approved'
      deviceId: string
      deviceName: string
      /** Returned exactly once, to the poll that collects it. */
      deviceToken: string
      scopes: TailnetScope[]
    }
  // Denied and expired are distinct because the client should say different
  // things: one is an answer, the other is nobody having answered. An UNKNOWN
  // id also reports expired — there is nothing useful in telling a caller that
  // an id it invented never existed.
  | { status: 'denied' }
  | { status: 'expired' }

/**
 * How many wrong codes an approver may type before the request is declined
 * for them. Three is a typo allowance, not a guessing budget: the code is on
 * the asker's screen, and a person who cannot see it should not be approving.
 */
export const PAIR_REQUEST_CODE_ATTEMPTS = 3

/**
 * What a surface learns when it answers a request: the device, and fresh status.
 *
 * `code_mismatch` carries how many tries remain; on the last one the request
 * is declined outright and the answer says so, so the card does not offer
 * another go at a request that no longer exists.
 */
export type TailnetApprovePairRequestView =
  | { ok: true; device: TailnetDevice; status: TailnetRemoteStatus }
  | { ok: false; code: 'request_not_found' | 'code_required'; message: string; status: TailnetRemoteStatus }
  | {
      ok: false
      code: 'code_mismatch'
      message: string
      status: TailnetRemoteStatus
      attemptsLeft: number
      /** True when this mismatch was the last allowed and the request has been declined. */
      declined: boolean
    }

/**
 * The reverse half of a both-ways pairing (phase 6): what the ASKING machine
 * sends with its final collect so the machine that approved it can drive it
 * back. The asker minted this device for the approver on its own store; the
 * token travels exactly once, inside the collect that also takes the
 * approver's token, and only over the request the approver already said yes
 * to. Absent when the asker has no listener (a phone) or did not offer it.
 */
export type TailnetReverseGrant = {
  /** `address:port` of the asker's listener, for the approver to dial. */
  endpoint: string
  /** The asker's name for itself, as the approver's Fleet will list it. */
  machineName: string
  deviceId: string
  /** The name the approver's machine was granted under on the asker. */
  deviceName: string
  deviceToken: string
  scopes: TailnetScope[]
}

export const TAILNET_LIST_PAIR_REQUESTS_CHANNEL = 'tailnet:list-pair-requests'
export const TAILNET_APPROVE_PAIR_REQUEST_CHANNEL = 'tailnet:approve-pair-request'
export const TAILNET_DENY_PAIR_REQUEST_CHANNEL = 'tailnet:deny-pair-request'
export const TAILNET_SET_NOTIFICATIONS_CHANNEL = 'tailnet:set-notifications'
/** Main → renderer: open the Remote popover (an OS notification was clicked). */
export const REMOTE_OPEN_REQUESTED_CHANNEL = 'remote:open-requested'

// ── Live state, pushed (MC: remote-sessions-ux / tailnet-live-state-push) ────
//
// Everything above is request/response. These types are the push half: main
// broadcasts a `TailnetPushPayload` to every window whenever the listener,
// a pairing request, or a device's live connection changes, so the renderer
// never polls for a fact main already holds. The payload always carries a
// fresh status + live snapshot beside the event that caused it — a consumer
// stores the latest and can never drift from main by missing one event.

/** One inbound device's live connections, derived from open sockets — never persisted. */
export type TailnetLiveDevice = {
  deviceId: string
  deviceName: string
  /** An RPC stream or terminal socket is open right now. */
  connected: boolean
  /** Terminal session ids this device is currently attached to (observe or control). */
  attachedTerminalSessions: string[]
  /** Epoch ms of the first socket in the current connected stretch, or null. */
  connectedSince: number | null
  /**
   * Epoch ms of the last observed activity — a socket opening or closing, or
   * an authenticated HTTP call — on this device, or null.
   */
  lastActivityAt: number | null
  /**
   * Transport-proven identity of the peer holding the sockets: Tailscale's
   * name for the node when `whois` resolved it, and the address the last
   * socket arrived from. Distinct from `deviceName`, which is what the client
   * CALLED itself at pairing. No user agent or platform: nothing on this
   * transport sends one, and a field main does not hold is not reported.
   */
  peerNode: string | null
  peerAddress: string | null
}

export type TailnetLiveState = {
  /**
   * The service's monotonic change counter at the time of the read, so a
   * subscriber can drop this snapshot when a pushed payload already applied
   * is newer (the initial read resolving after a push — the mount race).
   */
  revision: number
  devices: TailnetLiveDevice[]
}

/**
 * How a pair request stopped waiting. Distinct because the surfaces say
 * different things — an answer given here, an answer nobody gave, and a
 * listener that went away underneath the request are three stories.
 */
export type TailnetPairRequestPhase = 'received' | 'approved' | 'denied' | 'expired' | 'cancelled'

/** Every phase after `received`: the request no longer exists to be answered. */
export function isPairRequestTerminalPhase(phase: TailnetPairRequestPhase): boolean {
  return phase !== 'received'
}

export type TailnetLiveEvent =
  | { kind: 'listener'; running: true }
  /**
   * Down, with the reason when it was ASKED to be up: a port already taken
   * or an interface that vanished at boot reaches every window as this,
   * without waiting for someone to open Settings. `error` is null for a
   * stop that was requested.
   */
  | { kind: 'listener'; running: false; error: string | null }
  | { kind: 'pair-request'; phase: TailnetPairRequestPhase; requestId: string; deviceName: string; peerNode: string | null }
  | { kind: 'device-connection'; deviceId: string; deviceName: string; connected: boolean }
  | {
      kind: 'terminal-drive'
      phase: 'begin' | 'end'
      deviceId: string
      deviceName: string
      terminalSessionId: string
    }
  | { kind: 'devices-changed' }

export type TailnetPushPayload = {
  /**
   * Monotonically increasing per service lifetime: a subscriber applies a payload
   * only when it is newer than the last one applied, so out-of-order delivery
   * or a late initial read can never roll presence backwards.
   */
  revision: number
  event: TailnetLiveEvent
  status: TailnetRemoteStatus
  live: TailnetLiveState
}

export const TAILNET_EVENT_CHANNEL = 'tailnet:event'
export const TAILNET_GET_LIVE_STATE_CHANNEL = 'tailnet:get-live-state'
