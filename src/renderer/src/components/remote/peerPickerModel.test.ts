import assert from 'node:assert/strict'

import type { TailnetDevice } from '../../../../shared/tailnet'
import type { FleetConnection, FleetMachineReachability } from '../../../../shared/tailnet-fleet'
import type { TailnetPeer, TailnetPeerScan } from '../../../../shared/tailnet-peers'
import { ago, connectDirectionNote, peerPickerView } from './peerPickerModel'
import { fleetMachinePhase, machinePhaseText, machineRowAction } from './machineRowModel'

// The one peer picker and the machine-row phase (pair-from-the-scan-and-
// stay-paired, phases 1 and 4): the rules Settings and the Fleet both draw.

const studio = { product: 'SprintEngine Studio MCP', transportVersion: 1, protocolVersions: [] }
const peer = (over: Partial<TailnetPeer> = {}): TailnetPeer => ({
  id: 'n1',
  hostName: 'sam-macbook-air',
  dnsName: 'sam-macbook-air.example.ts.net',
  address: '100.64.0.9',
  os: 'macOS',
  online: true,
  isSelf: false,
  studio,
  ...over,
})
const scanOf = (peers: TailnetPeer[]): TailnetPeerScan => ({
  tailscaleAvailable: true,
  unavailableReason: null,
  probedPort: 8471,
  peers,
})
const connection: FleetConnection = {
  id: 'tnc_1',
  machineName: 'sam-macbook-air',
  endpoint: '100.64.0.9:8471',
  deviceId: 'tnd_1',
  deviceName: 'mini',
  scopes: ['workspace:read'],
  pairedAt: '2026-09-04T20:00:00.000Z',
  lastConnectedAt: null,
  pairedVia: 'request',
}
const reach = (over: Partial<FleetMachineReachability> = {}): FleetMachineReachability => ({
  connectionId: 'tnc_1',
  machineName: 'sam-macbook-air',
  checking: false,
  reachable: true,
  unauthorized: false,
  checkedAt: NOW - 5_000,
  lastReachedAt: NOW - 5_000,
  detail: null,
  ...over,
})
const NOW = Date.parse('2026-09-04T21:00:00.000Z')
const view = (scan: TailnetPeerScan | null, connections: FleetConnection[] = [], reachability = new Map<string, FleetMachineReachability>(), scanning = false) =>
  peerPickerView({ scan, scanning, connections, reachability, now: NOW })

// Before a scan there is nothing to say but how to get something.
assert.match(String(view(null).emptyMessage), /Scan to see/u)
assert.match(String(view(null, [], new Map(), true).emptyMessage), /Looking for/u)
assert.match(String(view({ ...scanOf([]), tailscaleAvailable: false, unavailableReason: 'Tailscale did not answer.' }).emptyMessage), /did not answer/u)
assert.match(String(view(scanOf([peer({ isSelf: true })])).emptyMessage), /only machine on your tailnet/u)

// A Studio that answers gets Connect; this machine is never a row.
{
  const rows = view(scanOf([peer({ isSelf: true, id: 'self' }), peer()])).rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0].state, 'connectable')
  assert.equal(rows[0].endpoint, '100.64.0.9:8471', 'Connect dials the probed port')
  assert.match(rows[0].label, /Studio on port 8471/u)
}

// Already paired stays IN the list and reports how it is doing — a row that
// vanished on pairing read as the scan having failed.
{
  const paired = view(scanOf([peer()]), [connection], new Map([['tnc_1', reach()]])).rows[0]
  assert.equal(paired.state, 'paired')
  assert.equal(paired.connection?.id, 'tnc_1')
  assert.match(paired.label, /Paired · reachable/u)
  const asleep = view(scanOf([peer()]), [connection], new Map([['tnc_1', reach({ reachable: false, lastReachedAt: NOW - 2 * 3_600_000 })]])).rows[0]
  assert.match(asleep.label, /not answering · 2 h/u)
  const revoked = view(scanOf([peer()]), [connection], new Map([['tnc_1', reach({ reachable: false, unauthorized: true })]])).rows[0]
  assert.match(revoked.label, /revoked there — pair again/u)
  assert.equal(revoked.tone, 'error')
  const unchecked = view(scanOf([peer()]), [connection]).rows[0]
  assert.equal(unchecked.label, 'Paired', 'nothing claimed before the first check')
}

// Online but silent on the port says what to do over there; asleep says so.
{
  const rows = view(scanOf([peer({ studio: null, id: 'a', hostName: 'android-phone' }), peer({ online: false, studio: null, id: 'b', hostName: 'work-laptop' })])).rows
  assert.equal(rows[0].state, 'no-studio')
  assert.match(rows[0].label, /turn on Remote in its Settings/u)
  assert.equal(rows[1].state, 'offline')
  assert.match(rows[1].label, /asleep or off/u)
}

// Order: connectable, then paired, then the rest.
{
  const rows = view(
    scanOf([
      peer({ id: 'c', hostName: 'zed', online: false, studio: null, address: '100.64.0.3' }),
      peer({ id: 'b', hostName: 'yak', address: '100.64.0.9' }),
      peer({ id: 'a', hostName: 'xan', address: '100.64.0.2' }),
    ]),
    [connection]
  ).rows
  assert.deepEqual(rows.map((row) => `${row.peer.hostName}:${row.state}`), ['xan:connectable', 'yak:paired', 'zed:offline'])
}

// The direction is said before the click, both ways when the reverse half is offered.
assert.equal(connectDirectionNote('sam-macbook-air', false), 'Lets this device drive sam-macbook-air.')
assert.match(connectDirectionNote('sam-macbook-air', true), /and sam-macbook-air drive this device/u)

assert.equal(ago(NOW - 10_000, NOW), 'just now')
assert.equal(ago(NOW - 5 * 60_000, NOW), '5 min ago')
assert.equal(ago(NOW - 26 * 3_600_000, NOW), '1 day ago')

// ── the machine row's phase (phase 4) ───────────────────────────────────

const attachments = new Map()
assert.deepEqual(fleetMachinePhase('tnc_1', attachments), { phase: 'paired' }, 'no link and no check: paired, nothing more claimed')
assert.deepEqual(fleetMachinePhase('tnc_1', attachments, new Map([['tnc_1', reach({ checking: true, checkedAt: null })]])), { phase: 'checking' })
assert.deepEqual(fleetMachinePhase('tnc_1', attachments, new Map([['tnc_1', reach()]])), { phase: 'reachable', checkedAt: NOW - 5_000 })
assert.deepEqual(
  fleetMachinePhase('tnc_1', attachments, new Map([['tnc_1', reach({ reachable: false, detail: 'Could not reach it.', lastReachedAt: NOW - 60_000 })]])),
  { phase: 'unreachable', detail: 'Could not reach it.', lastReachedAt: NOW - 60_000 }
)
assert.equal(fleetMachinePhase('tnc_1', attachments, new Map([['tnc_1', reach({ reachable: false, unauthorized: true, detail: 'Unauthorized.' })]])).phase, 'revoked')
// A live pane still wins over any probe.
const live = new Map([['pane', { attachId: 'pane', connectionId: 'tnc_1', machineName: 'x', sessionId: 's1', state: 'live' as const, detail: '' }]])
assert.equal(fleetMachinePhase('tnc_1', live, new Map([['tnc_1', reach({ reachable: false, unauthorized: true })]])).phase, 'connected')

// Owner ruling 2026-09-05: a machine that answers gets no words — the green
// glyph is the whole message, and when the check ran is not a fact anyone acts on.
assert.equal(machinePhaseText('air', { phase: 'reachable', checkedAt: NOW - 10_000 }, NOW), '')
assert.equal(machinePhaseText('air', { phase: 'unreachable', detail: 'x', lastReachedAt: NOW - 2 * 3_600_000 }, NOW), 'not answering · 2 h')
assert.equal(machinePhaseText('air', { phase: 'unreachable', detail: 'x', lastReachedAt: null }, NOW), 'not answering · never reached')
assert.equal(machinePhaseText('air', { phase: 'revoked', detail: 'x' }, NOW), 'revoked there — pair again to reconnect')

// Retry for a machine that stopped answering, Pair again for one that revoked us, nothing otherwise.
assert.equal(machineRowAction({ phase: 'unreachable', detail: 'x', lastReachedAt: null }), 'retry')
assert.equal(machineRowAction({ phase: 'offline', detail: 'x' }), 'retry')
assert.equal(machineRowAction({ phase: 'revoked', detail: 'x' }), 'pair-again')
assert.equal(machineRowAction({ phase: 'reachable', checkedAt: NOW }), null)
assert.equal(machineRowAction({ phase: 'connected', liveSessions: 1 }), null)

console.log('peer picker + machine row contracts ok')


// ── A paired device is not a missing Studio ─────────────────────────────────
//
// The owner's own phone sat in this list under "Online, but no Studio is
// listening on port 8471 — turn on Remote in its Settings" (2026-09-05). A
// phone never answers on that port and has no Remote setting to turn on, so
// the row was advice about a machine that was not broken — while the same
// screen, six rows above, listed it as paired.

const device = (over: Partial<TailnetDevice> = {}): TailnetDevice => ({
  id: 'tnd_phone',
  name: 'Sprint Engine Android',
  scopes: ['terminal:control'],
  createdAt: '2026-09-02T21:02:06.952Z',
  lastSeenAt: '2026-09-03T07:51:15.438Z',
  lastPeerNode: 'android-phone.tailabc123.ts.net',
  origin: { kind: 'unknown', by: null },
  ...over,
})
const phone = peer({ id: 'n-phone', hostName: 'android-phone', dnsName: 'android-phone.tailabc123.ts.net', os: 'android', studio: null })
const withDevices = (peers: TailnetPeer[], devices: TailnetDevice[]) =>
  peerPickerView({ scan: scanOf(peers), scanning: false, connections: [], reachability: new Map(), devices, now: NOW })

{
  const [row] = withDevices([phone], [device()]).rows
  assert.equal(row.state, 'device', 'a paired phone is its own state, not no-studio')
  assert.match(row.label, /Paired with this device as Sprint Engine Android/u)
  assert.doesNotMatch(row.label, /turn on Remote/u, 'never tell someone to fix a phone')
  assert.equal(row.tone, 'good')
}

{
  // Offline says so, and still does not accuse the phone of missing a Studio.
  const [row] = withDevices([{ ...phone, online: false }], [device()]).rows
  assert.equal(row.state, 'device')
  assert.match(row.label, /asleep or off/u)
}

{
  // MagicDNS off on one side, on on the other: the short name still matches.
  const shortNamed = withDevices([{ ...phone, dnsName: null }], [device({ lastPeerNode: 'android-phone' })])
  assert.equal(shortNamed.rows[0].state, 'device')
  const longStored = withDevices([{ ...phone, dnsName: null }], [device()])
  assert.equal(longStored.rows[0].state, 'device', 'a short peer name matches a stored FQDN')
  const trailingDot = withDevices([phone], [device({ lastPeerNode: 'ANDROID-PHONE.tailabc123.ts.net.' })])
  assert.equal(trailingDot.rows[0].state, 'device', 'case and the trailing dot are not identity')
}

{
  // A device that has never connected has no node to match on, and must not
  // claim someone else's row on the strength of its name.
  const unmatched = withDevices([phone], [device({ lastPeerNode: null })])
  assert.equal(unmatched.rows[0].state, 'no-studio', 'a device that has never connected must not claim a peer row')
}

{
  // Hosting wins: a Mac that runs Studio AND paired a device from here is
  // still somewhere you can connect to.
  const both = withDevices([peer({ hostName: 'mini', dnsName: 'mini.tailabc123.ts.net' })], [device({ lastPeerNode: 'mini.tailabc123.ts.net' })])
  assert.equal(both.rows[0].state, 'connectable')
  assert.equal(both.connectableCount, 1)
}

{
  // Order: connectable, paired, devices, then the rest.
  const ordered = withDevices(
    [peer({ id: 'a', hostName: 'zed-studio' }), phone, peer({ id: 'b', hostName: 'quiet', studio: null })],
    [device()]
  )
  assert.deepEqual(ordered.rows.map((row) => row.state), ['connectable', 'device', 'no-studio'])
}

console.log('peerPickerModel.test.ts: paired devices ok')
