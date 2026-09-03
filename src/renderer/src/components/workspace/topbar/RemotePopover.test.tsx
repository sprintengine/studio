import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import { RemotePopover, remoteGlyphState } from './RemotePopover'
import type { TailnetPresence } from './useTailnetPresence'
import type { TailnetRemoteStatus } from '../../../../../shared/tailnet'
import type { FleetConnection } from '../../../../../shared/tailnet-fleet'

// The Remote glyph's derivation and surface (remote-sessions-ux /
// remote-glyph-topbar). The push plumbing is pinned main-side
// (tailnet-live-events); what this file pins is what the chrome SAYS.

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

function status(overrides: Partial<TailnetRemoteStatus> = {}): TailnetRemoteStatus {
  return {
    enabled: true,
    running: true,
    endpoint: '100.91.70.66:8471',
    port: 8471,
    tailnetAddress: '100.91.70.66',
    lastError: null,
    devices: [],
    pairing: null,
    pairRequests: [],
    ...overrides,
  }
}

function connection(overrides: Partial<FleetConnection> = {}): FleetConnection {
  return {
    id: 'conn-1',
    machineName: 'Conal’s MacBook Air',
    endpoint: '100.106.119.1:8471',
    deviceId: 'tnd_x',
    deviceName: 'mini',
    scopes: ['workspace:read'],
    pairedAt: new Date(0).toISOString(),
    lastConnectedAt: null,
    ...overrides,
  }
}

function presence(overrides: Partial<TailnetPresence> = {}): TailnetPresence {
  return {
    status: status(),
    live: { devices: [] },
    fleet: [],
    fleetLiveSessions: new Map(),
    ...overrides,
  }
}

run('the glyph is absent while the feature is off and nothing is paired — not present-but-empty', () => {
  assert.equal(
    remoteGlyphState(presence({ status: status({ enabled: false, running: false, endpoint: null }) })).visible,
    false
  )
  assert.equal(remoteGlyphState(presence({ status: null })).visible, false)
})

run('a paired fleet machine earns the glyph even with the inbound listener off', () => {
  const state = remoteGlyphState(
    presence({ status: status({ enabled: false, running: false, endpoint: null }), fleet: [connection()] })
  )
  assert.equal(state.visible, true)
})

run('driving = a device attached to a terminal HERE; connected covers both directions', () => {
  const driving = remoteGlyphState(
    presence({
      live: {
        devices: [
          { deviceId: 'd', deviceName: 'Air', connected: true, attachedTerminalSessions: ['t1'], lastActivityAt: 1 },
        ],
      },
    })
  )
  assert.equal(driving.driving, true)
  assert.equal(driving.connected, true)
  const outbound = remoteGlyphState(
    presence({ fleet: [connection()], fleetLiveSessions: new Map([['conn-1', new Set(['s1'])]]) })
  )
  assert.equal(outbound.driving, false)
  assert.equal(outbound.connected, true)
})

run('the popover names the endpoint and driving device, and hosts the ACTING pair-request card', () => {
  const markup = renderToStaticMarkup(
    <RemotePopover
      presence={presence({
        status: status({
          pairRequests: [
            {
              id: 'req1',
              deviceName: 'macbook-air',
              peerNode: 'dev-macbook-air',
              peerAddress: '100.106.119.1',
              comparisonCode: '481972',
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
            },
          ],
        }),
        live: {
          devices: [
            {
              deviceId: 'd1',
              deviceName: 'Sprint Engine Android',
              connected: true,
              attachedTerminalSessions: ['agent-standup'],
              lastActivityAt: Date.now(),
            },
          ],
        },
        fleet: [connection()],
        fleetLiveSessions: new Map([['conn-1', new Set(['s1', 's2'])]]),
      })}
      onOpenFleet={() => {}}
      onOpenRemoteSettings={() => {}}
    />
  )
  assert.match(markup, /100\.91\.70\.66:8471/, 'the listener endpoint reads in mono')
  assert.match(markup, /Sprint Engine Android/)
  assert.match(markup, /driving/)
  assert.match(markup, /agent-standup/, 'the driven session is NAMED, not counted')
  assert.match(markup, /Revoke/)
  assert.match(markup, /dev-macbook-air/)
  assert.match(markup, /asks to pair/)
  // This IS the acting surface (incoming-pair-request-prompt): the code
  // renders large for the human comparison, the scopes are chosen here, and
  // Allow/Decline answer through the same IPC Settings uses.
  assert.match(markup, /481972/)
  assert.match(markup, /Terminals — control/)
  assert.match(markup, /arbitrary shell/)
  assert.match(markup, /Allow/)
  assert.match(markup, /Decline/)
  assert.doesNotMatch(markup, /Review/, 'no pointer elsewhere — the card acts, right here')
  assert.match(markup, /Conal’s MacBook Air/)
  assert.match(markup, /2 terminals attached/)
  assert.match(markup, /Open Fleet/)
  assert.match(markup, /Remote settings/)
})

run('a quiet popover says so rather than rendering empty sections', () => {
  const markup = renderToStaticMarkup(
    <RemotePopover presence={presence()} onOpenFleet={null} onOpenRemoteSettings={() => {}} />
  )
  assert.match(markup, /No device is connected right now\./)
  assert.match(markup, /No machines paired\. Pair one from the Fleet\./)
  assert.doesNotMatch(markup, /Open Fleet/, 'no workspace to dock the Fleet into, no dead button')
})

if (failures > 0) {
  console.error(`RemotePopover.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('RemotePopover.test.tsx: ok')
