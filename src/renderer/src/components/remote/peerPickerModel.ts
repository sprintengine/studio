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
  const rank: Record<PeerRowState, number> = { connectable: 0, paired: 1, 'no-studio': 2, offline: 3 }
  rows.sort((left, right) => rank[left.state] - rank[right.state] || left.peer.hostName.localeCompare(right.peer.hostName))
  return {
    emptyMessage: null,
    rows,
    connectableCount: rows.filter((row) => row.state === 'connectable').length,
  }
}

function pairedLabel(reach: FleetMachineReachability | null, now: number): { label: string; tone: Tone } {
  if (!reach || reach.checkedAt === null) return { label: 'Paired', tone: 'neutral' }
  if (reach.unauthorized) return { label: 'Paired here, but revoked there — pair again', tone: 'error' }
  if (reach.reachable) return { label: 'Paired · reachable', tone: 'good' }
  return { label: `Paired · not answering${reach.lastReachedAt ? ` · last reached ${ago(reach.lastReachedAt, now)}` : ''}`, tone: 'neutral' }
}

/**
 * What Connect grants, in one line: the direction is the thing a person gets
 * wrong (pressing Connect on the laptop from the Mac mini asks to drive the
 * laptop), so the row says it before the click.
 */
export function connectDirectionNote(peerName: string, reverse: boolean): string {
  return reverse
    ? `Lets this Mac drive ${peerName}, and ${peerName} drive this Mac.`
    : `Lets this Mac drive ${peerName}.`
}

/** Coarse "2 h ago" for a row's secondary line; the chrome's finer clock is not needed here. */
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
