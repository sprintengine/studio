import assert from 'node:assert/strict'

import {
  meshConversationPresence,
  meshConversationSessionId,
  type MeshBrowse,
  type MeshConnection,
  type MeshConversation,
  type MeshMachineReachability,
} from '../../../../../shared/tailnet-mesh'
import type { Workspace } from '../../../types/workspace'
import {
  attachedConversations,
  attachedWorkspaceFor,
  buildRemoteBand,
  conversationsOf,
  openSpecOfConversation,
  remoteConversationTitle,
  remoteLinkStateOf,
  remotePaneTabName,
  remoteWorkspaceName,
  shouldBrowse,
  unattachedConversations,
} from './remoteSessionsModel'
import { test } from 'vitest'

test('remoteSessionsModel', async () => {
  // The rules behind the sidebar's remote rows, DOM-free.

  const air: MeshConnection = {
    id: 'c1',
    machineName: 'sam-macbook-air',
    endpoint: '100.64.0.5:8471',
    deviceId: 'tnd_1',
    deviceName: 'mini',
    scopes: ['workspace:read', 'conversation:read'],
    pairedAt: '2026-09-05T00:00:00.000Z',
    lastConnectedAt: null,
    pairedVia: 'request',
  }
  const studio: MeshConnection = { ...air, id: 'c2', machineName: 'studio', endpoint: '100.64.0.9:8471' }

  const chat = (agentId: string, over: Partial<MeshConversation> = {}): MeshConversation => ({
    workspaceId: 'rw1',
    agentId,
    title: agentId,
    phase: 'running',
    updatedAt: 1_000,
    createdAt: 500,
    providerId: 'claude-agent',
    modelId: 'opus',
    turnCount: 1,
    lastSeq: 4,
    ...over,
  })
  const adaSession = meshConversationSessionId('rw1', 'ada')
  const beaSession = meshConversationSessionId('rw1', 'bea')

  const browse = (over: Partial<MeshBrowse>): MeshBrowse => ({
    connectionId: 'c1',
    reachable: true,
    unreachableReason: null,
    unauthorized: false,
    scopes: air.scopes,
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
    gaps: [],
    ...over,
  })

  const workspace = (id: string, extra: Record<string, unknown>): Workspace =>
    ({ id, name: id, mode: 'standard', folderPath: null, ...extra }) as unknown as Workspace

  const meshLayout = (connectionId: string, remoteAgentId: string) => ({
    layout: {
      type: 'tabset',
      children: [
        {
          type: 'tab',
          component: 'mesh-conversation',
          config: {
            connectionId,
            machineName: 'x',
            remoteWorkspaceId: 'rw1',
            remoteAgentId,
            remoteSessionId: meshConversationSessionId('rw1', remoteAgentId),
            title: remoteAgentId,
          },
        },
      ],
    },
  })

  // ── shouldBrowse ─────────────────────────────────────────────────────────
  const reach = (over: Partial<MeshMachineReachability>): MeshMachineReachability => ({
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
      sessionId: adaSession,
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
    layoutModel: meshLayout('c1', 'bea'),
  })
  const local = workspace('w3', { folderPath: '/proj' })
  assert.equal(
    attachedWorkspaceFor([local, legacy, stamped], 'c1', adaSession)?.id,
    'w1',
    'matched by the stamped session id',
  )
  assert.equal(
    attachedWorkspaceFor([local, legacy, stamped], 'c1', beaSession)?.id,
    'w2',
    'a row born before the stamp is matched by its pane',
  )
  assert.equal(
    attachedWorkspaceFor([local, legacy, stamped], 'c2', adaSession),
    null,
    'the same session id on another machine is not a match',
  )
  // A persisted remote terminal tab is a stale tab, not a remote pane: nothing
  // matches a session through it.
  const staleTab = workspace('w4', {
    layoutModel: {
      layout: {
        type: 'tabset',
        children: [
          {
            type: 'tab',
            component: 'mesh-terminal',
            config: { connectionId: 'c1', machineName: 'x', remoteSessionId: 's-old' },
          },
        ],
      },
    },
  })
  assert.equal(attachedWorkspaceFor([staleTab], 'c1', 's-old'), null, 'a stale mesh-terminal tab is ignored')

  // ── buildRemoteBand ──────────────────────────────────────────────────────
  const reachability = new Map<string, MeshMachineReachability>([['c1', reach({ reachable: true })]])

  const answered = {
    browse: browse({}),
    loading: false,
    error: null,
    at: 1,
    conversations: [
      chat('bea', { title: 'Bea', phase: 'completed', updatedAt: 2_000 }),
      chat('ada', { title: 'Ada', phase: 'running', updatedAt: 1_000 }),
    ],
  }
  const band = buildRemoteBand({
    connections: [studio, air],
    browses: new Map([['c1', answered]]),
    reachability,
    workspaces: [local, stamped],
  })
  assert.deepEqual(
    band.map((group) => group.machineName),
    ['sam-macbook-air', 'studio'],
    'machines in name order',
  )
  const airGroup = band[0]!
  assert.deepEqual(
    airGroup.rows.map((row) => row.sessionId),
    [adaSession, beaSession],
    'chats, working before idle',
  )
  const ada = airGroup.rows[0]!
  assert.equal(ada.title, 'Ada')
  assert.equal(ada.remoteAgentId, 'ada')
  assert.equal(ada.workspaceId, 'rw1')
  assert.equal(ada.activity, 'working')
  assert.equal(ada.since, 1_000, 'how long it has been working rides the row')
  assert.equal(airGroup.rows[1]!.activity, 'idle')
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
          browse: browse({}),
          loading: false,
          error: 'Not answering.',
          at: 2,
          conversations: [chat('zed', { title: 'Zed' })],
        },
      ],
    ]),
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
                part: 'workspaces',
                code: 'scope_required',
                message: "This pairing may not see that machine's workspaces.",
              },
            ],
          }),
          loading: false,
          error: null,
          at: 3,
        },
      ],
    ]),
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
  // A row is a CONVERSATION (owner, 2026-09-11): each chat is one row titled
  // with its own name, carrying its agent as the one line it draws — two chats
  // in one remote workspace are two rows.
  const chats = conversationsOf(airGroup)
  assert.deepEqual(
    chats.map((entry) => entry.title),
    ['Ada', 'Bea'],
    'one row per chat, in activity order',
  )
  const relay = chats[0]!
  assert.deepEqual(
    relay.agents.map((row) => row.sessionId),
    [adaSession],
    'a conversation carries its own agent',
  )
  assert.equal(relay.activity, 'working')
  assert.equal(relay.workspaceId, 'rw1')
  assert.equal(relay.workspaceRoot, '/Users/air/relay', 'and carries the folder it files under')
  assert.equal(relay.repository?.canonicalKey, 'github.com/acme/relay')
  assert.equal(relay.attachedWorkspaceId, 'w1')
  assert.notEqual(chats[0]!.key, chats[1]!.key, 'each chat is keyed on its own session')

  // ── unattachedConversations ──────────────────────────────────────────────
  // A chat a window here is already showing is NOT a row of its own: that window
  // is already a row of its project, and listing both is the same chat twice.
  assert.deepEqual(
    unattachedConversations(band, true, [local, stamped]).map((entry) => entry.title),
    ['Bea'],
    'Ada is attached to w1, so it gets no second row',
  )
  assert.deepEqual(
    unattachedConversations(band, true, [local]).map((entry) => entry.title),
    ['Ada', 'Bea'],
    'with no window holding it, the conversation is a row',
  )
  assert.deepEqual(
    unattachedConversations(band, false, [local]),
    [],
    'off the tailnet, nothing read from over there is drawn',
  )

  // ── attachedConversations ────────────────────────────────────────────────
  // The complement: the conversation each OPEN remote row is, so that row can
  // draw its agent's line from what the browse read.
  const openHere = attachedConversations(band, [local, stamped])
  assert.deepEqual([...openHere.keys()], ['w1'], 'the conversation w1 holds is keyed by w1')
  assert.deepEqual(
    openHere.get('w1')!.agents.map((agent) => agent.title),
    ['Ada'],
  )
  assert.equal(attachedConversations([], [local, stamped]).size, 0)
  // A LOCAL chat that happens to hold a pane onto the other machine is not a
  // remote conversation: it is a local chat with a visitor in it, and its own
  // agents' lines are not the other machine's to replace.
  const visiting = workspace('w9', { folderPath: '/proj', layoutModel: meshLayout('c1', 'ada') })
  const visitedBand = buildRemoteBand({
    connections: [air],
    browses: new Map([['c1', answered]]),
    reachability,
    workspaces: [visiting],
  })
  assert.equal(
    visitedBand.flatMap((group) => conversationsOf(group)).some((entry) => entry.attachedWorkspaceId === 'w9'),
    true,
    'the band still recognises the window showing that session',
  )
  assert.equal(
    attachedConversations(visitedBand, [visiting]).size,
    0,
    '…but it is not handed the lines, because it is not a remote-born row',
  )

  // ── remoteLinkStateOf ────────────────────────────────────────────────────
  // Three answers, not two: "we have not been told" must never read as
  // "disconnected", or a host without the tailnet bridge empties the sidebar.
  assert.equal(remoteLinkStateOf(null), 'unknown')
  assert.equal(remoteLinkStateOf(undefined), 'unknown')
  assert.equal(remoteLinkStateOf({ tailnetAddress: null }), 'down', 'Tailscale is not up on this machine')
  assert.equal(remoteLinkStateOf({ tailnetAddress: '100.64.0.5' }), 'up')

  // ── remotePaneTabName ────────────────────────────────────────────────────
  // The machine is part of a remote pane's name, never only a tooltip.
  assert.equal(remotePaneTabName('studio', 'Profile the importer'), 'Profile the importer · studio')

  // ── remoteWorkspaceName / remoteConversationTitle ────────────────────────
  // The CHAT's name, never the agent's (owner, 2026-09-13).
  assert.equal(remoteWorkspaceName('Tara Boyle', 'sprintengine'), 'sprintengine')
  assert.equal(
    remoteWorkspaceName('Tara Boyle', '  '),
    'Tara Boyle',
    'a remote with no name to give falls back to the agent',
  )
  assert.equal(remoteWorkspaceName('Tara Boyle', null), 'Tara Boyle')

  const titled = (name: string, workspaceName: string | undefined) =>
    remoteConversationTitle({ name, remoteOrigin: workspaceName === undefined ? null : ({ workspaceName } as never) })
  assert.equal(
    titled('Tara Boyle · sprintengine', 'sprintengine'),
    'sprintengine',
    'a row stored under the old rule is rescued',
  )
  assert.equal(titled('sprintengine', 'sprintengine'), 'sprintengine', 'a row already named for its chat is left alone')
  assert.equal(titled('Ship the release', 'sprintengine'), 'Ship the release', 'a name a person chose is theirs')
  assert.equal(
    titled(' · sprintengine', 'sprintengine'),
    ' · sprintengine',
    'no agent in front of it: not the old rule, not rewritten',
  )
  assert.equal(
    titled('Tara Boyle · sprintengine', undefined),
    'Tara Boyle · sprintengine',
    'a local row is never touched',
  )
  assert.equal(titled('Tara Boyle', ''), 'Tara Boyle', 'a remote that never named its chat leaves the name as it is')

  console.log('remote sessions model tests passed')
})

test('chats on a paired machine are rows of their own, with the presence their phase says, and open in the chat view', () => {
  const mini: MeshConnection = {
    id: 'c-mini',
    machineName: 'mac-mini',
    endpoint: 'mac-mini.tail1234.ts.net:8471',
    deviceId: 'tnd_mini',
    deviceName: 'dev-macbook-air',
    scopes: ['conversation:read', 'conversation:operate'],
    pairedAt: '2026-09-05T00:00:00.000Z',
    lastConnectedAt: null,
    pairedVia: 'request',
  }
  const chat = (agentId: string, phase: MeshConversation['phase'], title: string): MeshConversation => ({
    workspaceId: 'rw1',
    agentId,
    title,
    phase,
    updatedAt: 2_000,
    createdAt: 1_000,
    providerId: 'claude-agent',
    modelId: 'opus',
    turnCount: 3,
    lastSeq: 40,
  })
  const entry = {
    browse: null,
    loading: false,
    error: null,
    at: 1,
    conversations: [
      chat('a-running', 'running', 'Profile the importer'),
      chat('a-waiting', 'waiting_for_approval', 'Rename the store'),
      chat('a-done', 'completed', 'Write the changelog'),
    ],
  }
  const opened = {
    id: 'local-1',
    remoteOrigin: {
      connectionId: 'c-other',
      machineName: 'build-box',
      workspaceId: 'rw1',
      workspaceName: '',
      sessionId: 'unrelated',
    },
    layoutModel: {
      layout: {
        type: 'row',
        children: [
          {
            type: 'tab',
            component: 'mesh-conversation',
            config: { connectionId: 'c-mini', remoteSessionId: meshConversationSessionId('rw1', 'a-done') },
          },
        ],
      },
    },
  } as unknown as Workspace
  const [group] = buildRemoteBand({
    connections: [mini],
    browses: new Map([[mini.id, entry]]),
    reachability: new Map(),
    workspaces: [opened],
  })
  assert.deepEqual(
    group.rows.map((row) => [row.title, row.activity, row.status.label]),
    [
      ['Profile the importer', 'working', 'Running'],
      ['Rename the store', 'needs-input', 'Needs approval'],
      ['Write the changelog', 'idle', 'Done'],
    ],
  )
  // A pane already following a chat here is the window a click focuses.
  assert.equal(group.rows[2].attachedWorkspaceId, 'local-1')
  // Each chat is a conversation of its own, titled with its own name, even
  // when they stand in one workspace over there.
  const conversations = conversationsOf(group)
  assert.deepEqual(
    conversations.map((conversation) => conversation.title),
    ['Profile the importer', 'Rename the store', 'Write the changelog'],
  )
  assert.deepEqual(openSpecOfConversation(conversations[1]).conversation, { workspaceId: 'rw1', agentId: 'a-waiting' })
  assert.equal(meshConversationPresence('waiting_for_input'), 'needs-input')
  assert.equal(meshConversationPresence('starting'), 'running')
  assert.equal(meshConversationPresence('failed'), 'idle')
})
