import type { TailnetDevice } from '../../../../shared/tailnet'
import type { FleetConnection, FleetMachineReachability } from '../../../../shared/tailnet-fleet'
import type { TailnetPeer, TailnetPeerScan } from '../../../../shared/tailnet-peers'
import type { Tone } from '../ui'

// The one peer picker (pair-from-the-scan-and-stay-paired, phase 1), DOM-free.
//
// Settings → Remote and the Fleet used to draw two lists off the same scan:
// one that could only describe a machine and one, behind a disclosure, that
// could act on it. This is the single view both now render. A machine that
// answers as a Studio and is not paired gets Connect; one already paired stays
// in the list and says how it is doing, because a row that vanished on
// pairing read as the scan having failed; one that is online but silent on
// the port says what to do over there.

export type PeerRowState =
  /** Answers as a Studio; Connect is offered. */
  | 'connectable'
  /** Already in the fleet; the row reports reachability instead of offering Connect. */
  | 'paired'
  /**
   * A device already paired TO this machine — a phone, or anything else that
   * connects here rather than hosting a Studio of its own.
   *
   * Distinct from `no-studio`, which is the same silence read as a problem.
   * A phone will never answer on 8471 and has no Remote setting to turn on, so
   * telling someone to go and enable one is advice about a machine that is not
   * broken (owner, 2026-09-05, seeing his own phone in this list under "turn
   * on Remote in its Settings").
   */
  | 'device'
  /** Tailscale says online, but nothing answered on the probed port. */
  | 'no-studio'
  /** Tailscale says asleep or off. */
  | 'offline'

export type PeerRow = {
  peer: TailnetPeer
  state: PeerRowState
  /** The endpoint Connect would dial. */
  endpoint: string
  label: string
  tone: Tone
  /** The fleet record, on a paired row. */
  connection: FleetConnection | null
}

export type PeerPickerView = {
  /** What the list says when it has nothing to show. Null when it has rows. */
  emptyMessage: string | null
  rows: PeerRow[]
  /** How many rows offer Connect — the ones a person can actually act on. */
  connectableCount: number
}

export function peerPickerView(input: {
  scan: TailnetPeerScan | null
  scanning: boolean
  connections: readonly FleetConnection[]
  reachability: ReadonlyMap<string, FleetMachineReachability>
  /**
   * Devices paired to THIS machine. They are matched to peers by the node name
   * whois resolved at their last request, which is the only identity the two
   * sides share.
   */
  devices?: readonly TailnetDevice[]
  now: number
}): PeerPickerView {
  const { scan, scanning } = input
  if (scanning && !scan) return { emptyMessage: 'Looking for machines on your tailnet.', rows: [], connectableCount: 0 }
  if (!scan) return { emptyMessage: 'Scan to see the machines on your tailnet.', rows: [], connectableCount: 0 }
  if (!scan.tailscaleAvailable) {
    return {
      emptyMessage: scan.unavailableReason ?? 'Tailscale is not available on this machine.',
      rows: [],
      connectableCount: 0,
    }
  }
  const others = scan.peers.filter((peer) => !peer.isSelf)
  if (others.length === 0) {
    return {
      emptyMessage: 'This is the only machine on your tailnet. Add another and it appears here.',
      rows: [],
      connectableCount: 0,
    }
  }
  const byEndpoint = new Map(input.connections.map((connection) => [connection.endpoint, connection]))
  const devicesByNode = new Map<string, TailnetDevice>()
  for (const device of input.devices ?? []) {
    const node = normalizeNode(device.lastPeerNode)
    // A device that has never connected has no node to match on, and must not
    // claim a peer row on the strength of its name alone.
    if (node) devicesByNode.set(node, device)
  }
  const rows = others.map((peer): PeerRow => {
    const endpoint = `${peer.address}:${scan.probedPort}`
    const connection = byEndpoint.get(endpoint) ?? null
    if (connection) {
      const reach = input.reachability.get(connection.id) ?? null
      return { peer, state: 'paired', endpoint, connection, ...pairedLabel(reach, input.now) }
    }
    if (peer.studio) {
      return { peer, state: 'connectable', endpoint, connection: null, label: `Studio on port ${scan.probedPort}`, tone: 'good' }
    }
    // Checked after `studio`, so a Mac that both runs Studio and has paired a
    // device from here still offers Connect: hosting is the more useful fact.
    const device = matchDevice(devicesByNode, peer)
    if (device) {
      return {
        peer,
        state: 'device',
        endpoint,
        connection: null,
        label: peer.online
          ? `Paired with this device as ${device.name}`
          : `Paired with this device as ${device.name} — asleep or off`,
        tone: peer.online ? 'good' : 'neutral',
      }
    }
    if (!peer.online) {
      return { peer, state: 'offline', endpoint, connection: null, label: 'Offline — Tailscale says it is asleep or off', tone: 'neutral' }
    }
    // Online but silent on the probed port. We genuinely cannot tell "listener
    // off" from "listening elsewhere" from "not running Studio", so the label
    // says what we know and names the likeliest fix.
    return {
      peer,
      state: 'no-studio',
      endpoint,
      connection: null,
      label: `Online, but no Studio is listening on port ${scan.probedPort} — turn on Remote in its Settings`,
      tone: 'neutral',
    }
  })
  // Connectable first, then paired, then the rest; alphabetical within each,
  // matching the scan's own reachable-before-sleeping order.
  const rank: Record<PeerRowState, number> = { connectable: 0, paired: 1, device: 2, 'no-studio': 3, offline: 4 }
  rows.sort((left, right) => rank[left.state] - rank[right.state] || left.peer.hostName.localeCompare(right.peer.hostName))
  return {
    emptyMessage: null,
    rows,
    connectableCount: rows.filter((row) => row.state === 'connectable').length,
  }
}

/**
 * Node names are compared lower-cased and without the trailing dot MagicDNS
 * sometimes carries, because the two sides learn the name by different routes:
 * the scan reads Tailscale's own listing, the device record keeps whatever
 * whois answered at its last request.
 */
function normalizeNode(value: string | null): string | null {
  const trimmed = value?.trim().toLowerCase().replace(/\.$/u, '') ?? ''
  return trimmed.length > 0 ? trimmed : null
}

/**
 * The device paired from this peer, or null.
 *
 * Matched on the full DNS name first and the short host name second: a tailnet
 * with MagicDNS off reports no `dnsName` at all, and the device record then
 * holds whatever short name whois gave.
 */
function matchDevice(devicesByNode: ReadonlyMap<string, TailnetDevice>, peer: TailnetPeer): TailnetDevice | null {
  for (const candidate of [normalizeNode(peer.dnsName), normalizeNode(peer.hostName)]) {
    if (!candidate) continue
    const device = devicesByNode.get(candidate)
    if (device) return device
    // A short name matching the first label of a stored FQDN, for the reverse
    // of the case above.
    for (const [node, stored] of devicesByNode) {
      if (node.split('.')[0] === candidate) return stored
    }
  }
  return null
}

function pairedLabel(reach: FleetMachineReachability | null, now: number): { label: string; tone: Tone } {
  if (!reach || reach.checkedAt === null) return { label: 'Paired', tone: 'neutral' }
  if (reach.unauthorized) return { label: 'Paired here, but revoked there — pair again', tone: 'error' }
  if (reach.reachable) return { label: 'Paired · reachable', tone: 'good' }
  // How long it has been silent, in the same words the Remote popover's rows
  // use (owner ruling 2026-09-05): one vocabulary for one fact.
  return { label: `Paired · not answering${reach.lastReachedAt ? ` · ${since(reach.lastReachedAt, now)}` : ''}`, tone: 'neutral' }
}

/**
 * What Connect grants, in one line: the direction is the thing a person gets
 * wrong (pressing Connect on the laptop from the Mac mini asks to drive the
 * laptop), so the row says it before the click.
 */
export function connectDirectionNote(peerName: string, reverse: boolean): string {
  return reverse
    ? `Lets this device drive ${peerName}, and ${peerName} drive this device.`
    : `Lets this device drive ${peerName}.`
}

/** Coarse "2 h ago" for a row's secondary line; the chrome's finer clock is not needed here. */
/**
 * How long something has been true, without the "ago" — "8 min", "2 h". A row
 * that already says what the state IS ("not answering") wants the duration of
 * that state, not a second sentence about when it last was not (owner ruling
 * 2026-09-05).
 */
export function since(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000))
  if (seconds < 60) return 'under a min'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'}`
}

export function ago(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}
