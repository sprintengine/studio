import assert from 'node:assert/strict'

import type { TailnetDevice, TailnetScope } from './tailnet'
import type { FleetConnection } from './tailnet-fleet'
import type { TailnetPeer } from './tailnet-peers'
import {
  mergeMachines,
  normalizeNodeName,
  relativeSeen,
  TAILNET_LIVE_WINDOW_MS,
  type TailnetMachine,
} from './tailnet-machines'

// The merge is the whole of Settings → Remote's data model, so it is tested the
// way the tab will use it: three sources that disagree about spelling, one row
// per machine, and an order a person can scan without hunting.

let failures = 0
function check(name: string, run: () => void): void {
  try {
    run()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

const NOW = Date.parse('2026-09-10T12:00:00Z')
const ago = (ms: number): string => new Date(NOW - ms).toISOString()

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

const STRUCTURED: TailnetScope[] = [
  'workspace:read',
  'workspace:operate',
  'sprint:read',
  'sprint:operate',
  'backlog:read',
  'backlog:operate',
]

function peer(over: Partial<TailnetPeer> & { id: string; hostName: string }): TailnetPeer {
  return {
    dnsName: `${over.hostName}.tail1234.ts.net`,
    address: '100.64.0.1',
    os: 'macOS',
    online: true,
    isSelf: false,
    lastSeenAt: null,
    studio: null,
    ...over,
  }
}

function device(over: Partial<TailnetDevice> & { id: string }): TailnetDevice {
  return {
    name: 'a device',
    scopes: [...STRUCTURED],
    createdAt: ago(30 * DAY),
    lastSeenAt: null,
    lastPeerNode: null,
    origin: { kind: 'code', by: null },
    ...over,
  }
}

function connection(over: Partial<FleetConnection> & { id: string; machineName: string }): FleetConnection {
  return {
    endpoint: '100.64.0.2:8788',
    deviceId: 'tnd_remote',
    deviceName: 'this-machine',
    scopes: [...STRUCTURED],
    pairedAt: ago(20 * DAY),
    lastConnectedAt: null,
    pairedVia: 'request',
    ...over,
  }
}

const byKey = (rows: TailnetMachine[], key: string): TailnetMachine => {
  const found = rows.find((row) => row.key === key)
  assert.ok(found, `expected a row keyed ${key}, got ${rows.map((row) => row.key).join(', ')}`)
  return found
}

// ── The join ─────────────────────────────────────────────────────────────────

check('case and a trailing dot are not two machines', () => {
  assert.equal(normalizeNodeName('desktop-a1b2c3d.Tail1234.TS.net.'), 'desktop-a1b2c3d.tail1234.ts.net')
  assert.equal(normalizeNodeName('  mini.tail1234.ts.net  '), 'mini.tail1234.ts.net')
  assert.equal(normalizeNodeName(''), null)
  assert.equal(normalizeNodeName(null), null)
})

check('one machine known three ways is one row carrying all three', () => {
  const rows = mergeMachines({
    peers: [
      peer({
        id: 'n-mini',
        hostName: 'mac-mini',
        // Tailscale's own JSON ends the name with a dot; the device and the
        // connection spell it without one, and in a different case.
        dnsName: 'mac-mini.tail1234.ts.net.',
        os: 'macOS',
        studio: { product: 'Studio', transportVersion: 1, protocolVersions: ['2026-01-01'] },
      }),
    ],
    devices: [device({ id: 'tnd_1', lastPeerNode: 'MAC-MINI.tail1234.ts.net', scopes: ['workspace:read'] })],
    connections: [connection({ id: 'tnc_1', machineName: 'mac-mini.tail1234.ts.net.', scopes: STRUCTURED })],
    now: NOW,
  })
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.key, 'mac-mini.tail1234.ts.net')
  assert.equal(row.name, 'mac-mini')
  assert.equal(row.os, 'macOS')
  assert.equal(row.studio, true)
  assert.deepEqual(row.inbound, { deviceId: 'tnd_1', scopes: ['workspace:read'] })
  assert.deepEqual(row.outbound, { connectionId: 'tnc_1', scopes: STRUCTURED })
})

check('a device with no resolved node falls back to who granted it', () => {
  const rows = mergeMachines({
    peers: [peer({ id: 'n-book', hostName: 'laptop', dnsName: 'laptop.tail1234.ts.net' })],
    devices: [
      device({ id: 'tnd_2', lastPeerNode: null, origin: { kind: 'reverse', by: 'laptop.tail1234.ts.net' } }),
    ],
    connections: [],
    now: NOW,
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].inbound?.deviceId, 'tnd_2')
})

check('a pairing whose machine the scan never saw still gets a row', () => {
  const rows = mergeMachines({
    peers: [],
    devices: [device({ id: 'tnd_3', name: 'a phone', lastPeerNode: null, origin: { kind: 'code', by: null } })],
    connections: [connection({ id: 'tnc_3', machineName: 'server.tail1234.ts.net' })],
    now: NOW,
  })
  assert.deepEqual(
    rows.map((row) => row.name).sort(),
    ['a phone', 'server.tail1234.ts.net']
  )
  // Nothing pretends to know a machine Tailscale never mentioned.
  assert.equal(byKey(rows, 'device:tnd_3').online, false)
  assert.equal(byKey(rows, 'device:tnd_3').os, null)
})

check('two devices for one machine collapse to the one seen most recently', () => {
  const rows = mergeMachines({
    peers: [peer({ id: 'n-mini', hostName: 'mini', dnsName: 'mini.tail1234.ts.net' })],
    devices: [
      device({ id: 'tnd_old', lastPeerNode: 'mini.tail1234.ts.net', lastSeenAt: ago(9 * DAY) }),
      device({ id: 'tnd_new', lastPeerNode: 'mini.tail1234.ts.net', lastSeenAt: ago(2 * HOUR) }),
    ],
    connections: [],
    now: NOW,
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].inbound?.deviceId, 'tnd_new')
})

check('this machine appears even with Tailscale down', () => {
  const rows = mergeMachines({
    self: { name: 'desk', os: 'macOS' },
    peers: [],
    devices: [],
    connections: [],
    now: NOW,
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].isSelf, true)
  assert.equal(rows[0].name, 'desk')
  // Never "live": this machine is not a link that can drop.
  assert.equal(rows[0].live, false)

  // And it is not duplicated when the scan did produce a self row.
  const scanned = mergeMachines({
    self: { name: 'desk', os: 'macOS' },
    peers: [peer({ id: 'n-self', hostName: 'desk', isSelf: true })],
    devices: [],
    connections: [],
    now: NOW,
  })
  assert.equal(scanned.length, 1)
  assert.equal(scanned[0].isSelf, true)
})

// ── Last seen and liveness ───────────────────────────────────────────────────

check('last seen prefers the device, then the connection, then Tailscale', () => {
  const base = {
    peers: [peer({ id: 'n', hostName: 'box', dnsName: 'box.tail1234.ts.net', online: false, lastSeenAt: ago(3 * WEEK) })],
    connections: [connection({ id: 'tnc', machineName: 'box.tail1234.ts.net', lastConnectedAt: ago(2 * DAY) })],
    now: NOW,
  }
  const withDevice = mergeMachines({
    ...base,
    devices: [device({ id: 'tnd', lastPeerNode: 'box.tail1234.ts.net', lastSeenAt: ago(3 * HOUR) })],
  })
  assert.equal(withDevice[0].lastSeenAt, ago(3 * HOUR))

  const withoutDevice = mergeMachines({ ...base, devices: [] })
  assert.equal(withoutDevice[0].lastSeenAt, ago(2 * DAY))

  const scanOnly = mergeMachines({ ...base, devices: [], connections: [] })
  assert.equal(scanOnly[0].lastSeenAt, ago(3 * WEEK))
})

check('live means paired and either reachable now or just heard from', () => {
  const rows = mergeMachines({
    peers: [
      peer({ id: 'n-up', hostName: 'up', dnsName: 'up.tail1234.ts.net', online: true }),
      // Tailscale has not caught up with a machine that authenticated a request
      // seconds ago; a row that called it asleep would be contradicting itself.
      peer({ id: 'n-waking', hostName: 'waking', dnsName: 'waking.tail1234.ts.net', online: false }),
      peer({ id: 'n-gone', hostName: 'gone', dnsName: 'gone.tail1234.ts.net', online: false }),
      // Online but not paired: reachable is not the same as live.
      peer({ id: 'n-stranger', hostName: 'stranger', dnsName: 'stranger.tail1234.ts.net', online: true }),
    ],
    devices: [
      device({ id: 'a', lastPeerNode: 'up.tail1234.ts.net' }),
      device({ id: 'b', lastPeerNode: 'waking.tail1234.ts.net', lastSeenAt: ago(TAILNET_LIVE_WINDOW_MS - MINUTE) }),
      device({ id: 'c', lastPeerNode: 'gone.tail1234.ts.net', lastSeenAt: ago(TAILNET_LIVE_WINDOW_MS + MINUTE) }),
    ],
    connections: [],
    now: NOW,
  })
  assert.equal(byKey(rows, 'up.tail1234.ts.net').live, true)
  assert.equal(byKey(rows, 'waking.tail1234.ts.net').live, true)
  assert.equal(byKey(rows, 'gone.tail1234.ts.net').live, false)
  assert.equal(byKey(rows, 'stranger.tail1234.ts.net').live, false)
})

// ── Order ────────────────────────────────────────────────────────────────────

check('self, then live paired, then asleep by last seen, then pairable, then the rest', () => {
  const rows = mergeMachines({
    peers: [
      peer({ id: 'n-zed', hostName: 'zed-offline', dnsName: 'zed.tail1234.ts.net', online: false }),
      peer({ id: 'n-abe', hostName: 'abe-online', dnsName: 'abe.tail1234.ts.net', online: true }),
      peer({ id: 'n-self', hostName: 'this-desk', dnsName: 'desk.tail1234.ts.net', isSelf: true }),
      peer({ id: 'n-live', hostName: 'live-mini', dnsName: 'mini.tail1234.ts.net', online: true }),
      peer({ id: 'n-old', hostName: 'old-book', dnsName: 'book.tail1234.ts.net', online: false }),
      peer({ id: 'n-recent', hostName: 'recent-box', dnsName: 'box.tail1234.ts.net', online: false }),
    ],
    devices: [
      device({ id: 'd-live', lastPeerNode: 'mini.tail1234.ts.net' }),
      device({ id: 'd-old', lastPeerNode: 'book.tail1234.ts.net', lastSeenAt: ago(3 * WEEK) }),
      device({ id: 'd-recent', lastPeerNode: 'box.tail1234.ts.net', lastSeenAt: ago(3 * DAY) }),
    ],
    connections: [],
    now: NOW,
  })
  assert.deepEqual(
    rows.map((row) => row.name),
    ['this-desk', 'live-mini', 'recent-box', 'old-book', 'abe-online', 'zed-offline']
  )
})

check('names break every tie, so a scan that changed nothing reshuffles nothing', () => {
  const rows = mergeMachines({
    peers: [
      peer({ id: 'n-c', hostName: 'charlie', dnsName: 'charlie.ts.net', online: true }),
      peer({ id: 'n-a', hostName: 'alpha', dnsName: 'alpha.ts.net', online: true }),
      peer({ id: 'n-b', hostName: 'bravo', dnsName: 'bravo.ts.net', online: true }),
    ],
    devices: [],
    connections: [],
    now: NOW,
  })
  assert.deepEqual(
    rows.map((row) => row.name),
    ['alpha', 'bravo', 'charlie']
  )
})

check('an asleep machine with no last seen at all sorts after ones that have one', () => {
  const rows = mergeMachines({
    peers: [
      peer({ id: 'n-known', hostName: 'aa-known', dnsName: 'known.ts.net', online: false, lastSeenAt: ago(9 * WEEK) }),
      peer({ id: 'n-never', hostName: 'zz-never', dnsName: 'never.ts.net', online: false }),
    ],
    devices: [
      device({ id: 'd-known', lastPeerNode: 'known.ts.net' }),
      device({ id: 'd-never', lastPeerNode: 'never.ts.net' }),
    ],
    connections: [],
    now: NOW,
  })
  assert.deepEqual(
    rows.map((row) => row.name),
    ['aa-known', 'zz-never']
  )
})

// ── The relative-time token ──────────────────────────────────────────────────

check('the short token and the long sentence say the same thing', () => {
  assert.deepEqual(relativeSeen(ago(35 * MINUTE), NOW), { short: '35m', long: 'Last seen 35 minutes ago' })
  assert.deepEqual(relativeSeen(ago(3 * HOUR), NOW), { short: '3h', long: 'Last seen 3 hours ago' })
  assert.deepEqual(relativeSeen(ago(3 * DAY), NOW), { short: '3d', long: 'Last seen 3 days ago' })
  assert.deepEqual(relativeSeen(ago(2 * WEEK), NOW), { short: '2w', long: 'Last seen 2 weeks ago' })
})

check('a count of one is not pluralised', () => {
  assert.deepEqual(relativeSeen(ago(MINUTE), NOW), { short: '1m', long: 'Last seen 1 minute ago' })
  assert.deepEqual(relativeSeen(ago(HOUR), NOW), { short: '1h', long: 'Last seen 1 hour ago' })
  assert.deepEqual(relativeSeen(ago(DAY), NOW), { short: '1d', long: 'Last seen 1 day ago' })
  assert.deepEqual(relativeSeen(ago(WEEK), NOW), { short: '1w', long: 'Last seen 1 week ago' })
})

check('units change at the boundary and never round up past it', () => {
  // 59 minutes 59 seconds is still minutes; one second later it is an hour.
  assert.equal(relativeSeen(ago(HOUR - 1000), NOW).short, '59m')
  assert.equal(relativeSeen(ago(HOUR), NOW).short, '1h')
  assert.equal(relativeSeen(ago(DAY - 1000), NOW).short, '23h')
  assert.equal(relativeSeen(ago(DAY), NOW).short, '1d')
  assert.equal(relativeSeen(ago(WEEK - 1000), NOW).short, '6d')
  assert.equal(relativeSeen(ago(WEEK), NOW).short, '1w')
  // Weeks are the largest unit; a year asleep reads as the weeks it has been.
  assert.equal(relativeSeen(ago(52 * WEEK), NOW).short, '52w')
})

check('under a minute is now, and a clock ahead of ours is skew rather than the future', () => {
  assert.deepEqual(relativeSeen(ago(10 * 1000), NOW), { short: 'now', long: 'Last seen just now' })
  assert.deepEqual(relativeSeen(new Date(NOW + 5 * MINUTE).toISOString(), NOW), {
    short: 'now',
    long: 'Last seen just now',
  })
})

check('nothing to say produces nothing, not invented copy', () => {
  assert.deepEqual(relativeSeen(null, NOW), { short: '', long: '' })
  assert.deepEqual(relativeSeen(undefined, NOW), { short: '', long: '' })
  assert.deepEqual(relativeSeen('yesterday', NOW), { short: '', long: '' })
})

check('a Date is accepted wherever epoch ms is', () => {
  assert.equal(relativeSeen(ago(3 * HOUR), new Date(NOW)).short, '3h')
  const rows = mergeMachines({ self: { name: 'desk', os: null }, peers: [], devices: [], connections: [], now: new Date(NOW) })
  assert.equal(rows[0].isSelf, true)
})

if (failures > 0) {
  console.error(`${failures} test(s) failed`)
  process.exit(1)
}
console.log('tailnet-machines: ok')
