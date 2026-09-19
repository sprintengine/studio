import assert from 'node:assert/strict'

import { registerConversationIpc } from './conversation-ipc'
import {
  ATTACHABLE_IMAGE_TYPES,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_ATTACHMENT_BYTES,
} from '../../shared/conversation-attachments'
import type { ConversationIpcHandlers } from './conversation-ipc'
import type { ConversationProviderListResult, ConversationSecretStatusResult } from '../../shared/electron-api'
import type {
  ConversationEvent,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationStartSessionResult,
} from '../../shared/conversation-runtime'
import { test } from 'vitest'

test('conversation-ipc', async () => {
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
    await testRegistersSecretChannels()
    await testRegistersSessionChannelsAndEventSubscription()
    await testSendTurnValidatesImageAttachments()
    await testAttachmentLimitsAreTheSharedOnes()
    await testSetPermissionValidatesThePreset()
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
      listProviders: async () => response,
      getSecretStatus: async () => ({ ok: false, message: 'unused' }),
      setSecret: async () => ({ ok: false, message: 'unused' }),
      clearSecret: async () => ({ ok: false, message: 'unused' }),
      ...runtimeHandlerStubs(),
    })

    const handler = ipcMain.handlers.get('conversation:providers:list')
    assert.ok(handler, 'conversation:providers:list should be registered')
    assert.deepEqual(await handler?.(null), response)
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
      listProviders: async () => ({ ok: true, providers: [] }),
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

    assert.deepEqual(
      await ipcMain.handlers.get('conversation:secrets:status')?.(null, { providerId: 'openai-compatible' }),
      response,
    )
    assert.deepEqual(
      await ipcMain.handlers.get('conversation:secrets:set')?.(null, {
        providerId: 'openai-compatible',
        value: 'sk-test-secret',
      }),
      response,
    )
    assert.deepEqual(
      await ipcMain.handlers.get('conversation:secrets:clear')?.(null, { providerId: 'openai-compatible' }),
      response,
    )
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
      listProviders: async () => ({ ok: true, providers: [] }),
      listProviderModels: async () => ({ ok: true, models: [] }),
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
      setPermission: async (input) => {
        calls.push(`permission:${input.sessionId}:${input.permissionPreset}`)
        return actionResult
      },
      readTranscript: async () => ({ ok: false, message: 'unused' }),
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
    await ipcMain.handlers.get('conversation:sessions:set-permission')?.(null, {
      sessionId: 'conv_1',
      permissionPreset: 'bypass',
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
      { ok: true },
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
      { ok: true },
    )
    assert.equal(runtimeListeners.length, 0)
    assert.equal(unsubscribed, 2)
    assert.equal(sender.destroyedListenerCount(), 0)
    assert.deepEqual(calls, [
      'start:mock-provider',
      'send:conv_1:hello',
      'interrupt:conv_1',
      'respond:conv_1:approval_1:true',
      'permission:conv_1:bypass',
      'stop:conv_1',
    ])
  }

  // The set-permission boundary only accepts the three known presets, so an
  // unknown value never reaches the runtime or the provider.
  async function testSetPermissionValidatesThePreset(): Promise<void> {
    const captured: string[] = []
    const ipcMain = createIpcMain()
    registerConversationIpc(ipcMain as unknown as Parameters<typeof registerConversationIpc>[0], {
      listProviders: async () => ({ ok: true, providers: [] }),
      getSecretStatus: async () => ({ ok: false, message: 'unused' }),
      setSecret: async () => ({ ok: false, message: 'unused' }),
      clearSecret: async () => ({ ok: false, message: 'unused' }),
      ...runtimeHandlerStubs(),
      setPermission: async (input) => {
        captured.push(input.permissionPreset)
        return { ok: true, session: { ...SENT_SESSION, permissionPreset: input.permissionPreset } }
      },
    })
    const setPermission = ipcMain.handlers.get('conversation:sessions:set-permission')
    assert.ok(setPermission, 'conversation:sessions:set-permission should be registered')

    assert.deepEqual(await setPermission?.(null, { sessionId: 'conv_1', permissionPreset: 'auto' }), {
      ok: true,
      session: { ...SENT_SESSION, permissionPreset: 'auto' },
    })
    assert.deepEqual(captured, ['auto'])

    const presetError = { ok: false, message: 'permissionPreset must be default, auto, or bypass.' }
    assert.deepEqual(await setPermission?.(null, { sessionId: 'conv_1', permissionPreset: 'yolo' }), presetError)
    assert.deepEqual(await setPermission?.(null, { sessionId: 'conv_1' }), presetError)
    assert.deepEqual(await setPermission?.(null, { permissionPreset: 'manual' }), {
      ok: false,
      message: 'sessionId is required.',
    })
    assert.deepEqual(captured, ['auto'], 'no invalid preset reached the runtime')
  }

  // The send-turn boundary guards image attachments: valid images pass through
  // (with a server-derived byteLength), bad media type / size / encoding / count
  // are rejected with a clear message before the runtime is touched.
  async function testSendTurnValidatesImageAttachments(): Promise<void> {
    const captured: ConversationSendTurnInput[] = []
    const ipcMain = createIpcMain()
    registerConversationIpc(ipcMain as unknown as Parameters<typeof registerConversationIpc>[0], {
      listProviders: async () => ({ ok: true, providers: [] }),
      getSecretStatus: async () => ({ ok: false, message: 'unused' }),
      setSecret: async () => ({ ok: false, message: 'unused' }),
      clearSecret: async () => ({ ok: false, message: 'unused' }),
      ...runtimeHandlerStubs(),
      sendTurn: async (input) => {
        captured.push(input)
        return { ok: true, session: SENT_SESSION }
      },
    })
    const sendTurn = ipcMain.handlers.get('conversation:sessions:send-turn')

    // A valid PNG attachment flows through; byteLength is derived from the data.
    const okResult = await sendTurn?.(null, {
      sessionId: 'conv_1',
      message: 'look',
      attachments: [{ id: 'img-1', mediaType: 'image/png', dataBase64: 'Zm9v', name: 'shot.png', byteLength: 999 }],
    })
    assert.deepEqual(okResult, { ok: true, session: SENT_SESSION })
    assert.equal(captured.length, 1)
    assert.deepEqual(captured[0]?.attachments, [
      {
        id: 'img-1',
        mediaType: 'image/png',
        dataBase64: 'Zm9v',
        name: 'shot.png',
        byteLength: 3,
      },
    ])

    // Image-only sends (empty text) are allowed at the boundary; the runtime owns
    // the payload-required check.
    await sendTurn?.(null, {
      sessionId: 'conv_1',
      message: '',
      attachments: [{ id: 'img-2', mediaType: 'image/jpeg', dataBase64: 'YmFy' }],
    })
    assert.equal(captured[1]?.attachments?.length, 1)

    const rejects: Array<[string, unknown]> = [
      ['bad media type', [{ id: 'x', mediaType: 'image/tiff', dataBase64: 'Zm9v' }]],
      ['non-base64 data', [{ id: 'x', mediaType: 'image/png', dataBase64: 'not base64!!' }]],
      ['oversized image', [{ id: 'x', mediaType: 'image/png', dataBase64: 'A'.repeat(8 * 1024 * 1024) }]],
      [
        'too many attachments',
        Array.from({ length: 17 }, (_, i) => ({ id: `x${i}`, mediaType: 'image/png', dataBase64: 'Zm9v' })),
      ],
      ['non-array attachments', { id: 'x', mediaType: 'image/png', dataBase64: 'Zm9v' }],
    ]
    for (const [label, attachments] of rejects) {
      const result = (await sendTurn?.(null, { sessionId: 'conv_1', message: 'hi', attachments })) as { ok: boolean }
      assert.equal(result.ok, false, `expected rejection: ${label}`)
    }
  }

  // The boundary's accepted set is the shared declaration the composer stages
  // against (1810), not a second copy of the same values. Asserted through the
  // real handler: every shared media type passes, the cap admits exactly
  // MAX_ATTACHMENTS_PER_TURN, and the ceiling admits exactly MAX_ATTACHMENT_BYTES
  // — so a limit raised on one side and not the other fails here rather than
  // mid-send in front of the user.
  async function testAttachmentLimitsAreTheSharedOnes(): Promise<void> {
    const ipcMain = createIpcMain()
    registerConversationIpc(ipcMain as unknown as Parameters<typeof registerConversationIpc>[0], {
      listProviders: async () => ({ ok: true, providers: [] }),
      getSecretStatus: async () => ({ ok: false, message: 'unused' }),
      setSecret: async () => ({ ok: false, message: 'unused' }),
      clearSecret: async () => ({ ok: false, message: 'unused' }),
      ...runtimeHandlerStubs(),
      sendTurn: async () => ({ ok: true, session: SENT_SESSION }),
    })
    const sendTurn = ipcMain.handlers.get('conversation:sessions:send-turn')
    const send = async (attachments: unknown): Promise<boolean> =>
      ((await sendTurn?.(null, { sessionId: 'conv_1', message: 'hi', attachments })) as { ok: boolean }).ok

    for (const mediaType of ATTACHABLE_IMAGE_TYPES) {
      assert.equal(await send([{ id: 'x', mediaType, dataBase64: 'Zm9v' }]), true, `${mediaType} is accepted`)
    }
    assert.equal(
      await send([{ id: 'x', mediaType: 'image/svg+xml', dataBase64: 'Zm9v' }]),
      false,
      'a type outside the shared set is refused, so the composer must not offer it',
    )

    const image = (i: number) => ({ id: `x${i}`, mediaType: 'image/png', dataBase64: 'Zm9v' })
    assert.equal(
      await send(Array.from({ length: MAX_ATTACHMENTS_PER_TURN }, (_, i) => image(i))),
      true,
      'a turn filled exactly to the shared cap passes',
    )
    assert.equal(
      await send(Array.from({ length: MAX_ATTACHMENTS_PER_TURN + 1 }, (_, i) => image(i))),
      false,
      'one past the shared cap is refused',
    )

    assert.equal(
      await send([{ id: 'x', mediaType: 'image/png', dataBase64: base64OfBytes(MAX_ATTACHMENT_BYTES) }]),
      true,
      'an image exactly at the shared ceiling fits',
    )
    assert.equal(
      await send([{ id: 'x', mediaType: 'image/png', dataBase64: base64OfBytes(MAX_ATTACHMENT_BYTES + 1) }]),
      false,
      'one byte past the shared ceiling is refused',
    )
  }

  // Well-formed base64 that decodes to exactly `bytes`: 4 chars per 3 bytes, with
  // '=' padding dropping the remainder. Derived rather than hardcoded so the byte
  // assertions stay exact if the ceiling moves.
  function base64OfBytes(bytes: number): string {
    const groups = Math.ceil(bytes / 3)
    const padding = groups * 3 - bytes
    return 'A'.repeat(groups * 4 - padding) + '='.repeat(padding)
  }

  const SENT_SESSION = {
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock-provider',
    modelId: 'mock-model',
    status: 'ready' as const,
    createdAt: 1,
    updatedAt: 1,
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
    | 'listProviderModels'
    | 'startSession'
    | 'sendTurn'
    | 'interrupt'
    | 'respondToRequest'
    | 'setPermission'
    | 'stopSession'
    | 'listSessions'
    | 'readTranscript'
    | 'onEvent'
  > {
    return {
      listProviderModels: async () => ({ ok: true, models: [] }),
      startSession: async () => ({ ok: false, message: 'unused' }),
      sendTurn: async () => ({ ok: false, message: 'unused' }),
      interrupt: async () => ({ ok: false, message: 'unused' }),
      respondToRequest: async () => ({ ok: false, message: 'unused' }),
      setPermission: async () => ({ ok: false, message: 'unused' }),
      stopSession: async () => ({ ok: false, message: 'unused' }),
      listSessions: () => ({ ok: true, sessions: [] }),
      readTranscript: async () => ({ ok: false, message: 'unused' }),
      onEvent: () => () => undefined,
    }
  }

  const suiteRun = main().catch((err) => {
    console.error(err)
    process.exit(1)
  })

  await suiteRun
})
