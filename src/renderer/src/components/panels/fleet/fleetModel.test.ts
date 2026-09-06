import assert from 'node:assert/strict'

import type { FleetTerminal } from '../../../../../shared/tailnet-fleet'
import {
  fleetInputState,
  fleetLinkBadge,
  fleetTerminalStatus,
  fleetTerminalTabName,
  fleetTerminalTitle,
} from './fleetModel'

const connection: FleetConnection = {
  id: 'tnc_1',
  machineName: 'mini',
  endpoint: '100.64.0.5:8787',
  deviceId: 'tnd_1',
  deviceName: 'laptop',
  scopes: ['workspace:read', 'terminal:control'],
  pairedAt: '2026-08-07T09:00:00.000Z',
  lastConnectedAt: null,
  pairedVia: 'link',
}

const terminal: FleetTerminal = {
  workspaceName: 'atlas',
  git: null,
  sessionId: 'agent-1',
  kind: 'agent',
  workspaceId: 'ws-1',
  agentName: 'Ada',
  cli: 'claude',
  cwd: '/repo',
  processAlive: true,
  suspended: false,
  phase: null,
}

const browse = (over: Partial<FleetBrowse> = {}): FleetBrowse => ({
  connectionId: 'tnc_1',
  reachable: true,
  unreachableReason: null,
  unauthorized: false,
  scopes: ['workspace:read', 'terminal:control'],
  terminalAccess: 'control',
  workspaces: [],
  terminals: [],
  gaps: [],
  ...over,
})

// A watch-only pairing must LOOK watch-only before anything is typed. The
// listener drops an observe-scoped input frame anyway, so a pane that let a
// person type would be a pane that swallows their keystrokes silently.
for (const link of ['live', 'connecting', 'reconnecting', 'offline', 'closed'] as const) {
  const state = fleetInputState('observe', link)
  assert.equal(state.canType, false, `observe must never type (${link})`)
  assert.match(state.label ?? '', /Watch only/u)
}
assert.equal(fleetInputState('none', 'live').canType, false)

// Control types only while the link is actually up: keystrokes at a dead link
// belong to a screen state that no longer exists.
assert.equal(fleetInputState('control', 'live').canType, true)
assert.equal(fleetInputState('control', 'live').label, null)
assert.equal(fleetInputState('control', 'reconnecting').canType, false)
assert.match(fleetInputState('control', 'reconnecting').label ?? '', /not being sent/u)
assert.equal(fleetInputState('control', 'closed').canType, false)
assert.match(fleetInputState('control', 'closed').label ?? '', /ended/u)

// A machine that is not answering is not an error state — a laptop with its lid
// shut looks exactly like this, and the words say the pane is waiting, not broken.
assert.equal(fleetLinkBadge('offline', null).tone, 'neutral')
assert.match(fleetLinkBadge('offline', null).detail ?? '', /reconnects when it comes back/u)
assert.equal(fleetLinkBadge('reconnecting', null).tone, 'warn')
assert.equal(fleetLinkBadge('live', 'ignored').detail, null, 'a live link adds nothing to the pane')
// The server's own reason wins over ours when it sent one.
assert.equal(fleetLinkBadge('reconnecting', 'Wi-Fi went away.').detail, 'Wi-Fi went away.')

// The tab carries the machine name. Provenance is part of the pane's identity,
// not a tooltip: the same keystroke means different things on two machines.
assert.equal(fleetTerminalTabName('mini', 'Ada'), 'Ada · mini')

// Paused and exited are separate answers: a paused agent's screen is real and
// its process is not.
assert.deepEqual(fleetTerminalStatus({ ...terminal, suspended: true }), { label: 'Paused', tone: 'neutral' })
assert.deepEqual(fleetTerminalStatus({ ...terminal, processAlive: false }), { label: 'Exited', tone: 'neutral' })
assert.deepEqual(fleetTerminalStatus({ ...terminal, phase: 'awaiting_input' }), { label: 'awaiting input', tone: 'good' })
assert.deepEqual(fleetTerminalStatus(terminal), { label: 'Running', tone: 'good' })

assert.equal(fleetTerminalTitle(terminal), 'Ada')
assert.equal(fleetTerminalTitle({ ...terminal, agentName: null }), 'Agent')
assert.equal(fleetTerminalTitle({ ...terminal, agentName: null, kind: 'terminal' }), 'Terminal')
