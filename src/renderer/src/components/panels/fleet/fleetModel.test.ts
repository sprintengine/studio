import assert from 'node:assert/strict'

import type { FleetBrowse, FleetConnection, FleetTerminal } from '../../../../../shared/tailnet-fleet'
import {
  fleetBrowseView,
  fleetConnectionSummary,
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
}

const terminal: FleetTerminal = {
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

// A scope gap is shown BESIDE what did load, never instead of it: a pairing
// granted terminals alone still sees its terminals.
const partial = fleetBrowseView(
  browse({
    terminals: [terminal],
    gaps: [{ part: 'workspaces', code: 'scope_required', message: 'This pairing may not read that machine\'s workspaces.' }],
  }),
  false
)
assert.equal(partial.emptyMessage, null)
assert.equal(partial.terminals.length, 1)
assert.deepEqual(partial.gapMessages, ["This pairing may not read that machine's workspaces."])

// With nothing readable at all, the gap becomes the message — never a bare
// "nothing here", which would state something false about the other machine.
const blocked = fleetBrowseView(
  browse({ gaps: [{ part: 'terminals', code: 'scope_required', message: 'This pairing may not see that machine\'s terminals.' }] }),
  false
)
assert.match(blocked.emptyMessage ?? '', /may not see/u)

// Genuinely empty says so in its own words.
assert.match(fleetBrowseView(browse(), false).emptyMessage ?? '', /no workspaces open/u)

// Unreachable reports the reason it was given, and revocation is flagged as the
// one failure that re-pairing fixes.
const revoked = fleetBrowseView(
  browse({ reachable: false, unauthorized: true, unreachableReason: 'That machine no longer accepts this pairing.' }),
  false
)
assert.equal(revoked.needsRepair, true)
assert.equal(revoked.emptyMessage, 'That machine no longer accepts this pairing.')
assert.equal(fleetBrowseView(null, true).emptyMessage, 'Reading that machine.')

// Paused and exited are separate answers: a paused agent's screen is real and
// its process is not.
assert.deepEqual(fleetTerminalStatus({ ...terminal, suspended: true }), { label: 'Paused', tone: 'neutral' })
assert.deepEqual(fleetTerminalStatus({ ...terminal, processAlive: false }), { label: 'Exited', tone: 'neutral' })
assert.deepEqual(fleetTerminalStatus({ ...terminal, phase: 'awaiting_input' }), { label: 'awaiting input', tone: 'good' })
assert.deepEqual(fleetTerminalStatus(terminal), { label: 'Running', tone: 'good' })

assert.equal(fleetTerminalTitle(terminal), 'Ada')
assert.equal(fleetTerminalTitle({ ...terminal, agentName: null }), 'Agent')
assert.equal(fleetTerminalTitle({ ...terminal, agentName: null, kind: 'terminal' }), 'Terminal')

// The machine row states the grant a person is about to rely on, and does not
// claim contact it has not had.
assert.match(fleetConnectionSummary(connection, (value) => value), /terminals: control/u)
assert.match(fleetConnectionSummary(connection, (value) => value), /Not reached yet/u)
assert.match(
  fleetConnectionSummary({ ...connection, scopes: ['terminal:observe'] }, (value) => value),
  /watch only/u
)
assert.match(
  fleetConnectionSummary({ ...connection, scopes: ['workspace:read'] }, (value) => value),
  /no terminal access/u
)

console.log('fleet model contracts ok')
