import type { TailnetDevice, TailnetScope } from './tailnet'
import type { FleetConnection } from './tailnet-fleet'
import type { TailnetPeer } from './tailnet-peers'

// One machine, from three directions at once (remote-settings-rebuild).
//
// Settings → Remote used to show three lists that were really one: the devices
// paired INTO this machine (`TailnetDevice`), the machines this one is paired
// WITH (`FleetConnection`), and the nodes Tailscale says exist (`TailnetPeer`).
// A person has one mental model — "my Mini" — and three rows for it was three
// places to look for the same answer and three places to revoke it from.
//
// This is the merge, kept pure and kept out of the renderer: it is the logic
// the tab leans on entirely, and logic a test can drive with plain data is
// logic that can be got right. Nothing here reads a clock, opens a socket, or
// knows what a row looks like.
//
// The join is the Tailscale node name, because it is the ONE identifier all
// three sides carry: `TailnetPeer.dnsName` is it directly, a device records it
// as `lastPeerNode` (resolved by whois at its last request) or as `origin.by`
// (the machine that granted it), and a connection stores it as `machineName`.
// Case and a trailing dot differ between the sides — Tailscale's own JSON ends
// the name with one — so both are normalised away before anything is compared.

/** One machine in Settings → Remote, whichever directions it is known from. */
export type TailnetMachine = {
  /**
   * The normalised node name, or a fallback derived from whichever record
   * produced the row. Stable across a scan, so it is safe as a React key and
   * as the identity a popover stays open on.
   */
  key: string
  /** What to call it: the Tailscale host name where we have one, else what the record called it. */
  name: string
  /** Tailscale's OS string (`macOS`, `windows`, `linux`, `iOS`, …), or null when only pairing knows this machine. */
  os: string | null
  isSelf: boolean
  /** Tailscale's view of reachability. False for a machine the scan never saw. */
  online: boolean
  /** A Studio listener answered the probe on this node. */
  studio: boolean
  /** Paired, and either reachable now or heard from within the live window. */
  live: boolean
  lastSeenAt: string | null
  /** The device THIS machine granted it: what it may do here. Null when it has never paired in. */
  inbound: { deviceId: string; scopes: TailnetScope[] } | null
  /** The credential this machine holds for it: what we may do there. Null when we have never paired out. */
  outbound: { connectionId: string; scopes: TailnetScope[] } | null
}

export type MergeMachinesInput = {
  /**
   * This machine, when it is known independently of the scan.
   *
   * The peer list already marks its own row `isSelf`, so this is only ever
   * needed when Tailscale is absent or down — the case where the tab must still
   * show "this machine" rather than an empty list. Ignored when the scan
   * already produced a self row.
   */
  self?: { name: string; os?: string | null; dnsName?: string | null } | null
  devices: readonly TailnetDevice[]
  connections: readonly FleetConnection[]
  peers: readonly TailnetPeer[]
  /** Epoch ms or a Date. Only liveness reads it; ordering and identity do not. */
  now: number | Date
}

/**
 * How recently a paired machine must have been heard from to count as live
 * even while Tailscale calls it offline.
 *
 * Tailscale's `Online` is its own view and lags a machine waking by seconds to
 * a minute; a device that authenticated a request thirty seconds ago is by any
 * honest reading live, whatever the scan says. The window is short enough that
 * a sleeping machine drops out of it quickly.
 */
export const TAILNET_LIVE_WINDOW_MS = 2 * 60 * 1000

/**
 * Normalise a node name for comparison: lower case, no trailing dot, trimmed.
 *
 * Exported because the same normalisation has to hold anywhere a caller wants
 * to look a merged row up by name; two spellings of one rule would be two rows
 * for one machine.
 */
export function normalizeNodeName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\.+$/u, '').toLowerCase()
  return trimmed ? trimmed : null
}

type Draft = {
  key: string
  peer: TailnetPeer | null
  device: TailnetDevice | null
  connection: FleetConnection | null
  /** Only for the self row synthesised when the scan saw nothing. */
  fallbackSelf: { name: string; os: string | null } | null
}

/**
 * Every machine this Studio knows about, merged and ordered for the tab.
 *
 * Pure: same inputs, same rows, in the same order. `now` is a parameter rather
 * than a call to `Date.now()` for exactly that reason — a test can put the
 * clock where it needs it, and two rows rendered from one snapshot can never
 * disagree about what "live" meant.
 *
 * Ordering is what a person scans top to bottom: this machine, the paired ones
 * they can use right now, the paired ones that are asleep (most recently awake
 * first, because that is the one they were probably just using), then machines
 * they could pair with, then everything else. Names break every tie, so the
 * list does not reshuffle under a scan that changed nothing.
 */
export function mergeMachines(input: MergeMachinesInput): TailnetMachine[] {
  const nowMs = input.now instanceof Date ? input.now.getTime() : input.now
  const drafts = new Map<string, Draft>()

  const draftFor = (key: string): Draft => {
    const existing = drafts.get(key)
    if (existing) return existing
    const created: Draft = { key, peer: null, device: null, connection: null, fallbackSelf: null }
    drafts.set(key, created)
    return created
  }

  // Peers first, so a machine the scan saw owns its row and the pairing records
  // attach to it rather than the other way round. A peer with no MagicDNS name
  // still gets a row, keyed on its node id — unnamed is not invisible.
  for (const peer of input.peers) {
    const key = normalizeNodeName(peer.dnsName) ?? `node:${peer.id}`
    draftFor(key).peer = peer
  }

  // A device names its machine either by the node whois resolved at its last
  // request or by whoever granted it; the first is the better answer when both
  // exist, because it is what the transport proved rather than what a label
  // said. An unmatched key makes its own row: a device that has never connected
  // is still a pairing a person may want to revoke.
  for (const device of input.devices) {
    const key = normalizeNodeName(device.lastPeerNode) ?? normalizeNodeName(device.origin.by) ?? `device:${device.id}`
    const draft = draftFor(key)
    // Two devices for one machine (paired twice) collapse to one row, keeping
    // the one seen most recently: the row can only offer one Revoke, and the
    // live credential is the one that matters.
    if (!draft.device || isNewer(device.lastSeenAt, draft.device.lastSeenAt)) draft.device = device
  }

  for (const connection of input.connections) {
    const key = normalizeNodeName(connection.machineName) ?? `connection:${connection.id}`
    const draft = draftFor(key)
    if (!draft.connection || isNewer(connection.lastConnectedAt, draft.connection.lastConnectedAt)) {
      draft.connection = connection
    }
  }

  // Only when the scan produced no self row at all: Tailscale absent or down
  // must still leave "this machine" on the tab.
  if (input.self && !input.peers.some((peer) => peer.isSelf)) {
    const key = normalizeNodeName(input.self.dnsName) ?? normalizeNodeName(input.self.name) ?? 'self'
    const draft = draftFor(key)
    draft.fallbackSelf = { name: input.self.name, os: input.self.os ?? null }
  }

  const rows = [...drafts.values()].map((draft) => toMachine(draft, nowMs))
  return rows.sort((left, right) => {
    const band = orderBand(left) - orderBand(right)
    if (band !== 0) return band
    // Within the asleep band, most recently awake first; a machine with no
    // last-seen at all sorts after ones that have one, because "we do not know"
    // is not "just now".
    if (orderBand(left) === BAND_PAIRED_ASLEEP) {
      const seen = seenMs(right.lastSeenAt) - seenMs(left.lastSeenAt)
      if (seen !== 0) return seen
    }
    return left.name.localeCompare(right.name)
  })
}

const BAND_SELF = 0
const BAND_PAIRED_LIVE = 1
const BAND_PAIRED_ASLEEP = 2
const BAND_UNPAIRED_ONLINE = 3
const BAND_REST = 4

function orderBand(machine: TailnetMachine): number {
  if (machine.isSelf) return BAND_SELF
  const paired = machine.inbound !== null || machine.outbound !== null
  if (paired) return machine.live ? BAND_PAIRED_LIVE : BAND_PAIRED_ASLEEP
  return machine.online ? BAND_UNPAIRED_ONLINE : BAND_REST
}

function toMachine(draft: Draft, nowMs: number): TailnetMachine {
  const { peer, device, connection, fallbackSelf } = draft
  const inbound = device ? { deviceId: device.id, scopes: [...device.scopes] } : null
  const outbound = connection ? { connectionId: connection.id, scopes: [...connection.scopes] } : null
  // Precedence, not recency: what a device told us about itself beats what the
  // fleet recorded, and both beat Tailscale's view of a node it merely knows.
  const lastSeenAt = device?.lastSeenAt ?? connection?.lastConnectedAt ?? peer?.lastSeenAt ?? null
  const isSelf = peer?.isSelf === true || (fallbackSelf !== null && !peer)
  const online = peer?.online ?? isSelf
  const paired = inbound !== null || outbound !== null
  return {
    key: draft.key,
    name: peer?.hostName || fallbackSelf?.name || device?.name || connection?.machineName || draft.key,
    os: peer?.os ?? fallbackSelf?.os ?? null,
    isSelf,
    online,
    studio: peer?.studio != null,
    // This machine is never "live": it is not a link that can drop, and marking
    // it so would put it in the same visual class as a remote that is up.
    live: !isSelf && paired && (online || withinLiveWindow(lastSeenAt, nowMs)),
    lastSeenAt,
    inbound,
    outbound,
  }
}

function withinLiveWindow(iso: string | null, nowMs: number): boolean {
  const seen = seenMs(iso)
  if (!Number.isFinite(seen) || seen <= 0) return false
  return nowMs - seen <= TAILNET_LIVE_WINDOW_MS
}

/** Epoch ms, or -Infinity for an absent or unreadable timestamp so it sorts last. */
function seenMs(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

function isNewer(candidate: string | null, current: string | null): boolean {
  return seenMs(candidate) > seenMs(current)
}

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

/**
 * How long ago, twice: a token for the row and a sentence for its title.
 *
 * The short form is deliberately tiny — `35m`, `3h`, `3d`, `2w` — because it
 * sits at the end of a supporting line and must not compete with the machine's
 * name. The long form is the whole fact, for the `title` attribute and for a
 * screen reader, which cannot make anything of "3d".
 *
 * An absent or unreadable timestamp yields two empty strings rather than
 * invented copy: "we do not know when" is the caller's story to tell, and this
 * function has no business guessing at it. Weeks are the largest unit — there
 * is no month token in this design — so a machine asleep for a year reads as
 * the number of weeks it has been, which is at least true.
 */
export function relativeSeen(iso: string | null | undefined, now: number | Date): { short: string; long: string } {
  const nowMs = now instanceof Date ? now.getTime() : now
  const seen = typeof iso === 'string' ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(seen)) return { short: '', long: '' }
  // A clock ahead of ours is not the future; it is skew, and it reads as now.
  const elapsed = Math.max(0, nowMs - seen)

  if (elapsed < MINUTE_MS) return { short: 'now', long: 'Last seen just now' }
  if (elapsed < HOUR_MS) return token(Math.floor(elapsed / MINUTE_MS), 'm', 'minute')
  if (elapsed < DAY_MS) return token(Math.floor(elapsed / HOUR_MS), 'h', 'hour')
  if (elapsed < WEEK_MS) return token(Math.floor(elapsed / DAY_MS), 'd', 'day')
  return token(Math.floor(elapsed / WEEK_MS), 'w', 'week')
}

function token(count: number, suffix: string, unit: string): { short: string; long: string } {
  return {
    short: `${count}${suffix}`,
    long: `Last seen ${count} ${unit}${count === 1 ? '' : 's'} ago`,
  }
}
