import assert from 'node:assert/strict'

import { registerConversationIpc } from './conversation-ipc'
import type { ConversationIpcHandlers } from './conversation-ipc'
import type {
  ConversationProviderListResult,
  ConversationSecretStatusResult,
} from '../../shared/electron-api'
import type {
  ConversationEvent,
  ConversationProviderTestResult,
  ConversationSessionActionResult,
  ConversationStartSessionResult,
} from '../../shared/conversation-runtime'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function createIpcMain(): { handle(channel: string, handler: Handler): void; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  return {
    handle(channel, handler): void {
      handlers.set(channel, handler)
    },
    handlers,
  }
}

async function main(): Promise<void> {
  await testRegistersProviderListChannel()
  await testRegistersProviderTestChannel()
  await testRegistersSecretChannels()
  await testRegistersSessionChannelsAndEventSubscription()
  await testFailureIsExplicit()

  console.log('conversation-ipc tests passed')
}

async function testRegistersProviderListChannel(): Promise<void> {
  const response: ConversationProviderListResult = {
    ok: true,
    providers: [
      {
        id: 'openai-compatible',
        displayName: 'OpenAI Compatible',
        source: 'bundled',
        version: 1,
        providerType: 'model-provider',
        models: [{ id: 'gpt-5' }],
        supportsDynamicModels: false,
        adapter: { kind: 'declarative', execution: 'declarative', trust: 'not_required' },
      },
    ],
  }

  const ipcMain = createIpcMain()
  registerConversationIpc(ipcMain as unknown as Parameters<typeof registerConversationIpc>[0], {
    listProviders: () => response,
    testProvider: async () => ({ ok: false, status: { providerId: 'openai-compatible', state: 'missing_key', message: 'unused' } }),
    getSecretStatus: async () => ({ ok: false, message: 'unused' }),
    setSecret: async () => ({ ok: false, message: 'unused' }),
    clearSecret: async () => ({ ok: false, message: 'unused' }),
    ...runtimeHandlerStubs(),
  })

  const handler = ipcMain.handlers.get('conversation:providers:list')
  assert.ok(handler, 'conversation:providers:list should be registered')
  assert.deepEqual(await handler?.(null), response)
}

async function testRegistersProviderTestChannel(): Promise<void> {
  const response: ConversationProviderTestResult = {
    ok: true,
    status: {
      providerId: 'openai-compatible',
      state: 'reachable',
      modelId: 'gpt-5',
      message: 'Provider endpoint is reachable.',
    },
  }
  const calls: string[] = []
  const ipcMain = createIpcMain()
  registerConversationIpc(ipcMain as unknown as Parameters<typeof registerConversationIpc>[0], {
    listProviders: () => ({ ok: true, providers: [] }),
    testProvider: async (input) => {
      calls.push(`${input.providerId}:${input.modelId}`)
      return response
    },
    getSecretStatus: async () => ({ ok: false, message: 'unused' }),
    setSecret: async () => ({ ok: false, message: 'unused' }),
    clearSecret: async () => ({ ok: false, message: 'unused' }),
    ...runtimeHandlerStubs(),
  })

  assert.deepEqual(
    await ipcMain.handlers.get('conversation:providers:test')?.(null, {
      providerId: 'openai-compatible',
      modelId: 'gpt-5',
    }),
    response
  )
  assert.deepEqual(calls, ['openai-compatible:gpt-5'])
}

async function testRegistersSecretChannels(): Promise<void> {
  const calls: string[] = []
  const response: ConversationSecretStatusResult = {
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

  const ipcMain = createIpcMain()
  registerConversationIpc(ipcMain as unknown as Parameters<typeof registerConversationIpc>[0], {
    listProviders: () => ({ ok: true, providers: [] }),
    testProvider: async () => ({ ok: false, status: { providerId: 'openai-compatible', state: 'missing_key', message: 'unused' } }),
    getSecretStatus: async (input) => {
      calls.push(`status:${input.providerId}`)
      return response
    },
    setSecret: async (input) => {
      calls.push(`set:${input.providerId}:${input.value}`)
      return response
    },
    clearSecret: async (input) => {
      calls.push(`clear:${input.providerId}`)
      return response
    },
    ...runtimeHandlerStubs(),
  })

  assert.deepEqual(await ipcMain.handlers.get('conversation:secrets:status')?.(null, { providerId: 'openai-compatible' }), response)
  assert.deepEqual(
    await ipcMain.handlers.get('conversation:secrets:set')?.(null, {
      providerId: 'openai-compatible',
      value: 'sk-test-secret',
    }),
    response
  )
  assert.deepEqual(await ipcMain.handlers.get('conversation:secrets:clear')?.(null, { providerId: 'openai-compatible' }), response)
  assert.deepEqual(calls, [
    'status:openai-compatible',
    'set:openai-compatible:sk-test-secret',
    'clear:openai-compatible',
  ])
}

async function testRegistersSessionChannelsAndEventSubscription(): Promise<void> {
  const calls: string[] = []
  const runtimeListeners: Array<(event: ConversationEvent) => void> = []
  let unsubscribed = 0
  const startResult: ConversationStartSessionResult = {
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
  const actionResult: ConversationSessionActionResult = startResult
  const sent: { channel: string; payload: unknown }[] = []
  const ipcMain = createIpcMain()
  registerConversationIpc(ipcMain as unknown as Parameters<typeof registerConversationIpc>[0], {
    listProviders: () => ({ ok: true, providers: [] }),
    listProviderModels: async () => ({ ok: true, models: [] }),
    testProvider: async () => ({ ok: false, status: { providerId: 'mock-provider', state: 'missing_key', message: 'unused' } }),
    getSecretStatus: async () => ({ ok: false, message: 'unused' }),
    setSecret: async () => ({ ok: false, message: 'unused' }),
    clearSecret: async () => ({ ok: false, message: 'unused' }),
    startSession: async (input) => {
      calls.push(`start:${input.providerId}`)
      return startResult
    },
    sendTurn: async (input) => {
      calls.push(`send:${input.sessionId}:${input.message}`)
      return actionResult
    },
    interrupt: async (input) => {
      calls.push(`interrupt:${input.sessionId}`)
      return actionResult
    },
    respondToRequest: async (input) => {
      calls.push(`respond:${input.sessionId}:${input.requestId}:${input.approved}`)
      return actionResult
    },
    stopSession: async (input) => {
      calls.push(`stop:${input.sessionId}`)
      return actionResult
    },
    listSessions: () => ({ ok: true, sessions: [startResult.session] }),
    onEvent: (cb) => {
      runtimeListeners.push(cb)
      return () => {
        unsubscribed += 1
        const index = runtimeListeners.indexOf(cb)
        if (index >= 0) runtimeListeners.splice(index, 1)
      }
    },
  })

  await ipcMain.handlers.get('conversation:sessions:start')?.(null, {
    workspaceRoot: '/workspace',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock-provider',
    modelId: 'mock-model',
  })
  await ipcMain.handlers.get('conversation:sessions:send-turn')?.(null, { sessionId: 'conv_1', message: 'hello' })
  await ipcMain.handlers.get('conversation:sessions:interrupt')?.(null, { sessionId: 'conv_1' })
  await ipcMain.handlers.get('conversation:sessions:respond-to-request')?.(null, {
    sessionId: 'conv_1',
    requestId: 'approval_1',
    approved: true,
  })
  await ipcMain.handlers.get('conversation:sessions:stop')?.(null, { sessionId: 'conv_1' })
  assert.deepEqual(await ipcMain.handlers.get('conversation:sessions:list')?.(null, {}), {
    ok: true,
    sessions: [startResult.session],
  })

  const sender = createConversationSender(sent)
  const firstSubscription = await ipcMain.handlers.get('conversation:events:subscribe')?.({ sender })
  assert.deepEqual(firstSubscription, { ok: true, subscriptionId: 'conversation-subscription-1' })
  assert.equal(runtimeListeners.length, 1)
  assert.equal(sender.destroyedListenerCount(), 1)
  runtimeListeners[0]?.({
    id: 'event_1',
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock-provider',
    modelId: 'mock-model',
    type: 'session_ready',
    createdAt: 1,
  })
  assert.equal(sent[0]?.channel, 'conversation:event')
  assert.deepEqual(
    await ipcMain.handlers.get('conversation:events:unsubscribe')?.(null, {
      subscriptionId: 'conversation-subscription-1',
    }),
    { ok: true }
  )
  assert.equal(runtimeListeners.length, 0)
  assert.equal(unsubscribed, 1)
  assert.equal(sender.destroyedListenerCount(), 0)

  const secondSubscription = await ipcMain.handlers.get('conversation:events:subscribe')?.({ sender })
  assert.deepEqual(secondSubscription, { ok: true, subscriptionId: 'conversation-subscription-2' })
  assert.equal(runtimeListeners.length, 1)
  assert.equal(sender.destroyedListenerCount(), 1)
  assert.deepEqual(
    await ipcMain.handlers.get('conversation:events:unsubscribe')?.(null, {
      subscriptionId: 'conversation-subscription-2',
    }),
    { ok: true }
  )
  assert.equal(runtimeListeners.length, 0)
  assert.equal(unsubscribed, 2)
  assert.equal(sender.destroyedListenerCount(), 0)
  assert.deepEqual(calls, [
    'start:mock-provider',
    'send:conv_1:hello',
    'interrupt:conv_1',
    'respond:conv_1:approval_1:true',
    'stop:conv_1',
  ])
}

function createConversationSender(sent: { channel: string; payload: unknown }[]): {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
  once(channel: 'destroyed', listener: () => void): void
  removeListener(channel: 'destroyed', listener: () => void): void
  destroyedListenerCount(): number
} {
  const destroyedListeners = new Set<() => void>()
  return {
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
    once: (_channel, listener) => {
      destroyedListeners.add(listener)
    },
    removeListener: (_channel, listener) => {
      destroyedListeners.delete(listener)
    },
    destroyedListenerCount: () => destroyedListeners.size,
  }
}

async function testFailureIsExplicit(): Promise<void> {
  const ipcMain = createIpcMain()
  registerConversationIpc(ipcMain as unknown as Parameters<typeof registerConversationIpc>[0], {
    listProviders: async () => {
      throw new Error('provider registry load failed')
    },
    testProvider: async () => ({ ok: false, status: { providerId: 'openai-compatible', state: 'missing_key', message: 'unused' } }),
    getSecretStatus: async () => ({ ok: false, message: 'unused' }),
    setSecret: async () => ({ ok: false, message: 'unused' }),
    clearSecret: async () => ({ ok: false, message: 'unused' }),
    ...runtimeHandlerStubs(),
  })

  const result = (await ipcMain.handlers.get('conversation:providers:list')?.(null)) as ConversationProviderListResult
  assert.deepEqual(result, { ok: false, message: 'provider registry load failed' })
  assert.deepEqual(await ipcMain.handlers.get('conversation:secrets:status')?.(null, null), {
    ok: false,
    message: 'providerId is required.',
  })
  assert.deepEqual(await ipcMain.handlers.get('conversation:events:unsubscribe')?.(null, null), {
    ok: false,
    message: 'subscriptionId is required.',
  })
}

function runtimeHandlerStubs(): Pick<
  ConversationIpcHandlers,
  'listProviderModels' | 'startSession' | 'sendTurn' | 'interrupt' | 'respondToRequest' | 'stopSession' | 'listSessions' | 'readTranscript' | 'onEvent'
> {
  return {
    listProviderModels: async () => ({ ok: true, models: [] }),
    startSession: async () => ({ ok: false, message: 'unused' }),
    sendTurn: async () => ({ ok: false, message: 'unused' }),
    interrupt: async () => ({ ok: false, message: 'unused' }),
    respondToRequest: async () => ({ ok: false, message: 'unused' }),
    stopSession: async () => ({ ok: false, message: 'unused' }),
    listSessions: () => ({ ok: true, sessions: [] }),
    readTranscript: async () => ({ ok: false, message: 'unused' }),
    onEvent: () => () => undefined,
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
