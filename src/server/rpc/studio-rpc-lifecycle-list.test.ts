import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import type { StudioParsedServerFrame } from '../../../packages/studio-protocol/src/public'
import type { ConversationThread as IndexedThread } from '../../shared/conversation-index'
import type { ConversationBackend } from '../core/conversation-backend'
import {
  createConversationGatewayHost,
  type ConversationListWorkspace,
} from '../../main/automation/tailnet/tailnet-conversation-host'
import { STUDIO_RPC_CONVERSATION_CAPABILITIES } from './studio-rpc-server'
import { connectLineClient, createFakeBackend, hello, pairFakeClient, startTestServer } from './studio-rpc.test-helper'

// The owner socket does not advertise `conversation-lifecycle`, so its list
// keeps the shape it had before that capability: every chat, settled ones
// included, most recently moved first. Only the tailnet lane, which does
// advertise it, leaves settled chats out and lists in the sidebar's order.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function thread(agentId: string, updatedAt: number): IndexedThread {
  return {
    agentId,
    title: `First message of ${agentId}`,
    titleSource: 'first-message',
    createdAt: 1,
    updatedAt,
    turnCount: 1,
    model: 'default',
    providerId: 'mock',
    lastSeq: 4,
    firstUserText: 'hello',
  }
}

const threads: Record<string, IndexedThread[]> = {
  resting: [thread('agent-1', 300)],
  written: [thread('agent-1', 100)],
  moved: [thread('agent-1', 200)],
}
const records: Record<string, ConversationListWorkspace> = {
  resting: { name: 'Resting', createdAt: 1, settledAt: 50 },
  written: { name: 'Written', createdAt: 1, lastUserMessageAt: 900 },
  moved: { name: 'Moved', createdAt: 1, lastUserMessageAt: 10 },
}

/** The conversation host as the core builds it, for one door or the other. */
function host(lifecycleList: boolean) {
  const runtime = {
    listSessions: () => ({ ok: true, sessions: [] }),
    listThreads: async (key: { workspaceId: string }) => ({ ok: true, threads: threads[key.workspaceId] ?? [] }),
    getProviderCapabilities: () => undefined,
  } as unknown as ConversationBackend
  return createConversationGatewayHost(
    runtime,
    () => '/Users/dev/app',
    () => Object.keys(threads).map((workspaceId) => ({ workspaceId, workspaceRoot: '/Users/dev/app' })),
    () => 'bypass',
    () => null,
    async () => null,
    {},
    {
      workspaceOf: (workspaceId) => records[workspaceId] ?? null,
      ...(lifecycleList ? { lifecycleList: true } : {}),
    },
  )
}

test('the owner socket lists every chat, settled ones too, by when each last moved', async () => {
  const conversationHost = host(false)
  const started = await startTestServer({ backend: { ...createFakeBackend(), list: () => conversationHost.list() } })
  cleanups.push(() => started.dispose())
  const c = await connectLineClient(started.path)
  cleanups.push(() => c.close())
  c.send(hello({ token: pairFakeClient(started.auth, 'reader', ['conversation:read']) }))
  const welcome = await c.next((frame: StudioParsedServerFrame) => frame.t === 'welcome')
  assert.ok(welcome.t === 'welcome' && !welcome.capabilities.includes('conversation-lifecycle'))
  assert.equal(STUDIO_RPC_CONVERSATION_CAPABILITIES.includes('conversation-lifecycle'), false)

  c.send({ t: 'req', id: 'l1', method: 'conversation.list' })
  const listed = await c.next((frame: StudioParsedServerFrame) => frame.t === 'res' && frame.id === 'l1')
  assert.ok(listed.t === 'res' && listed.ok)
  const conversations = (listed.result as { conversations: Array<{ workspaceId: string }> }).conversations
  assert.deepEqual(
    conversations.map((conversation) => conversation.workspaceId),
    ['resting', 'moved', 'written'],
  )
})

test('the tailnet lane’s host leaves the settled chat out and lists in the sidebar’s order', async () => {
  const listed = await host(true).list()
  assert.deepEqual(
    listed.map((conversation) => conversation.workspaceId),
    ['written', 'moved'],
  )
})
