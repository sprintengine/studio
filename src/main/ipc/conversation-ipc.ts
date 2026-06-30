import type { IpcMain } from 'electron'

import type {
  ConversationProviderListResult,
  ConversationProviderModelsInput,
  ConversationProviderModelsResult,
  ConversationSecretClearInput,
  ConversationSecretClearResult,
  ConversationSecretSetInput,
  ConversationSecretSetResult,
  ConversationSecretStatusInput,
  ConversationSecretStatusResult,
} from '../../shared/electron-api'
import type {
  ConversationEvent,
  ConversationInterruptInput,
  ConversationListSessionsInput,
  ConversationListSessionsResult,
  ConversationProviderTestInput,
  ConversationProviderTestResult,
  ConversationRespondToRequestInput,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationStopSessionInput,
} from '../../shared/conversation-runtime'
import { ConversationRuntime } from '../conversation-runtime'
import { getConversationProviderById, listConversationProviderRegistryEntries } from '../plugin-registry-instance'
import { listOpenAiCompatibleModels, testOpenAiCompatibleConnection } from '../providers/openai-compatible-provider'
import { getSharedCredentialStore } from '../secret-store'

export type ConversationIpcHandlers = {
  listProviders(): ConversationProviderListResult
  listProviderModels(input: ConversationProviderModelsInput): Promise<ConversationProviderModelsResult>
  testProvider(input: ConversationProviderTestInput): Promise<ConversationProviderTestResult>
  getSecretStatus(input: ConversationSecretStatusInput): Promise<ConversationSecretStatusResult>
  setSecret(input: ConversationSecretSetInput): Promise<ConversationSecretSetResult>
  clearSecret(input: ConversationSecretClearInput): Promise<ConversationSecretClearResult>
  startSession(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult>
  sendTurn(input: ConversationSendTurnInput): Promise<ConversationSessionActionResult>
  interrupt(input: ConversationInterruptInput): Promise<ConversationSessionActionResult>
  respondToRequest(input: ConversationRespondToRequestInput): Promise<ConversationSessionActionResult>
  stopSession(input: ConversationStopSessionInput): Promise<ConversationSessionActionResult>
  listSessions(input?: ConversationListSessionsInput): ConversationListSessionsResult
  onEvent(listener: (event: ConversationEvent) => void): () => void
}

export function createConversationIpcHandlers(): ConversationIpcHandlers {
  const secretStore = getSharedCredentialStore()
  const runtime = new ConversationRuntime({ secretStore })
  return {
    listProviders(): ConversationProviderListResult {
      try {
        return { ok: true, providers: listConversationProviderRegistryEntries() }
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
    listProviderModels(input: ConversationProviderModelsInput): Promise<ConversationProviderModelsResult> {
      return listOpenAiCompatibleModels({
        providerId: input.providerId,
        getProviderById: getConversationProviderById,
        resolveSecret: (providerId) => secretStore.resolveSecret(providerId),
      })
    },
    getSecretStatus(input: ConversationSecretStatusInput): Promise<ConversationSecretStatusResult> {
      return secretStore.getStatus(input.providerId)
    },
    testProvider(input: ConversationProviderTestInput): Promise<ConversationProviderTestResult> {
      return testOpenAiCompatibleConnection({
        providerId: input.providerId,
        modelId: input.modelId,
        getProviderById: getConversationProviderById,
        resolveSecret: (providerId) => secretStore.resolveSecret(providerId),
      })
    },
    setSecret(input: ConversationSecretSetInput): Promise<ConversationSecretSetResult> {
      return secretStore.setSecret(input.providerId, input.value)
    },
    clearSecret(input: ConversationSecretClearInput): Promise<ConversationSecretClearResult> {
      return secretStore.clearSecret(input.providerId)
    },
    startSession(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult> {
      return runtime.startSession(input)
    },
    sendTurn(input: ConversationSendTurnInput): Promise<ConversationSessionActionResult> {
      return runtime.sendTurn(input)
    },
    interrupt(input: ConversationInterruptInput): Promise<ConversationSessionActionResult> {
      return runtime.interrupt(input)
    },
    respondToRequest(input: ConversationRespondToRequestInput): Promise<ConversationSessionActionResult> {
      return runtime.respondToRequest(input)
    },
    stopSession(input: ConversationStopSessionInput): Promise<ConversationSessionActionResult> {
      return runtime.stopSession(input)
    },
    listSessions(input?: ConversationListSessionsInput): ConversationListSessionsResult {
      return runtime.listSessions(input)
    },
    onEvent(listener: (event: ConversationEvent) => void): () => void {
      return runtime.onEvent(listener)
    },
  }
}

export function registerConversationIpc(
  ipcMain: IpcMain,
  handlers: ConversationIpcHandlers = createConversationIpcHandlers()
): void {
  let nextSubscriptionId = 0
  const eventSubscriptions = new Map<string, {
    unsubscribe: () => void
    removeDestroyedListener: () => void
  }>()

  ipcMain.handle('conversation:providers:list', async (): Promise<ConversationProviderListResult> => {
    try {
      return handlers.listProviders()
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle('conversation:providers:models', async (_, input: unknown): Promise<ConversationProviderModelsResult> => {
    const parsed = parseProviderInput(input)
    if (!parsed.ok) return parsed
    try {
      return await handlers.listProviderModels(parsed.input)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle(
    'conversation:secrets:status',
    async (_, input: unknown): Promise<ConversationSecretStatusResult> => {
      const parsed = parseProviderInput(input)
      if (!parsed.ok) return parsed
      try {
        return handlers.getSecretStatus(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    }
  )

  ipcMain.handle('conversation:providers:test', async (_, input: unknown): Promise<ConversationProviderTestResult> => {
    const parsed = parseProviderTestInput(input)
    if (!parsed.ok) return { ok: false, status: { providerId: '', state: 'invalid_endpoint', message: parsed.message } }
    try {
      return handlers.testProvider(parsed.input)
    } catch (err) {
      return { ok: false, status: { providerId: parsed.input.providerId, state: 'network_error', message: formatError(err) } }
    }
  })

  ipcMain.handle('conversation:secrets:set', async (_, input: unknown): Promise<ConversationSecretSetResult> => {
    const parsed = parseSecretSetInput(input)
    if (!parsed.ok) return parsed
    try {
      return handlers.setSecret(parsed.input)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle('conversation:secrets:clear', async (_, input: unknown): Promise<ConversationSecretClearResult> => {
    const parsed = parseProviderInput(input)
    if (!parsed.ok) return parsed
    try {
      return handlers.clearSecret(parsed.input)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle('conversation:sessions:start', async (_, input: unknown): Promise<ConversationStartSessionResult> => {
    const parsed = parseStartSessionInput(input)
    if (!parsed.ok) return parsed
    try {
      return handlers.startSession(parsed.input)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle('conversation:sessions:send-turn', async (_, input: unknown): Promise<ConversationSessionActionResult> => {
    const parsed = parseSendTurnInput(input)
    if (!parsed.ok) return parsed
    try {
      return handlers.sendTurn(parsed.input)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle('conversation:sessions:interrupt', async (_, input: unknown): Promise<ConversationSessionActionResult> => {
    const parsed = parseSessionIdInput(input)
    if (!parsed.ok) return parsed
    try {
      return handlers.interrupt(parsed.input)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle(
    'conversation:sessions:respond-to-request',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseRespondToRequestInput(input)
      if (!parsed.ok) return parsed
      try {
        return handlers.respondToRequest(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    }
  )

  ipcMain.handle('conversation:sessions:stop', async (_, input: unknown): Promise<ConversationSessionActionResult> => {
    const parsed = parseSessionIdInput(input)
    if (!parsed.ok) return parsed
    try {
      return handlers.stopSession(parsed.input)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle('conversation:sessions:list', async (_, input: unknown): Promise<ConversationListSessionsResult> => {
    if (input !== undefined && !isObject(input)) return { ok: false, message: 'Session list input must be an object.' }
    try {
      return handlers.listSessions(input as ConversationListSessionsInput | undefined)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle('conversation:events:subscribe', (event): { ok: true; subscriptionId: string } => {
    const sender = event.sender
    const subscriptionId = `conversation-subscription-${++nextSubscriptionId}`
    const cleanup = (): void => {
      const subscription = eventSubscriptions.get(subscriptionId)
      if (!subscription) return
      eventSubscriptions.delete(subscriptionId)
      subscription.removeDestroyedListener()
      subscription.unsubscribe()
    }
    const unsubscribe = handlers.onEvent((conversationEvent) => {
      if (sender.isDestroyed()) {
        cleanup()
        return
      }
      sender.send('conversation:event', conversationEvent)
    })
    eventSubscriptions.set(subscriptionId, {
      unsubscribe,
      removeDestroyedListener: () => sender.removeListener('destroyed', cleanup),
    })
    sender.once('destroyed', cleanup)
    return { ok: true, subscriptionId }
  })

  ipcMain.handle('conversation:events:unsubscribe', (_event, input: unknown): { ok: true } | { ok: false; message: string } => {
    if (!isObject(input) || typeof input.subscriptionId !== 'string') {
      return { ok: false, message: 'subscriptionId is required.' }
    }
    const subscription = eventSubscriptions.get(input.subscriptionId)
    if (subscription) {
      eventSubscriptions.delete(input.subscriptionId)
      subscription.removeDestroyedListener()
      subscription.unsubscribe()
    }
    return { ok: true }
  })
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function parseProviderInput(input: unknown):
  | { ok: true; input: ConversationSecretStatusInput }
  | { ok: false; message: string } {
  if (!isObject(input) || typeof input.providerId !== 'string') {
    return { ok: false, message: 'providerId is required.' }
  }
  return { ok: true, input: { providerId: input.providerId } }
}

function parseProviderTestInput(input: unknown):
  | { ok: true; input: ConversationProviderTestInput }
  | { ok: false; message: string } {
  const parsed = parseProviderInput(input)
  if (!parsed.ok) return parsed
  if (isObject(input) && 'modelId' in input && input.modelId !== undefined && typeof input.modelId !== 'string') {
    return { ok: false, message: 'modelId must be a string when present.' }
  }
  return {
    ok: true,
    input: {
      providerId: parsed.input.providerId,
      ...(isObject(input) && typeof input.modelId === 'string' ? { modelId: input.modelId } : {}),
    },
  }
}

function parseSecretSetInput(input: unknown):
  | { ok: true; input: ConversationSecretSetInput }
  | { ok: false; message: string } {
  const parsed = parseProviderInput(input)
  if (!parsed.ok) return parsed
  if (!isObject(input) || typeof input.value !== 'string') {
    return { ok: false, message: 'Secret value is required.' }
  }
  return { ok: true, input: { providerId: parsed.input.providerId, value: input.value } }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStartSessionInput(input: unknown):
  | { ok: true; input: ConversationStartSessionInput }
  | { ok: false; message: string } {
  if (!isObject(input)) return { ok: false, message: 'Start session input must be an object.' }
  const { workspaceRoot, workspaceId, agentId, providerId, modelId } = input
  if (typeof workspaceRoot !== 'string') return { ok: false, message: 'workspaceRoot is required.' }
  if (typeof workspaceId !== 'string') return { ok: false, message: 'workspaceId is required.' }
  if (typeof agentId !== 'string') return { ok: false, message: 'agentId is required.' }
  if (typeof providerId !== 'string') return { ok: false, message: 'providerId is required.' }
  if (typeof modelId !== 'string') return { ok: false, message: 'modelId is required.' }
  return {
    ok: true,
    input: {
      workspaceRoot,
      workspaceId,
      agentId,
      providerId,
      modelId,
    },
  }
}

function parseSendTurnInput(input: unknown):
  | { ok: true; input: ConversationSendTurnInput }
  | { ok: false; message: string } {
  const session = parseSessionIdInput(input)
  if (!session.ok) return session
  if (!isObject(input) || typeof input.message !== 'string') return { ok: false, message: 'message is required.' }
  return { ok: true, input: { sessionId: session.input.sessionId, message: input.message } }
}

function parseSessionIdInput(input: unknown):
  | { ok: true; input: ConversationInterruptInput }
  | { ok: false; message: string } {
  if (!isObject(input) || typeof input.sessionId !== 'string') return { ok: false, message: 'sessionId is required.' }
  return { ok: true, input: { sessionId: input.sessionId } }
}

function parseRespondToRequestInput(input: unknown):
  | { ok: true; input: ConversationRespondToRequestInput }
  | { ok: false; message: string } {
  const session = parseSessionIdInput(input)
  if (!session.ok) return session
  if (!isObject(input) || typeof input.requestId !== 'string') return { ok: false, message: 'requestId is required.' }
  if (typeof input.approved !== 'boolean') return { ok: false, message: 'approved is required.' }
  return {
    ok: true,
    input: { sessionId: session.input.sessionId, requestId: input.requestId, approved: input.approved },
  }
}
