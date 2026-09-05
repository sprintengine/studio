import assert from 'node:assert/strict'

import type { FleetConnection, FleetMachineReachability } from '../../../../shared/tailnet-fleet'
import type { TailnetPeer, TailnetPeerScan } from '../../../../shared/tailnet-peers'
import { ago, connectDirectionNote, peerPickerView } from './peerPickerModel'
import { fleetMachinePhase, machinePhaseText, machineRowAction } from './machineRowModel'

// The one peer picker and the machine-row phase (pair-from-the-scan-and-
// stay-paired, phases 1 and 4): the rules Settings and the Fleet both draw.

const studio = { product: 'SprintEngine Studio MCP', transportVersion: 1, protocolVersions: [] }
const peer = (over: Partial<TailnetPeer> = {}): TailnetPeer => ({
  id: 'n1',
  hostName: 'dev-macbook-air',
  dnsName: 'dev-macbook-air.example.ts.net',
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
  machineName: 'dev-macbook-air',
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
  machineName: 'dev-macbook-air',
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
  assert.match(asleep.label, /not answering · last reached 2 h ago/u)
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
assert.equal(connectDirectionNote('dev-macbook-air', false), 'Lets this Mac drive dev-macbook-air.')
assert.match(connectDirectionNote('dev-macbook-air', true), /and dev-macbook-air drive this Mac/u)

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

assert.equal(machinePhaseText('air', { phase: 'reachable', checkedAt: NOW - 10_000 }, NOW), 'reachable · checked just now')
assert.equal(machinePhaseText('air', { phase: 'unreachable', detail: 'x', lastReachedAt: NOW - 2 * 3_600_000 }, NOW), 'not answering · last reached 2 h ago')
assert.equal(machinePhaseText('air', { phase: 'unreachable', detail: 'x', lastReachedAt: null }, NOW), 'not answering · never reached')
assert.equal(machinePhaseText('air', { phase: 'revoked', detail: 'x' }, NOW), 'revoked there — pair again to reconnect')

// Retry for a machine that stopped answering, Pair again for one that revoked us, nothing otherwise.
assert.equal(machineRowAction({ phase: 'unreachable', detail: 'x', lastReachedAt: null }), 'retry')
assert.equal(machineRowAction({ phase: 'offline', detail: 'x' }), 'retry')
assert.equal(machineRowAction({ phase: 'revoked', detail: 'x' }), 'pair-again')
assert.equal(machineRowAction({ phase: 'reachable', checkedAt: NOW }), null)
assert.equal(machineRowAction({ phase: 'connected', liveSessions: 1 }), null)

console.log('peer picker + machine row contracts ok')
