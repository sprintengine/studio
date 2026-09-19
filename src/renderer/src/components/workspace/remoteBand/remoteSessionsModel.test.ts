import assert from 'node:assert/strict'

import type {
  FleetBrowse,
  FleetConnection,
  FleetLiveAttachment,
  FleetMachineReachability,
  FleetTerminal,
} from '../../../../../shared/tailnet-fleet'
import type { Workspace } from '../../../types/workspace'
import {
  attachedConversations,
  attachedWorkspaceFor,
  buildRemoteBand,
  conversationsOf,
  remoteConversationTitle,
  remoteLinkStateOf,
  remoteWorkspaceName,
  shouldBrowse,
  unattachedConversations,
} from './remoteSessionsModel'
import { test } from 'vitest'

test('remoteSessionsModel', async () => {
  // The rules behind the sidebar's remote rows, DOM-free.

  const air: FleetConnection = {
    id: 'c1',
    machineName: 'sam-macbook-air',
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
    phaseSince: 1_000,
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
        repository: {
          canonicalKey: 'github.com/acme/relay',
          remoteUrl: 'git@github.com:acme/relay.git',
          name: 'relay',
        },
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
      children: [
        { type: 'tab', component: 'fleet-terminal', config: { connectionId, machineName: 'x', remoteSessionId } },
      ],
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
  const stamped = workspace('w1', {
    remoteOrigin: {
      connectionId: 'c1',
      machineName: 'air',
      workspaceId: 'rw1',
      workspaceName: 'relay',
      workspaceRoot: null,
      sessionId: 's1',
    },
  })
  const legacy = workspace('w2', {
    remoteOrigin: {
      connectionId: 'c1',
      machineName: 'air',
      workspaceId: 'rw1',
      workspaceName: 'relay',
      workspaceRoot: null,
    },
    layoutModel: fleetLayout('c1', 's2'),
  })
  const local = workspace('w3', { folderPath: '/proj' })
  assert.equal(
    attachedWorkspaceFor([local, legacy, stamped], 'c1', 's1')?.id,
    'w1',
    'matched by the stamped session id',
  )
  assert.equal(
    attachedWorkspaceFor([local, legacy, stamped], 'c1', 's2')?.id,
    'w2',
    'a row born before the stamp is matched by its pane',
  )
  assert.equal(
    attachedWorkspaceFor([local, legacy, stamped], 'c2', 's1'),
    null,
    'the same session id on another machine is not a match',
  )

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
  assert.deepEqual(
    band.map((group) => group.machineName),
    ['sam-macbook-air', 'studio'],
    'machines in name order',
  )
  const airGroup = band[0]!
  // Conversations only (owner ruling 2026-09-05): a plain shell is not a row,
  // nor is an exited pty; a paused agent still is, last.
  assert.deepEqual(
    airGroup.rows.map((row) => row.sessionId),
    ['s1', 's3'],
    'agents, working before paused; the shell and the exited pty are not rows',
  )
  const ada = airGroup.rows[0]!
  assert.equal(ada.title, 'Ada')
  assert.equal(ada.activity, 'working')
  assert.equal(ada.since, 1_000, 'how long it has been working rides the row')
  assert.equal(airGroup.rows[1]!.activity, 'paused')
  assert.equal(ada.branch, 'agent/fix')
  assert.equal(ada.additions, 12)
  assert.equal(ada.diffScope, 'worktree')
  assert.equal(ada.workspaceName, 'relay')
  assert.equal(ada.workspaceRoot, '/Users/air/relay', "the folder comes from the browse's workspace list")
  assert.equal(ada.repository?.name, 'relay')
  assert.equal(ada.attachedWorkspaceId, 'w1', 'the stamped workspace is this row')
  assert.deepEqual(airGroup.parked, [], 'a remote-born row whose session is listed is not parked as well')
  assert.equal(airGroup.stale, false)
  assert.equal(airGroup.phase?.phase, 'reachable')

  const studioGroup = band[1]!
  assert.deepEqual(studioGroup.rows, [], 'a machine not yet read has no rows')
  assert.equal(studioGroup.phase?.phase, 'paired', 'and no check yet: paired is all that is known')

  // A machine that went quiet keeps its rows, dimmed, and a remote-born row
  // whose session it no longer lists is parked under it.
  const quiet = buildRemoteBand({
    connections: [air],
    browses: new Map([
      [
        'c1',
        {
          browse: browse({ terminals: [terminal({ sessionId: 's9', agentName: 'Zed' })] }),
          loading: false,
          error: 'Not answering.',
          at: 2,
        },
      ],
    ]),
    attachments,
    reachability: new Map([['c1', reach({ reachable: false, detail: 'timed out' })]]),
    workspaces: [stamped],
  })
  assert.equal(quiet[0]!.stale, true, 'rows from an earlier read on a machine that is not answering are stale')
  assert.deepEqual(
    quiet[0]!.rows.map((row) => row.title),
    ['Zed'],
  )
  assert.deepEqual(
    quiet[0]!.parked.map((entry) => entry.id),
    ['w1'],
    'the row born there stays, parked',
  )
  assert.equal(quiet[0]!.phase?.phase, 'unreachable')
  // No notices (owner ruling 2026-09-05): a scope gap or a revocation is not a
  // sidebar sentence. The band lists conversations and nothing else.
  const gapped = buildRemoteBand({
    connections: [air],
    browses: new Map([
      [
        'c1',
        {
          browse: browse({
            gaps: [
              {
                part: 'terminals',
                code: 'scope_required',
                message: "This pairing may not see that machine's terminals.",
              },
            ],
          }),
          loading: false,
          error: null,
          at: 3,
        },
      ],
    ]),
    attachments,
    reachability,
    workspaces: [],
  })
  assert.deepEqual(gapped[0]!.rows, [])
  assert.equal(gapped[0]!.stale, false)
  assert.ok(!('notice' in gapped[0]!), 'the band carries no sentence for a machine with nothing to open')

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
  assert.deepEqual(
    orphaned[0]!.parked.map((entry) => entry.id),
    ['w1'],
  )

  // ── conversationsOf ──────────────────────────────────────────────────────
  // A row is a CONVERSATION, not a session (owner, 2026-09-11). Three agents in
  // one remote workspace are one row titled with the chat, carrying three lines.
  const busy = buildRemoteBand({
    connections: [air],
    browses: new Map([
      [
        'c1',
        {
          browse: browse({
            terminals: [
              terminal({ sessionId: 's1', agentName: 'Ada' }),
              terminal({ sessionId: 's2', agentName: 'Bea', phase: 'awaiting_input' }),
              terminal({ sessionId: 's3', agentName: 'Cy', suspended: true }),
            ],
          }),
          loading: false,
          error: null,
          at: 1,
        },
      ],
    ]),
    attachments,
    reachability,
    workspaces: [],
  })
  const chats = conversationsOf(busy[0]!)
  assert.equal(chats.length, 1, 'three agents in one remote workspace are one row')
  const relay = chats[0]!
  assert.equal(relay.title, 'relay', 'titled with the CHAT, never with an agent’s name')
  assert.deepEqual(
    relay.agents.map((row) => row.sessionId),
    ['s1', 's2', 's3'],
    'a line per agent, in activity order',
  )
  assert.deepEqual(
    relay.agents.map((row) => row.title),
    ['Ada', 'Bea', 'Cy'],
    'each line keeps its agent’s name',
  )
  assert.equal(relay.activity, 'working', 'the row reports the loudest of them')
  assert.equal(relay.workspaceRoot, '/Users/air/relay', 'and carries the folder it files under')
  assert.equal(relay.repository?.canonicalKey, 'github.com/acme/relay')

  // A remote that names no chat falls back to its lone agent — the best an older
  // build can do, and still better than a row with no name at all.
  const nameless = buildRemoteBand({
    connections: [air],
    browses: new Map([
      [
        'c1',
        {
          browse: browse({ terminals: [terminal({ workspaceName: null })], workspaces: [] }),
          loading: false,
          error: null,
          at: 1,
        },
      ],
    ]),
    attachments,
    reachability,
    workspaces: [],
  })
  assert.equal(conversationsOf(nameless[0]!)[0]!.title, 'Ada')

  // Sessions the remote filed under no workspace stand alone rather than pooling
  // into one fake chat.
  const loose = buildRemoteBand({
    connections: [air],
    browses: new Map([
      [
        'c1',
        {
          browse: browse({
            terminals: [
              terminal({ sessionId: 'a', workspaceId: null, workspaceName: null, agentName: 'One' }),
              terminal({ sessionId: 'b', workspaceId: null, workspaceName: null, agentName: 'Two' }),
            ],
          }),
          loading: false,
          error: null,
          at: 1,
        },
      ],
    ]),
    attachments,
    reachability,
    workspaces: [],
  })
  assert.deepEqual(
    conversationsOf(loose[0]!)
      .map((entry) => entry.title)
      .sort(),
    ['One', 'Two'],
  )

  // ── unattachedConversations ──────────────────────────────────────────────
  // A chat a window here is already showing is NOT a row of its own: that window
  // is already a row of its project, and listing both is the same chat twice.
  assert.deepEqual(
    unattachedConversations(band, true, [local, stamped]).map((entry) => entry.title),
    [],
    'the only conversation on the Air is attached to w1, so it gets no second row',
  )
  assert.deepEqual(
    unattachedConversations(band, true, [local]).map((entry) => entry.title),
    ['relay'],
    'with no window holding it, the conversation is a row',
  )
  assert.deepEqual(
    unattachedConversations(band, false, [local]),
    [],
    'off the tailnet, nothing read from over there is drawn',
  )

  // ── attachedConversations ────────────────────────────────────────────────
  // The complement: the conversation each OPEN remote row is, so that row can
  // draw a line per agent instead of the one pane its own layout knows about.
  const openHere = attachedConversations(band, [local, stamped])
  assert.deepEqual([...openHere.keys()], ['w1'], 'the conversation w1 holds is keyed by w1')
  assert.deepEqual(
    openHere.get('w1')!.agents.map((agent) => agent.title),
    ['Ada', 'Bea'],
    'and carries every agent standing in it — w1 holds a pane onto one, the row draws both',
  )
  assert.equal(attachedConversations([], [local, stamped]).size, 0)
  // A LOCAL chat that happens to hold a pane onto the other machine is not a
  // remote conversation: it is a local chat with a visitor in it, and its own
  // agents' lines are not the other machine's to replace.
  const visiting = workspace('w9', { folderPath: '/proj', layoutModel: fleetLayout('c1', 's1') })
  assert.equal(
    buildRemoteBand({
      connections: [air],
      browses: new Map([['c1', { browse: answered, loading: false, error: null, at: 1 }]]),
      attachments,
      reachability,
      workspaces: [visiting],
    })
      .flatMap((group) => conversationsOf(group))
      .some((entry) => entry.attachedWorkspaceId === 'w9'),
    true,
    'the band still recognises the window showing that session',
  )
  assert.equal(
    attachedConversations(
      buildRemoteBand({
        connections: [air],
        browses: new Map([['c1', { browse: answered, loading: false, error: null, at: 1 }]]),
        attachments,
        reachability,
        workspaces: [visiting],
      }),
      [visiting],
    ).size,
    0,
    '…but it is not handed the lines, because it is not a remote-born row',
  )
  // A machine running three agents in one chat: the row that opened ONE of them
  // still draws all three — the bug the owner reported on 2026-09-13, where
  // opening a remote chat made it say less than it did unopened.
  const crowd = buildRemoteBand({
    connections: [air],
    browses: new Map([
      [
        'c1',
        {
          browse: browse({
            terminals: [
              terminal({ sessionId: 's1', agentName: 'Ada' }),
              terminal({ sessionId: 's2', agentName: 'Grace', phase: 'awaiting_input' }),
              terminal({ sessionId: 's3', agentName: 'Alan', phase: null }),
            ],
          }),
          loading: false,
          error: null,
          at: 1,
        },
      ],
    ]),
    attachments,
    reachability,
    workspaces: [stamped],
  })
  assert.deepEqual(
    attachedConversations(crowd, [stamped])
      .get('w1')!
      .agents.map((agent) => agent.title),
    ['Ada', 'Grace', 'Alan'],
    'one pane onto one agent, but the row knows all three — in activity order',
  )

  // ── remoteLinkStateOf ────────────────────────────────────────────────────
  // Three answers, not two: "we have not been told" must never read as
  // "disconnected", or a host without the tailnet bridge empties the sidebar.
  assert.equal(remoteLinkStateOf(null), 'unknown')
  assert.equal(remoteLinkStateOf(undefined), 'unknown')
  assert.equal(remoteLinkStateOf({ tailnetAddress: null }), 'down', 'Tailscale is not up on this machine')
  assert.equal(remoteLinkStateOf({ tailnetAddress: '100.64.0.5' }), 'up')

  // ── remoteWorkspaceName / remoteConversationTitle ────────────────────────
  // The CHAT's name, never the agent's (owner, 2026-09-13).
  assert.equal(remoteWorkspaceName('Tara Boyle', 'multicode'), 'multicode')
  assert.equal(
    remoteWorkspaceName('Tara Boyle', '  '),
    'Tara Boyle',
    'a remote with no name to give falls back to the agent',
  )
  assert.equal(remoteWorkspaceName('Tara Boyle', null), 'Tara Boyle')

  const titled = (name: string, workspaceName: string | undefined) =>
    remoteConversationTitle({ name, remoteOrigin: workspaceName === undefined ? null : ({ workspaceName } as never) })
  assert.equal(titled('Tara Boyle · multicode', 'multicode'), 'multicode', 'a row stored under the old rule is rescued')
  assert.equal(titled('multicode', 'multicode'), 'multicode', 'a row already named for its chat is left alone')
  assert.equal(titled('Ship the release', 'multicode'), 'Ship the release', 'a name a person chose is theirs')
  assert.equal(
    titled(' · multicode', 'multicode'),
    ' · multicode',
    'no agent in front of it: not the old rule, not rewritten',
  )
  assert.equal(titled('Tara Boyle · multicode', undefined), 'Tara Boyle · multicode', 'a local row is never touched')
  assert.equal(titled('Tara Boyle', ''), 'Tara Boyle', 'a remote that never named its chat leaves the name as it is')

  console.log('remote sessions model tests passed')
})
