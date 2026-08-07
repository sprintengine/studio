import assert from 'node:assert/strict'

import type { TailnetRemoteStatus } from '../../../../shared/tailnet'
import type { TailnetPeer, TailnetPeerScan } from '../../../../shared/tailnet-peers'
import {
  deviceSummary,
  outstandingPairingNote,
  pairingExpiry,
  peerListView,
  peerStatus,
  tailnetReadiness,
} from './tailnetPanelModel'

// The Remote (tailnet) panel's rules, tested where they live.
//
// The acceptance criterion these exist for: with Tailscale absent or down, the
// panel says so plainly and the feature cannot be half-enabled.

let failures = 0

function check(name: string, run: () => void): void {
  try {
    run()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures++
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

function status(overrides: Partial<TailnetRemoteStatus> = {}): TailnetRemoteStatus {
  return {
    enabled: false,
    running: false,
    endpoint: null,
    port: 8471,
    tailnetAddress: '100.64.0.1',
    lastError: null,
    devices: [],
    pairing: null,
    ...overrides,
  }
}

function peer(overrides: Partial<TailnetPeer> = {}): TailnetPeer {
  return {
    id: 'node-1',
    hostName: 'studio-laptop',
    dnsName: 'studio-laptop.tail1234.ts.net',
    address: '100.64.0.2',
    os: 'linux',
    online: true,
    isSelf: false,
    studio: null,
    ...overrides,
  }
}

check('with no Tailscale the switch cannot be turned on, and the panel says why', () => {
  const readiness = tailnetReadiness(status({ tailnetAddress: null }))
  assert.equal(readiness.state, 'no-tailnet')
  assert.equal(readiness.canTurnOn, false, 'the feature must not be half-enabled')
  assert.equal(readiness.canPair, false)
  // Plainly: it names Tailscale and what to do, with no jargon and no code.
  assert.match(readiness.detail, /Tailscale/u)
  assert.match(readiness.detail, /Install Tailscale and sign in/u)
})

check('Tailscale going down under an enabled listener is an error, not a quiet Off', () => {
  const readiness = tailnetReadiness(
    status({ enabled: true, tailnetAddress: null, lastError: 'no Tailscale interface was found' })
  )
  assert.equal(readiness.state, 'no-tailnet')
  assert.equal(readiness.tone, 'error')
  assert.equal(readiness.canPair, false, 'a pairing code would point at nothing')
  assert.match(readiness.detail, /nothing is listening/u)
  // Turning it back OFF must stay possible — only turning it ON is refused.
  assert.equal(readiness.canTurnOn, false)
})

check('off, failed-to-start, and listening are three distinct states', () => {
  const off = tailnetReadiness(status())
  assert.equal(off.state, 'off')
  assert.equal(off.canTurnOn, true)
  assert.equal(off.canPair, false)

  const failed = tailnetReadiness(status({ enabled: true, running: false, lastError: 'port 8471 is in use' }))
  assert.equal(failed.state, 'not-listening')
  assert.equal(failed.tone, 'error')
  assert.equal(failed.detail, 'port 8471 is in use', 'the real reason, not a generic one')
  assert.equal(failed.canPair, false)

  const listening = tailnetReadiness(
    status({ enabled: true, running: true, endpoint: '100.64.0.1:8471' })
  )
  assert.equal(listening.state, 'listening')
  assert.equal(listening.tone, 'good')
  assert.equal(listening.canPair, true)
  assert.match(listening.detail, /100\.64\.0\.1:8471/u)
})

check('enabled but running with no endpoint is still not pairable', () => {
  // Defensive: a status claiming to run with nowhere to reach it cannot mint a
  // usable code, so it is treated as not listening rather than trusted.
  const readiness = tailnetReadiness(status({ enabled: true, running: true, endpoint: null }))
  assert.equal(readiness.state, 'not-listening')
  assert.equal(readiness.canPair, false)
})

check('a pairing code’s remaining life reads in minutes, then seconds, then expired', () => {
  const now = Date.parse('2026-08-07T12:00:00Z')
  assert.equal(pairingExpiry('2026-08-07T12:09:30Z', now), 'Expires in 9 min')
  assert.equal(pairingExpiry('2026-08-07T12:00:45Z', now), 'Expires in 45s')
  assert.equal(pairingExpiry('2026-08-07T11:59:00Z', now), 'Expired')
  assert.equal(pairingExpiry('not a date', now), 'Expired')
})

check('a code the panel cannot re-show is still admitted to, not hidden', () => {
  // Reopening Settings loses the code (it is returned once and never re-read),
  // but the offer is still live in the main process. Hiding it would leave a
  // credential nobody can cancel; pretending none exists would put a fresh
  // "Pair a device" over a code someone is carrying to the other machine.
  const now = Date.parse('2026-08-07T12:00:00Z')
  const note = outstandingPairingNote(
    { scopes: ['sprint:read', 'sprint:operate'], expiresAt: '2026-08-07T12:07:00Z' },
    now
  )
  assert.match(note, /already active/u)
  assert.match(note, /expires in 7 min/u)
  assert.match(note, /2 scopes/u)
  assert.match(note, /only be shown once/u)
})

check('a device that has never connected says so rather than showing a blank', () => {
  const format = (value: string): string => `[${value}]`
  assert.equal(
    deviceSummary(
      { id: 'd1', name: 'Laptop', scopes: ['sprint:read'], createdAt: 'x', lastSeenAt: null, lastPeerNode: null },
      format
    ),
    '1 scopes · Never connected'
  )
  assert.equal(
    deviceSummary(
      {
        id: 'd2',
        name: 'Laptop',
        scopes: ['sprint:read', 'sprint:operate'],
        createdAt: 'x',
        lastSeenAt: '2026-08-07T10:00:00Z',
        lastPeerNode: 'laptop.tail1234.ts.net',
      },
      format
    ),
    '2 scopes · Last seen [2026-08-07T10:00:00Z] from laptop.tail1234.ts.net'
  )
})

check('each empty peer list gets the sentence that names its own fix', () => {
  const scan = (overrides: Partial<TailnetPeerScan> = {}): TailnetPeerScan => ({
    tailscaleAvailable: true,
    unavailableReason: null,
    probedPort: 8471,
    peers: [],
    ...overrides,
  })

  assert.match(peerListView(null, true).emptyMessage ?? '', /Looking for machines/u)
  assert.match(peerListView(null, false).emptyMessage ?? '', /Scan to see/u)
  assert.equal(
    peerListView(scan({ tailscaleAvailable: false, unavailableReason: 'Tailscale did not answer.' }), false)
      .emptyMessage,
    'Tailscale did not answer.',
    'the scanner’s own reason is passed through, not replaced'
  )
  assert.match(
    peerListView(scan({ peers: [peer({ isSelf: true })] }), false).emptyMessage ?? '',
    /only machine on your tailnet/u
  )
})

check('this machine is context, never a target', () => {
  const view = peerListView(
    {
      tailscaleAvailable: true,
      unavailableReason: null,
      probedPort: 8471,
      peers: [
        peer({ id: 'self', hostName: 'me', isSelf: true }),
        peer({ id: 'a', hostName: 'laptop', studio: { product: 'x', transportVersion: 1, protocolVersions: [] } }),
        peer({ id: 'b', hostName: 'nas' }),
      ],
    },
    false
  )
  assert.equal(view.emptyMessage, null)
  assert.deepEqual(view.peers.map((entry) => entry.hostName), ['laptop', 'nas'])
  assert.equal(view.studioCount, 1)
})

check('a peer’s label states what we know, never a guess', () => {
  assert.deepEqual(
    peerStatus(peer({ studio: { product: 'x', transportVersion: 1, protocolVersions: [] } }), 8471),
    { label: 'Studio on port 8471', tone: 'good' }
  )
  assert.deepEqual(peerStatus(peer({ online: false }), 8471), { label: 'Offline', tone: 'neutral' })
  // Online and silent could be a listener that is off, one on another port, or
  // a machine not running Studio at all. The label does not pick one.
  assert.deepEqual(peerStatus(peer(), 8471), {
    label: 'No Studio answering on port 8471',
    tone: 'neutral',
  })
})

if (failures > 0) {
  console.error(`${failures} test(s) failed`)
  process.exit(1)
}
console.log('tailnet panel model tests passed')
