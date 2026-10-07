import assert from 'node:assert/strict'
import { test } from 'vitest'

import { parseConversationServerFrame } from '../../../../packages/conversation-protocol/src/public'
import type { ConversationSessionSummary } from '../../../shared/conversation-runtime'
import type { ConversationThread as IndexedThread } from '../../../shared/conversation-index'
import type { ConversationBackend } from '../../../server/core/conversation-backend'
import {
  createConversationGatewayHost,
  type ConversationListWorkspace,
  type ConversationRegistryLink,
} from './tailnet-conversation-host'

// The list a paired phone or desktop reads, as the desktop that owns each
// chat's rest and read state answers it (`conversation-lifecycle`).

function indexed(agentId: string, fields: Partial<IndexedThread> = {}): IndexedThread {
  return {
    agentId,
    title: `First message of ${agentId}`,
    titleSource: 'first-message',
    createdAt: 1,
    updatedAt: 1,
    turnCount: 1,
    model: 'default',
    providerId: 'mock',
    lastSeq: 4,
    firstUserText: 'hello',
    ...fields,
  }
}

function session(workspaceId: string, agentId: string, fields: Partial<ConversationSessionSummary> = {}) {
  return {
    sessionId: `conv-${workspaceId}-${agentId}`,
    workspaceId,
    agentId,
    providerId: 'mock',
    modelId: 'default',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  } as ConversationSessionSummary
}

function hostFor(input: {
  threads: Record<string, IndexedThread[]>
  sessions?: ConversationSessionSummary[]
  records: Record<string, ConversationListWorkspace>
  registry?: ConversationRegistryLink
}) {
  const runtime = {
    listSessions: () => ({ ok: true, sessions: input.sessions ?? [] }),
    listThreads: async (key: { workspaceId: string }) => ({ ok: true, threads: input.threads[key.workspaceId] ?? [] }),
    getProviderCapabilities: () => undefined,
  } as unknown as ConversationBackend
  return createConversationGatewayHost(
    runtime,
    () => '/Users/dev/app',
    () => Object.keys(input.threads).map((workspaceId) => ({ workspaceId, workspaceRoot: '/Users/dev/app' })),
    () => 'bypass',
    // The agent record's name, which old clients keep reading as `title`.
    (key) => `Agent of ${key.workspaceId}`,
    async () => null,
    {},
    input.registry ?? { workspaceOf: (workspaceId) => input.records[workspaceId] ?? null },
  )
}

test('a settled chat is not listed, whether its history or a live session would name it', async () => {
  const host = hostFor({
    threads: { open: [indexed('agent-1')], resting: [indexed('agent-1')] },
    sessions: [session('resting', 'agent-2')],
    records: {
      open: { name: 'Open chat', createdAt: 1 },
      resting: { name: 'Resting chat', createdAt: 1, settledAt: 50 },
    },
  })
  const listed = await host.list()
  assert.deepEqual(
    listed.map((thread) => thread.workspaceId),
    ['open'],
  )
})

test('each chat names its sidebar title and its clocks, and keeps the agent name as `title`', async () => {
  const host = hostFor({
    threads: { chat: [indexed('agent-1', { lastTurnEndedAt: 300 })] },
    records: {
      chat: { name: ' Fix the login ', createdAt: 1, lastUserMessageAt: 200, lastVisitedAt: 250 },
    },
  })
  const [thread] = await host.list()
  assert.equal(thread?.title, 'Agent of chat')
  assert.equal(thread?.chatTitle, 'Fix the login')
  assert.equal(thread?.lastUserMessageAt, 200)
  assert.equal(thread?.lastTurnEndedAt, 300)
  assert.equal(thread?.lastVisitedAt, 250)
})

test('the turn end is the later of the transcript’s and a session’s, never `updatedAt`', async () => {
  const host = hostFor({
    threads: { a: [indexed('agent-1', { lastTurnEndedAt: 300, updatedAt: 9_000 })], b: [indexed('agent-1')] },
    sessions: [session('a', 'agent-1', { lastTurnEndedAt: 400, status: 'stopped', updatedAt: 9_500 })],
    records: { a: { name: 'A', createdAt: 1 }, b: { name: 'B', createdAt: 1 } },
  })
  const byWorkspace = new Map((await host.list()).map((thread) => [thread.workspaceId, thread]))
  assert.equal(byWorkspace.get('a')?.lastTurnEndedAt, 400)
  // A chat whose agent never finished a turn says nothing about one.
  assert.equal('lastTurnEndedAt' in byWorkspace.get('b')!, false)
})

test('a chat with nothing true to say leaves the members out rather than sending empties', async () => {
  const host = hostFor({
    threads: { chat: [indexed('agent-1')], unknown: [indexed('agent-1')] },
    records: { chat: { name: '   ', createdAt: 1 } },
  })
  for (const thread of await host.list()) {
    for (const member of ['chatTitle', 'lastUserMessageAt', 'lastTurnEndedAt', 'lastVisitedAt'])
      assert.equal(member in thread, false, `${thread.workspaceId}.${member}`)
  }
})

test('the list arrives in the sidebar’s order: last message first, the work clock for a chat with none', async () => {
  const host = hostFor({
    threads: {
      // Busiest by `updatedAt`, but last written to longest ago.
      busy: [indexed('agent-1', { updatedAt: 99_000 })],
      recent: [indexed('agent-1', { updatedAt: 10 })],
      // Never written to: ordered by when it was made, or last typed into.
      fresh: [indexed('agent-1', { updatedAt: 5 })],
      older: [indexed('agent-1', { updatedAt: 6 })],
    },
    records: {
      busy: { name: 'Busy', createdAt: 1, lastUserMessageAt: 100 },
      recent: { name: 'Recent', createdAt: 1, lastUserMessageAt: 5_000 },
      fresh: { name: 'Fresh', createdAt: 3_000 },
      older: { name: 'Older', createdAt: 50, lastTerminalActivityAt: 70 },
    },
  })
  assert.deepEqual(
    (await host.list()).map((thread) => thread.workspaceId),
    ['recent', 'fresh', 'busy', 'older'],
  )
})

test('a failed record read lists the chats as an older desktop would, with nothing left out', async () => {
  const host = hostFor({
    threads: { chat: [indexed('agent-1')] },
    records: {},
    registry: {
      workspaceOf: () => {
        throw new Error('registry unavailable')
      },
    },
  })
  const listed = await host.list()
  assert.equal(listed.length, 1)
  assert.equal('chatTitle' in listed[0]!, false)
})

test('the client validator keeps every lifecycle member that is readable and drops the rest, never the row', async () => {
  const host = hostFor({
    threads: { chat: [indexed('agent-1', { lastTurnEndedAt: 300 })] },
    records: { chat: { name: 'Fix the login', createdAt: 1, lastUserMessageAt: 200, lastVisitedAt: 250 } },
  })
  const listed = JSON.parse(JSON.stringify(await host.list())) as Array<Record<string, unknown>>
  const parsed = parseConversationServerFrame({
    type: 'sessions',
    requestId: 'list',
    sessions: [
      ...listed,
      { ...listed[0], agentId: 'agent-2', chatTitle: '', lastUserMessageAt: 'soon', lastVisitedAt: -1 },
    ],
  })
  assert.ok(parsed?.type === 'sessions')
  assert.equal(parsed.sessions.length, 2)
  const [whole, broken] = parsed.sessions
  assert.equal(whole?.chatTitle, 'Fix the login')
  assert.equal(whole?.lastUserMessageAt, 200)
  assert.equal(whole?.lastTurnEndedAt, 300)
  assert.equal(whole?.lastVisitedAt, 250)
  assert.equal('chatTitle' in broken!, false)
  assert.equal('lastUserMessageAt' in broken!, false)
  assert.equal('lastVisitedAt' in broken!, false)
  assert.equal(broken?.lastTurnEndedAt, 300)
})

test('a send from a paired device stamps the desktop’s message clock', async () => {
  const notes: Array<[string, number]> = []
  const sent: unknown[] = []
  const runtime = {
    listSessions: () => ({ ok: true, sessions: [session('chat', 'agent-1')] }),
    listThreads: async () => ({ ok: true, threads: [] }),
    getProviderCapabilities: () => undefined,
    sendTurn: async (input: unknown) => {
      sent.push(input)
      return { ok: true }
    },
  } as unknown as ConversationBackend
  const host = createConversationGatewayHost(
    runtime,
    () => '/Users/dev/app',
    () => [],
    () => 'bypass',
    () => null,
    async () => null,
    {},
    { noteUserMessage: (workspaceId, at) => notes.push([workspaceId, at]) },
  )
  const before = Date.now()
  const result = await host.command(
    { workspaceRoot: '/Users/dev/app', workspaceId: 'chat', agentId: 'agent-1' },
    'device-1',
    'command-1',
    { kind: 'send', message: 'carry on' },
  )
  assert.equal(result.ok, true)
  assert.equal(sent.length, 1)
  assert.equal(notes.length, 1)
  assert.equal(notes[0]?.[0], 'chat')
  assert.ok(notes[0]![1] >= before)
})

test('a send through a host for Studio’s own messages is recorded as Studio’s and stamps no clock', async () => {
  const sent: Array<{ origin?: unknown }> = []
  const runtime = {
    listSessions: () => ({ ok: true, sessions: [session('chat', 'agent-1')] }),
    listThreads: async () => ({ ok: true, threads: [] }),
    getProviderCapabilities: () => undefined,
    sendTurn: async (input: { origin?: unknown }) => {
      sent.push(input)
      return { ok: true }
    },
  } as unknown as ConversationBackend
  const host = createConversationGatewayHost(
    runtime,
    () => '/Users/dev/app',
    () => [],
    () => 'bypass',
    () => null,
    async () => null,
    {},
    { sendOrigin: { kind: 'studio', reason: 'usage-resume' } },
  )
  const result = await host.command(
    { workspaceRoot: '/Users/dev/app', workspaceId: 'chat', agentId: 'agent-1' },
    'studio-usage-limit-resume',
    'usage-limit-resume:1',
    { kind: 'send', message: 'carry on' },
  )
  assert.equal(result.ok, true)
  assert.deepEqual(sent[0]?.origin, { kind: 'studio', reason: 'usage-resume' })
})
