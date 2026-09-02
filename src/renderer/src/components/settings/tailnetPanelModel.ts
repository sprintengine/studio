import type { TailnetDevice, TailnetPairRequest, TailnetRemoteStatus } from '../../../../shared/tailnet'
import type { TailnetPeer, TailnetPeerScan } from '../../../../shared/tailnet-peers'
import type { Tone } from '../ui'

// The Remote (tailnet) settings panel's view model, kept DOM-free so the rules
// that matter can be tested without mounting anything.
//
// The rule that matters most: this feature cannot be half-enabled. Tailscale
// missing or stopped is not a degraded mode you can switch on and hope — the
// listener refuses to bind anywhere but a tailnet address, so the panel must
// refuse the switch and say why, rather than flipping a toggle that quietly
// does nothing.

export type TailnetPanelState = 'loading' | 'no-tailnet' | 'off' | 'not-listening' | 'listening'

export type TailnetReadiness = {
  state: TailnetPanelState
  /** Headline word for the status line. */
  label: string
  tone: Tone
  /** One sentence: what is true now, and what to do about it. */
  detail: string
  /**
   * Whether the switch may be turned ON. False with no tailnet — the listener
   * would refuse to bind, so offering the switch would be offering a lie.
   */
  canTurnOn: boolean
  /**
   * Whether a pairing code may be minted. A code is a URL pointing at a
   * listener; with nothing listening there is nothing for it to point at.
   */
  canPair: boolean
}

export function tailnetReadiness(status: TailnetRemoteStatus | null): TailnetReadiness {
  if (!status) {
    return {
      state: 'loading',
      label: 'Loading',
      tone: 'neutral',
      detail: 'Reading tailnet remote control.',
      canTurnOn: false,
      canPair: false,
    }
  }

  if (!status.tailnetAddress) {
    // The one hard prerequisite, stated in the two situations a person can be
    // in: they have not set Tailscale up, or it stopped underneath them.
    return {
      state: 'no-tailnet',
      label: 'Tailscale not detected',
      tone: status.enabled ? 'error' : 'neutral',
      detail: status.enabled
        ? 'Remote control is on, but Tailscale is not running on this machine, so nothing is listening. Start Tailscale and sign in.'
        : 'This machine is not on a Tailscale network. Install Tailscale and sign in, then remote control can be turned on.',
      canTurnOn: false,
      canPair: false,
    }
  }

  if (!status.enabled) {
    return {
      state: 'off',
      label: 'Off',
      tone: 'neutral',
      detail: 'Nothing on your tailnet can reach this Studio. Turn it on to pair a device.',
      canTurnOn: true,
      canPair: false,
    }
  }

  if (!status.running || !status.endpoint) {
    return {
      state: 'not-listening',
      label: 'Not listening',
      tone: 'error',
      detail: status.lastError ?? 'Remote control is on, but the listener did not start.',
      canTurnOn: true,
      canPair: false,
    }
  }

  return {
    state: 'listening',
    label: 'Listening',
    tone: 'good',
    detail: `Paired devices can reach this Studio at ${status.endpoint} over your tailnet.`,
    canTurnOn: true,
    canPair: true,
  }
}

/**
 * How long an outstanding pairing code has left, in words.
 *
 * Codes run to 30 days, so the unit has to climb with the remainder: "Expires
 * in 43200 min" is technically true and useless. Each step floors to its own
 * unit rather than rounding up into the next, so the words never claim more
 * time than the code has.
 */
export function pairingExpiry(expiresAt: string, now: number): string {
  const remainingMs = Date.parse(expiresAt) - now
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'Expired'
  const days = Math.floor(remainingMs / 86_400_000)
  if (days >= 1) return `Expires in ${days} ${days === 1 ? 'day' : 'days'}`
  const hours = Math.floor(remainingMs / 3_600_000)
  if (hours >= 1) return `Expires in ${hours} ${hours === 1 ? 'hour' : 'hours'}`
  const minutes = Math.floor(remainingMs / 60_000)
  if (minutes >= 1) return `Expires in ${minutes} min`
  return `Expires in ${Math.max(1, Math.ceil(remainingMs / 1000))}s`
}

/**
 * What to say about a pairing offer the panel can see but cannot show.
 *
 * The code is returned once and never re-readable, so a panel that was closed
 * and reopened knows a code is outstanding without knowing what it says. Saying
 * exactly that is the only honest option: hiding it would leave a live
 * credential with no way to cancel it, and pretending none exists would put a
 * "Pair a device" button over a code someone may be walking across the room.
 */
export function outstandingPairingNote(pairing: { scopes: string[]; expiresAt: string }, now: number): string {
  return `A pairing code is already active — ${pairingExpiry(pairing.expiresAt, now).toLowerCase()}, granting ${pairing.scopes.length} scopes. It can only be shown once, so create a new one if you no longer have it.`
}

/** The device list's secondary line: scopes granted, and where it was last seen. */
export function deviceSummary(device: TailnetDevice, formatDate: (value: string) => string): string {
  const scopes = device.scopes.length > 0 ? `${device.scopes.length} scopes` : 'No scopes'
  const seen = device.lastSeenAt
    ? `Last seen ${formatDate(device.lastSeenAt)}${device.lastPeerNode ? ` from ${device.lastPeerNode}` : ''}`
    : 'Never connected'
  return `${scopes} · ${seen}`
}

export type PeerListView = {
  /** What the list area says when it has nothing to show. Null when it has peers. */
  emptyMessage: string | null
  /** Peers, self last: it is context, not a target. */
  peers: TailnetPeer[]
  /** Count of peers that answered as a Studio — the ones actually connectable. */
  studioCount: number
}

/**
 * The peer list, and what to say when it is empty.
 *
 * Each empty case gets its own sentence because each has a different fix, and a
 * single "no machines found" would send a person looking in the wrong place.
 */
export function peerListView(scan: TailnetPeerScan | null, scanning: boolean): PeerListView {
  if (scanning && !scan) {
    return { emptyMessage: 'Looking for machines on your tailnet.', peers: [], studioCount: 0 }
  }
  if (!scan) {
    return { emptyMessage: 'Scan to see the machines on your tailnet.', peers: [], studioCount: 0 }
  }
  if (!scan.tailscaleAvailable) {
    return { emptyMessage: scan.unavailableReason ?? 'Tailscale is not available on this machine.', peers: [], studioCount: 0 }
  }

  const others = scan.peers.filter((peer) => !peer.isSelf)
  if (others.length === 0) {
    return {
      emptyMessage: 'This is the only machine on your tailnet. Add another and it appears here.',
      peers: [],
      studioCount: 0,
    }
  }
  return {
    emptyMessage: null,
    peers: others,
    studioCount: others.filter((peer) => peer.studio !== null).length,
  }
}

/** A peer row's state, in the words a person can act on. */
export function peerStatus(peer: TailnetPeer, probedPort: number): { label: string; tone: Tone } {
  if (peer.studio) return { label: `Studio on port ${probedPort}`, tone: 'good' }
  if (!peer.online) return { label: 'Offline', tone: 'neutral' }
  // Online but silent on the probed port. We genuinely cannot tell "listener
  // off" from "listening elsewhere" from "not running Studio", so the label
  // says what we know rather than picking one.
  return { label: `No Studio answering on port ${probedPort}`, tone: 'neutral' }
}


/**
 * A waiting request's secondary line: who is asking, and from where.
 *
 * An unresolvable peer is stated as unverified rather than dropped or dressed
 * up — `whois` is unavailable on any machine without the Tailscale CLI, and a
 * request shown with an invented name would be worse than one shown with an
 * address and a caveat.
 */
export function pairRequestSummary(request: TailnetPairRequest): string {
  const from = request.peerNode ?? `${request.peerAddress || 'an unknown address'} · name unverified`
  return `Asking from ${from}`
}

/**
 * Whether a waiting request can still be answered, and what to say when it
 * cannot. A lapsed request stays on screen until the next read rather than
 * vanishing under the cursor, so the button explains itself instead of failing.
 */
export function pairRequestAnswerable(
  request: TailnetPairRequest,
  nowMs: number
): { canAnswer: boolean; note: string | null } {
  const expiresAtMs = Date.parse(request.expiresAt)
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
    return { canAnswer: false, note: 'This request lapsed before it was answered.' }
  }
  return { canAnswer: true, note: null }
}
