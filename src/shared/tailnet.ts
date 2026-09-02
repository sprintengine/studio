// Tailnet remote control: contracts shared between the main-process listener
// (src/main/automation/tailnet/) and the surfaces that configure it.
//
// The listener itself is opt-in and bound to the Tailscale interface address
// only; see knowledge/multicode/tailnet-remote-control.md.

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
  'horizon:read',
  'horizon:operate',
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

/** What a surface learns when it answers a request: the device, and fresh status. */
export type TailnetApprovePairRequestView =
  | { ok: true; device: TailnetDevice; status: TailnetRemoteStatus }
  | { ok: false; code: 'request_not_found'; message: string; status: TailnetRemoteStatus }

export const TAILNET_LIST_PAIR_REQUESTS_CHANNEL = 'tailnet:list-pair-requests'
export const TAILNET_APPROVE_PAIR_REQUEST_CHANNEL = 'tailnet:approve-pair-request'
export const TAILNET_DENY_PAIR_REQUEST_CHANNEL = 'tailnet:deny-pair-request'
