// Tailnet peer discovery: the CLIENT half of tailnet remote control.
//
// `tailnet.ts` carries the contracts for configuring THIS machine's listener.
// These are the contracts for finding OTHER machines: which nodes the tailnet
// has, and which of them answer as a Studio. Separate files because they are
// separate directions — one is "who may drive me", the other is "who can I
// drive" — and the panel that shows both is the only place they meet.
//
// The main-process implementation is `src/main/automation/tailnet/tailnet-peers.ts`.

/**
 * What a peer's unauthenticated health endpoint says about itself.
 *
 * This is the WHOLE of what discovery learns from another machine: which
 * product answers, and which versions it speaks. Nothing about that machine,
 * its user, its workspaces, or its paired devices — the health route is written
 * to say no more, and a test pins that it does not.
 */
export type TailnetPeerStudio = {
  product: string
  transportVersion: number
  protocolVersions: string[]
}

/** A machine on this tailnet, as a connect picker shows it. */
export type TailnetPeer = {
  /** Tailscale's stable node id. Survives a rename; the display name does not. */
  id: string
  /** Short host name — what a person recognises in a picker. */
  hostName: string
  /** Full MagicDNS name when the tailnet has it enabled. */
  dnsName: string | null
  /** The tailnet address to dial. */
  address: string
  os: string | null
  /** Tailscale's own view of reachability, not ours. */
  online: boolean
  /** True for this machine; a picker lists it but never offers it as a target. */
  isSelf: boolean
  /**
   * When Tailscale last heard from this node, as an ISO string, or null.
   *
   * Tailscale's own `LastSeen`, passed through rather than interpreted: it is
   * the only last-seen a machine that has never paired with us has, so an
   * offline row can still say how long ago it was awake. Null covers a node
   * Tailscale reports without the field and the zero timestamp it writes for a
   * node it has never seen — both are "we do not know", which is a different
   * thing from "a long time ago" and must not be shown as one.
   *
   * Optional in the TYPE, always set by the scanner: a scan payload held over
   * from a build older than this field carries no `lastSeenAt` at all, and a
   * consumer must read a missing one as null rather than as a date.
   */
  lastSeenAt?: string | null
  /**
   * The Studio listener that answered the probe, or null.
   *
   * Null is "nothing answered on the probed port", which covers a peer with its
   * listener off, a peer listening on a different port, and a peer not running
   * Studio at all. Discovery cannot tell those apart and does not pretend to.
   */
  studio: TailnetPeerStudio | null
}

/** The result of one discovery sweep. */
export type TailnetPeerScan = {
  /** False when the Tailscale CLI is absent, or the daemon did not answer. */
  tailscaleAvailable: boolean
  /** Plain-language reason the sweep found nothing. Null when it succeeded. */
  unavailableReason: string | null
  /** The port probed on every peer. Peers listening elsewhere are invisible by design. */
  probedPort: number
  peers: TailnetPeer[]
}

export const TAILNET_LIST_PEERS_CHANNEL = 'tailnet:list-peers'
