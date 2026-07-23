import assert from 'node:assert/strict'

import { createConversationApi } from './conversation'
import type { ConversationProviderListResult, ConversationSecretStatusResult } from '../../shared/electron-api'
import type { ConversationEvent, ConversationProviderTestResult } from '../../shared/conversation-runtime'

type Listener = (event: unknown, payload: ConversationEvent) => void

async function main(): Promise<void> {
  const calls: string[] = []
  const listeners: { channel: string; listener: Listener }[] = []
  const removed: { channel: string; listener: Listener }[] = []
  const response: ConversationProviderListResult = {
    ok: true,
    providers: [
      {
        id: 'openai-compatible',
        displayName: 'OpenAI Compatible',
        source: 'user',
        version: 1,
        providerType: 'model-provider',
        models: [{ id: 'gpt-5' }],
        supportsDynamicModels: false,
        adapter: { kind: 'declarative', execution: 'declarative', trust: 'not_required' },
      },
    ],
  }

  const api = createConversationApi({
    async invoke(channel: string): Promise<any> {
      calls.push(channel)
      if (channel === 'conversation:providers:list') return response
      if (channel === 'conversation:providers:test') {
        return {
          ok: true,
          status: {
            providerId: 'openai-compatible',
            state: 'reachable',
            modelId: 'gpt-5',
            message: 'Provider endpoint is reachable.',
          },
        } satisfies ConversationProviderTestResult
      }
      if (channel === 'conversation:events:subscribe') return { ok: true, subscriptionId: 'conversation-subscription-1' }
      if (channel === 'conversation:events:unsubscribe') return { ok: true }
      if (channel === 'conversation:sessions:list') return { ok: true, sessions: [] }
      if (channel.startsWith('conversation:sessions:')) {
        return {
          ok: true,
          session: {
            sessionId: 'conv_1',
            workspaceId: 'workspace',
            agentId: 'agent',
            providerId: 'mock-provider',
            modelId: 'mock-model',
            status: 'ready',
            createdAt: 1,
            updatedAt: 1,
          },
        }
      }
      return {
        ok: true,
        status: {
          providerId: 'openai-compatible',
          configured: true,
          source: 'settings',
          persistence: 'encrypted',
          encryptionAvailable: true,
          label: 'API key',
        },
      } satisfies ConversationSecretStatusResult
    },
    on(channel, listener) {
      listeners.push({ channel, listener: listener as Listener })
    },
    removeListener(channel, listener) {
      removed.push({ channel, listener: listener as Listener })
    },
  })

  const result = await api.conversationProvidersList()
  assert.deepEqual(result, response)
  assert.equal((await api.conversationProviderTest({ providerId: 'openai-compatible', modelId: 'gpt-5' })).status.state, 'reachable')
  assert.deepEqual(
    await api.conversationSecretStatus({ providerId: 'openai-compatible' }),
    {
      ok: true,
      status: {
        providerId: 'openai-compatible',
        configured: true,
        source: 'settings',
        persistence: 'encrypted',
        encryptionAvailable: true,
        label: 'API key',
      },
    }
  )
  await api.conversationSecretSet({ providerId: 'openai-compatible', value: 'sk-test-secret' })
  await api.conversationSecretClear({ providerId: 'openai-compatible' })
  await api.conversationSessionStart({
    workspaceRoot: '/workspace',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock-provider',
    modelId: 'mock-model',
  })
  await api.conversationSessionSendTurn({ sessionId: 'conv_1', message: 'hello' })
  await api.conversationSessionInterrupt({ sessionId: 'conv_1' })
  await api.conversationSessionRespondToRequest({ sessionId: 'conv_1', requestId: 'approval_1', approved: true })
  await api.conversationSessionSetPermission({ sessionId: 'conv_1', permissionPreset: 'auto_workspace' })
  await api.conversationSessionStop({ sessionId: 'conv_1' })
  await api.conversationSessionsList({ workspaceId: 'workspace' })
  const received: ConversationEvent[] = []
  const cleanup = api.onConversationEvent((event) => received.push(event))
  const event: ConversationEvent = {
    id: 'event_1',
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock-provider',
    modelId: 'mock-model',
    type: 'session_ready',
    createdAt: 1,
  }
  listeners[0]?.listener({}, event)
  cleanup()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(received, [event])
  assert.equal(removed[0]?.listener, listeners[0]?.listener)
  assert.deepEqual(calls, [
    'conversation:providers:list',
    'conversation:providers:test',
    'conversation:secrets:status',
    'conversation:secrets:set',
    'conversation:secrets:clear',
    'conversation:sessions:start',
    'conversation:sessions:send-turn',
    'conversation:sessions:interrupt',
    'conversation:sessions:respond-to-request',
    'conversation:sessions:set-permission',
    'conversation:sessions:stop',
    'conversation:sessions:list',
    'conversation:events:subscribe',
    'conversation:events:unsubscribe',
  ])

  console.log('conversation-preload tests passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
