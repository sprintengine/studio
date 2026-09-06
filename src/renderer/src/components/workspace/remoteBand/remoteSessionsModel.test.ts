import assert from 'node:assert/strict'

import type {
  FleetBrowse,
  FleetConnection,
  FleetLiveAttachment,
  FleetMachineReachability,
  FleetTerminal,
} from '../../../../../shared/tailnet-fleet'
import type { Workspace } from '../../../types/workspace'
import { attachedWorkspaceFor, buildRemoteBand, shouldBrowse } from './remoteSessionsModel'

// The Remote band's rules (remote-sessions-in-the-sidebar), DOM-free.

const air: FleetConnection = {
  id: 'c1',
  machineName: 'dev-macbook-air',
  endpoint: '100.64.0.5:8471',
  deviceId: 'tnd_1',
  deviceName: 'mini',
  scopes: ['workspace:read', 'terminal:control'],
  pairedAt: '2026-09-05T00:00:00.000Z',
  lastConnectedAt: null,
  pairedVia: 'request',
}
const studio: FleetConnection = { ...air, id: 'c2', machineName: 'studio', endpoint: '100.64.0.9:8471' }

const terminal = (over: Partial<FleetTerminal>): FleetTerminal => ({
  sessionId: 's1',
  kind: 'agent',
  workspaceId: 'rw1',
  agentName: 'Ada',
  cli: 'claude-code',
  cwd: '/Users/air/relay',
  processAlive: true,
  suspended: false,
  phase: 'working',
  workspaceName: 'relay',
  git: { branch: 'agent/fix', additions: 12, deletions: 3, changedFiles: 2, scope: 'worktree' },
  ...over,
})

const browse = (over: Partial<FleetBrowse>): FleetBrowse => ({
  connectionId: 'c1',
  reachable: true,
  unreachableReason: null,
  unauthorized: false,
  scopes: air.scopes,
  terminalAccess: 'control',
  workspaces: [
    {
      id: 'rw1',
      name: 'relay',
      mode: 'standard',
      folderPath: '/Users/air/relay',
      repository: { canonicalKey: 'github.com/acme/relay', remoteUrl: 'git@github.com:acme/relay.git', name: 'relay' },
    },
  ],
  terminals: [],
  gaps: [],
  ...over,
})

const workspace = (id: string, extra: Record<string, unknown>): Workspace =>
  ({ id, name: id, mode: 'standard', folderPath: null, ...extra }) as unknown as Workspace

const fleetLayout = (connectionId: string, remoteSessionId: string) => ({
  layout: {
    type: 'tabset',
    children: [{ type: 'tab', component: 'fleet-terminal', config: { connectionId, machineName: 'x', remoteSessionId } }],
  },
})

// ── shouldBrowse ─────────────────────────────────────────────────────────
const reach = (over: Partial<FleetMachineReachability>): FleetMachineReachability => ({
  connectionId: 'c1',
  machineName: 'air',
  checking: false,
  reachable: false,
  unauthorized: false,
  checkedAt: 1,
  lastReachedAt: null,
  detail: null,
  ...over,
})
assert.equal(shouldBrowse(undefined), true, 'a machine main has not reported on gets its one read')
assert.equal(shouldBrowse(reach({ checkedAt: null, checking: true })), true, 'never checked: read rather than wait')
assert.equal(shouldBrowse(reach({ reachable: true })), true)
assert.equal(shouldBrowse(reach({ reachable: false })), false, 'asleep is never dialled')
assert.equal(shouldBrowse(reach({ reachable: true, unauthorized: true })), false, 'revoked is never dialled')

// ── attachedWorkspaceFor ─────────────────────────────────────────────────
const stamped = workspace('w1', { remoteOrigin: { connectionId: 'c1', machineName: 'air', workspaceId: 'rw1', workspaceName: 'relay', workspaceRoot: null, sessionId: 's1' } })
const legacy = workspace('w2', { remoteOrigin: { connectionId: 'c1', machineName: 'air', workspaceId: 'rw1', workspaceName: 'relay', workspaceRoot: null }, layoutModel: fleetLayout('c1', 's2') })
const local = workspace('w3', { folderPath: '/proj' })
assert.equal(attachedWorkspaceFor([local, legacy, stamped], 'c1', 's1')?.id, 'w1', 'matched by the stamped session id')
assert.equal(attachedWorkspaceFor([local, legacy, stamped], 'c1', 's2')?.id, 'w2', 'a row born before the stamp is matched by its pane')
assert.equal(attachedWorkspaceFor([local, legacy, stamped], 'c2', 's1'), null, 'the same session id on another machine is not a match')

// ── buildRemoteBand ──────────────────────────────────────────────────────
const attachments = new Map<string, FleetLiveAttachment>()
const reachability = new Map<string, FleetMachineReachability>([['c1', reach({ reachable: true })]])

const answered = browse({
  terminals: [
    terminal({ sessionId: 'sh', kind: 'terminal', agentName: null, cli: null, git: null, workspaceName: null }),
    terminal({ sessionId: 's3', agentName: 'Bea', suspended: true }),
    terminal({ sessionId: 's1' }),
    terminal({ sessionId: 'gone', agentName: 'Cy', processAlive: false }),
  ],
})
const band = buildRemoteBand({
  connections: [studio, air],
  browses: new Map([['c1', { browse: answered, loading: false, error: null, at: 1 }]]),
  attachments,
  reachability,
  workspaces: [local, stamped],
})
assert.deepEqual(band.map((group) => group.machineName), ['dev-macbook-air', 'studio'], 'machines in name order')
const airGroup = band[0]!
assert.deepEqual(airGroup.rows.map((row) => row.sessionId), ['s1', 's3', 'sh'], 'agents first, running before paused, then the shell; an exited pty is not a row')
const ada = airGroup.rows[0]!
assert.equal(ada.title, 'Ada')
assert.equal(ada.branch, 'agent/fix')
assert.equal(ada.additions, 12)
assert.equal(ada.diffScope, 'worktree')
assert.equal(ada.workspaceName, 'relay')
assert.equal(ada.workspaceRoot, '/Users/air/relay', 'the folder comes from the browse\'s workspace list')
assert.equal(ada.repository?.name, 'relay')
assert.equal(ada.attachedWorkspaceId, 'w1', 'the stamped workspace is this row')
assert.equal(airGroup.rows[2]!.title, 'Terminal')
assert.equal(airGroup.rows[2]!.workspaceName, 'relay', 'a shell with no name of its own takes its workspace\'s')
assert.deepEqual(airGroup.parked, [], 'a remote-born row whose session is listed is not parked as well')
assert.equal(airGroup.stale, false)
assert.equal(airGroup.phase?.phase, 'reachable')

const studioGroup = band[1]!
assert.deepEqual(studioGroup.rows, [], 'a machine not yet read has no rows')
assert.equal(studioGroup.notice, null)
assert.equal(studioGroup.phase?.phase, 'paired', 'and no check yet: paired is all that is known')

// A machine that went quiet keeps its rows, dimmed, and a remote-born row
// whose session it no longer lists is parked under it.
const quiet = buildRemoteBand({
  connections: [air],
  browses: new Map([['c1', { browse: browse({ terminals: [terminal({ sessionId: 's9', agentName: 'Zed' })] }), loading: false, error: 'Not answering.', at: 2 }]]),
  attachments,
  reachability: new Map([['c1', reach({ reachable: false, detail: 'timed out' })]]),
  workspaces: [stamped],
})
assert.equal(quiet[0]!.stale, true, 'rows from an earlier read on a machine that is not answering are stale')
assert.deepEqual(quiet[0]!.rows.map((row) => row.title), ['Zed'])
assert.deepEqual(quiet[0]!.parked.map((entry) => entry.id), ['w1'], 'the row born there stays, parked')
assert.equal(quiet[0]!.phase?.phase, 'unreachable')

// A pairing granted no terminal scope says so in place of rows.
const gapped = buildRemoteBand({
  connections: [air],
  browses: new Map([['c1', { browse: browse({ gaps: [{ part: 'terminals', code: 'scope_required', message: 'This pairing may not see that machine\'s terminals.' }] }), loading: false, error: null, at: 3 }]]),
  attachments,
  reachability,
  workspaces: [],
})
assert.match(gapped[0]!.notice ?? '', /may not see/u)
assert.equal(gapped[0]!.stale, false)

// Revoked over there outranks every other notice.
const revoked = buildRemoteBand({
  connections: [air],
  browses: new Map([['c1', { browse: browse({ unauthorized: true, gaps: [{ part: 'terminals', code: 'x', message: 'gap' }] }), loading: false, error: null, at: 3 }]]),
  attachments,
  reachability,
  workspaces: [],
})
assert.match(revoked[0]!.notice ?? '', /Settings → Remote/u)

// Rows born on a machine no longer paired keep a home, with nothing to ask.
const orphaned = buildRemoteBand({
  connections: [],
  browses: new Map(),
  attachments,
  reachability: new Map(),
  workspaces: [stamped, local],
})
assert.equal(orphaned.length, 1)
assert.equal(orphaned[0]!.connectionId, null)
assert.equal(orphaned[0]!.machineName, 'air')
assert.equal(orphaned[0]!.phase, null)
assert.deepEqual(orphaned[0]!.parked.map((entry) => entry.id), ['w1'])

console.log('remote sessions model tests passed')
