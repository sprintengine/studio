import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { MeshBrowse, MeshConnection, MeshConversation } from '../../../../../shared/tailnet-mesh'
import type { Workspace } from '../../../types/workspace'
import {
  buildRemoteBand,
  conversationsOf,
  remoteLifecycleWritable,
  remoteRestToFollow,
  unattachedConversations,
  type RemoteBrowseEntry,
} from './remoteSessionsModel'

// The remote rows as a machine that owns its chats' rest and read state
// lists them (`conversation-lifecycle`): titled with the chat, in the order
// the person last wrote to each, with the resting ones left out.

const connection = (id: string, machineName: string): MeshConnection => ({
  id,
  machineName,
  endpoint: '100.64.0.5:8471',
  deviceId: `device-${id}`,
  deviceName: 'dev-macbook-air',
  scopes: ['workspace:read', 'conversation:operate'],
  pairedAt: '2026-10-01T00:00:00.000Z',
  lastConnectedAt: null,
  pairedVia: 'request',
})

const chat = (workspaceId: string, over: Partial<MeshConversation> = {}): MeshConversation => ({
  workspaceId,
  agentId: 'agent-1',
  title: 'Gael Corry',
  phase: 'completed',
  updatedAt: 1_000,
  createdAt: 500,
  providerId: 'claude-agent',
  modelId: 'opus',
  turnCount: 1,
  lastSeq: 4,
  ...over,
})

const browse = (workspaces: MeshBrowse['workspaces'] = []): MeshBrowse => ({
  connectionId: 'c1',
  reachable: true,
  unreachableReason: null,
  unauthorized: false,
  scopes: ['workspace:read', 'conversation:operate'],
  workspaces,
  gaps: [],
})

const remoteWorkspace = (id: string, name: string, settledAt: number | null = null) => ({
  id,
  name,
  mode: 'standard',
  folderPath: '/Users/dev/app',
  repository: null,
  settledAt,
})

function band(entries: Array<[MeshConnection, Partial<RemoteBrowseEntry> & { conversations: MeshConversation[] }]>) {
  return buildRemoteBand({
    connections: entries.map(([machine]) => machine),
    browses: new Map(
      entries.map(([machine, entry]) => [
        machine.id,
        { browse: browse(), loading: false, error: null, at: 1, lifecycle: true, access: 'operate' as const, ...entry },
      ]),
    ),
    reachability: new Map(),
    workspaces: [],
  })
}

const mini = connection('c1', 'mac-mini')
const box = connection('c2', 'build-box')

test('a machine that keeps its chats’ rest is drawn in the order it listed them, its sidebar’s', () => {
  // Its key for a chat never written to is its creation there, not when it
  // last moved: re-sorted here by `updatedAt`, 'never-written' would jump
  // above 'written' though that machine's own sidebar draws it below.
  const [group] = band([
    [
      mini,
      {
        conversations: [
          chat('working', { phase: 'running', updatedAt: 9_000, lastUserMessageAt: 3_000 }),
          chat('written', { phase: 'completed', updatedAt: 50, lastUserMessageAt: 2_000 }),
          chat('never-written', { phase: 'completed', updatedAt: 8_000 }),
        ],
      },
    ],
  ])
  assert.deepEqual(
    group!.rows.map((row) => row.workspaceId),
    ['working', 'written', 'never-written'],
  )
})

test('a machine from before that is ordered here by when the person last wrote, never by what the agent is doing', () => {
  const [group] = band([
    [
      mini,
      {
        lifecycle: false,
        conversations: [
          chat('working', { phase: 'running', updatedAt: 9_000, lastUserMessageAt: 100 }),
          chat('waiting', { phase: 'waiting_for_approval', updatedAt: 8_000, lastUserMessageAt: 200 }),
          chat('quiet', { phase: 'completed', updatedAt: 50, lastUserMessageAt: 3_000 }),
          // A machine that names no message clock is ordered by `updatedAt`.
          chat('older-build', { phase: 'completed', updatedAt: 1_500 }),
        ],
      },
    ],
  ])
  assert.deepEqual(
    group!.rows.map((row) => row.workspaceId),
    ['quiet', 'older-build', 'waiting', 'working'],
  )
})

test('across machines the rows interleave by the same clock, each machine’s in its own order', () => {
  const groups = band([
    [
      mini,
      {
        conversations: [
          chat('mini-new', { lastUserMessageAt: 900 }),
          // Listed below 'mini-new' by its machine, whatever its clock here says.
          chat('mini-unwritten', { updatedAt: 950 }),
          chat('mini-old', { lastUserMessageAt: 100 }),
        ],
      },
    ],
    [box, { conversations: [chat('box-mid', { lastUserMessageAt: 500 })] }],
  ])
  assert.deepEqual(
    unattachedConversations(groups, true, []).map((conversation) => conversation.workspaceId),
    ['mini-new', 'mini-unwritten', 'box-mid', 'mini-old'],
  )
})

test("a row is titled with the chat, then the browse's name for it, then its agent", () => {
  const [group] = band([
    [
      mini,
      {
        browse: browse([remoteWorkspace('named-by-browse', 'Ship the docs')]),
        conversations: [
          chat('named', { chatTitle: 'Fix the login', lastUserMessageAt: 4 }),
          chat('named-by-browse', { lastUserMessageAt: 3 }),
          chat('agent-only', { lastUserMessageAt: 2 }),
          chat('untitled', { title: '', lastUserMessageAt: 1 }),
        ],
      },
    ],
  ])
  assert.deepEqual(
    conversationsOf(group!).map((conversation) => conversation.title),
    ['Fix the login', 'Ship the docs', 'Gael Corry', 'Conversation'],
  )
  // The agent's name stays its line's name.
  assert.equal(group!.rows[0]!.title, 'Gael Corry')
})

test('a chat whose workspace the browse says is settled has no row', () => {
  const [group] = band([
    [
      mini,
      {
        browse: browse([remoteWorkspace('resting', 'Done', 1_234), remoteWorkspace('open', 'Going')]),
        conversations: [chat('resting'), chat('open')],
      },
    ],
  ])
  assert.deepEqual(
    group!.rows.map((row) => row.workspaceId),
    ['open'],
  )
})

test('a row carries its clocks and whether its machine keeps its rest', () => {
  const [kept] = band([
    [mini, { conversations: [chat('a', { lastTurnEndedAt: 700, lastVisitedAt: 650, lastUserMessageAt: 600 })] }],
  ])
  const row = kept!.rows[0]!
  assert.equal(row.lifecycle, true)
  assert.equal(row.lastTurnEndedAt, 700)
  assert.equal(row.lastVisitedAt, 650)
  assert.equal(row.recencyAt, 600)
  const [older] = band([[mini, { lifecycle: false, conversations: [chat('a')] }]])
  assert.equal(older!.rows[0]!.lifecycle, false)
  assert.equal(older!.rows[0]!.lastTurnEndedAt, null)
})

test('a pairing that may only follow a machine’s chats offers no Settle and says no visit there', () => {
  const [readOnly] = band([[mini, { access: 'read', conversations: [chat('a')] }]])
  assert.equal(readOnly!.rows[0]!.lifecycle, false, 'the machine would refuse every one')
  assert.equal(remoteLifecycleWritable({ browse: null, loading: false, error: null, at: 1, lifecycle: true }), false)
  assert.equal(
    remoteLifecycleWritable({ browse: null, loading: false, error: null, at: 1, lifecycle: true, access: 'operate' }),
    true,
  )
})

// A row here opened from a paired machine's chat, by the remote workspace it follows.
const opened = (id: string, connectionId: string, remoteWorkspaceId: string): Workspace =>
  ({
    id,
    name: id,
    folderPath: null,
    remoteOrigin: {
      connectionId,
      machineName: 'mac-mini',
      workspaceId: remoteWorkspaceId,
      workspaceName: remoteWorkspaceId,
      workspaceRoot: null,
    },
  }) as unknown as Workspace

const entry = (workspaces: MeshBrowse['workspaces'], lifecycle = true): RemoteBrowseEntry => ({
  browse: browse(workspaces),
  loading: false,
  error: null,
  at: 1,
  lifecycle,
})

test('a row opened from a chat its machine has settled follows that settle', () => {
  const due = remoteRestToFollow({
    workspaces: [opened('here-1', 'c1', 'resting'), opened('here-2', 'c1', 'open'), { id: 'local' } as Workspace],
    browses: new Map([['c1', entry([remoteWorkspace('resting', 'Done', 4_000), remoteWorkspace('open', 'Going')])]]),
    followed: new Map(),
  })
  assert.deepEqual(due, [{ workspaceId: 'here-1', settledAt: 4_000 }])
})

test('a settle already followed is not followed again, so a row brought back here stays', () => {
  const input = {
    workspaces: [opened('here-1', 'c1', 'resting')],
    browses: new Map([['c1', entry([remoteWorkspace('resting', 'Done', 4_000)])]]),
  }
  assert.deepEqual(remoteRestToFollow({ ...input, followed: new Map([['here-1', 4_000]]) }), [])
  // Settled over there again, later: followed again.
  assert.deepEqual(remoteRestToFollow({ ...input, followed: new Map([['here-1', 3_000]]) }), [
    { workspaceId: 'here-1', settledAt: 4_000 },
  ])
})

test('a machine that does not keep its chats’ rest is not followed', () => {
  assert.deepEqual(
    remoteRestToFollow({
      workspaces: [opened('here-1', 'c1', 'resting')],
      browses: new Map([['c1', entry([remoteWorkspace('resting', 'Done', 4_000)], false)]]),
      followed: new Map(),
    }),
    [],
  )
})
