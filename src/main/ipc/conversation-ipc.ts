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
  ConversationCliRuntimeOverrides,
  ConversationEvent,
  ConversationImageAttachment,
  ConversationInterruptInput,
  ConversationProvidersListInput,
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
  ConversationTranscriptInput,
  ConversationTranscriptResult,
} from '../../shared/conversation-runtime'
import { ConversationRuntime } from '../conversation-runtime'
import { detectCli } from '../cli-runtime-install'
import { getConversationProviderById, listConversationProviderRegistryEntries } from '../plugin-registry-instance'
import { listOpenAiCompatibleModels, testOpenAiCompatibleConnection } from '../providers/openai-compatible-provider'
import { getSharedCredentialStore } from '../secret-store'

export type ConversationIpcHandlers = {
  listProviders(input?: ConversationProvidersListInput): Promise<ConversationProviderListResult>
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
  readTranscript(input: ConversationTranscriptInput): Promise<ConversationTranscriptResult>
  onEvent(listener: (event: ConversationEvent) => void): () => void
}

// Agent-harness conversation providers ride a local CLI; when that CLI is not
// installed the provider is hidden from the picker instead of failing at
// session start.
const AGENT_HARNESS_CLI_BY_PROVIDER: Record<string, 'claude-code'> = {
  'claude-agent': 'claude-code',
}

const CLI_AVAILABLE_TTL_MS = 60_000
// Negatives expire faster than positives so a just-installed CLI shows up
// quickly — but not so fast that every provider-list call re-runs the
// multi-second shell probes while the CLI is genuinely absent (the provider
// stays listed with its `unavailable` reason meanwhile).
const CLI_UNAVAILABLE_TTL_MS = 30_000

export function createConversationIpcHandlers(
  // The app passes its shared runtime (owned by app-services so shutdown and
  // diagnostics reach it); constructing one here keeps tests/legacy callers
  // working standalone.
  runtime: ConversationRuntime = new ConversationRuntime({ secretStore: getSharedCredentialStore() })
): ConversationIpcHandlers {
  const secretStore = getSharedCredentialStore()
  const cliChecks = new Map<string, { at: number; installed: boolean }>()

  async function isHarnessCliInstalled(
    cli: 'claude-code',
    cliRuntimes?: ConversationCliRuntimeOverrides
  ): Promise<boolean> {
    const override = cliRuntimes?.[cli]
    const cacheKey = `${cli}:${override?.command?.trim() ?? ''}:${override?.useWsl === true}`
    const cached = cliChecks.get(cacheKey)
    if (cached && Date.now() - cached.at < (cached.installed ? CLI_AVAILABLE_TTL_MS : CLI_UNAVAILABLE_TTL_MS)) {
      return cached.installed
    }
    try {
      const detection = await detectCli(cli, override)
      const installed = detection.installed && Boolean(detection.resolvedPath)
      cliChecks.set(cacheKey, { at: Date.now(), installed })
      return installed
    } catch {
      // Fail open: a probe error must not silently hide the provider — a
      // missing CLI still fails loudly (and actionably) at session start.
      return true
    }
  }

  return {
    async listProviders(input?: ConversationProvidersListInput): Promise<ConversationProviderListResult> {
      try {
        const providers = listConversationProviderRegistryEntries()
        const listed: typeof providers = []
        for (const provider of providers) {
          const harnessCli = AGENT_HARNESS_CLI_BY_PROVIDER[provider.id]
          if (harnessCli && !(await isHarnessCliInstalled(harnessCli, input?.cliRuntimes))) {
            // Never hide the provider: an undetectable CLI is annotated so the
            // picker can say WHY it is unavailable (spawn defaults skip it).
            listed.push({
              ...provider,
              unavailable: `The ${provider.displayName} CLI wasn’t found from the app. Launch Multicode from a terminal, or set a command override in Settings → CLI runtimes.`,
            })
            continue
          }
          listed.push(provider)
        }
        return { ok: true, providers: listed }
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
    readTranscript(input: ConversationTranscriptInput): Promise<ConversationTranscriptResult> {
      return runtime.readTranscript(input)
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

  ipcMain.handle('conversation:providers:list', async (_, input: unknown): Promise<ConversationProviderListResult> => {
    if (input !== undefined && !isObject(input)) return { ok: false, message: 'Provider list input must be an object.' }
    try {
      return await handlers.listProviders(input as ConversationProvidersListInput | undefined)
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

  ipcMain.handle('conversation:transcript', async (_, input: unknown): Promise<ConversationTranscriptResult> => {
    const parsed = parseTranscriptInput(input)
    if (!parsed.ok) return parsed
    try {
      return await handlers.readTranscript(parsed.input)
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
  const { workspaceRoot, workspaceId, agentId, providerId, modelId, cliRuntimes, permissionPreset, allowedTools } = input
  if (typeof workspaceRoot !== 'string') return { ok: false, message: 'workspaceRoot is required.' }
  if (typeof workspaceId !== 'string') return { ok: false, message: 'workspaceId is required.' }
  if (typeof agentId !== 'string') return { ok: false, message: 'agentId is required.' }
  if (typeof providerId !== 'string') return { ok: false, message: 'providerId is required.' }
  if (typeof modelId !== 'string') return { ok: false, message: 'modelId is required.' }
  if (cliRuntimes !== undefined && !isObject(cliRuntimes)) {
    return { ok: false, message: 'cliRuntimes must be an object when present.' }
  }
  if (
    permissionPreset !== undefined
    && (typeof permissionPreset !== 'string' || !['default', 'auto_workspace', 'bypass_all'].includes(permissionPreset))
  ) {
    return { ok: false, message: 'permissionPreset must be default, auto_workspace, or bypass_all.' }
  }
  if (
    allowedTools !== undefined
    && (!Array.isArray(allowedTools) || allowedTools.some((tool) => typeof tool !== 'string'))
  ) {
    return { ok: false, message: 'allowedTools must be an array of tool names.' }
  }
  return {
    ok: true,
    input: {
      workspaceRoot,
      workspaceId,
      agentId,
      providerId,
      modelId,
      ...(isObject(cliRuntimes) ? { cliRuntimes: cliRuntimes as ConversationCliRuntimeOverrides } : {}),
      ...(typeof permissionPreset === 'string'
        ? { permissionPreset: permissionPreset as ConversationStartSessionInput['permissionPreset'] }
        : {}),
      ...(Array.isArray(allowedTools) ? { allowedTools: allowedTools as string[] } : {}),
    },
  }
}

function parseTranscriptInput(input: unknown):
  | { ok: true; input: ConversationTranscriptInput }
  | { ok: false; message: string } {
  if (!isObject(input)) return { ok: false, message: 'Transcript input must be an object.' }
  const { workspaceRoot, workspaceId, agentId } = input
  if (typeof workspaceRoot !== 'string') return { ok: false, message: 'workspaceRoot is required.' }
  if (typeof workspaceId !== 'string') return { ok: false, message: 'workspaceId is required.' }
  if (typeof agentId !== 'string') return { ok: false, message: 'agentId is required.' }
  return { ok: true, input: { workspaceRoot, workspaceId, agentId } }
}

// Image attachments accepted on a send-turn. The set mirrors the base64 image
// media types the Claude Agent SDK (and the Anthropic API) accept; anything
// else is rejected at the boundary rather than failing deep in the provider.
const ALLOWED_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
// Per-image decoded-byte ceiling (matches the Anthropic API's ~5 MB image
// limit). The renderer downscales before sending; oversized images are
// rejected here with a clear error so nothing silently truncates.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
// A generous per-turn cap so a runaway paste cannot push an unbounded payload
// through IPC; well above any realistic manual attach count.
const MAX_ATTACHMENTS_PER_TURN = 16
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

// Decoded byte length of a base64 string without allocating the buffer.
function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

function parseImageAttachments(raw: unknown):
  | { ok: true; attachments: ConversationImageAttachment[] }
  | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: 'attachments must be an array when present.' }
  if (raw.length > MAX_ATTACHMENTS_PER_TURN) {
    return { ok: false, message: `A turn can carry at most ${MAX_ATTACHMENTS_PER_TURN} attachments.` }
  }
  const attachments: ConversationImageAttachment[] = []
  for (const entry of raw) {
    if (!isObject(entry)) return { ok: false, message: 'Each attachment must be an object.' }
    const { id, mediaType, dataBase64, name, byteLength } = entry
    if (typeof id !== 'string' || !id.trim()) return { ok: false, message: 'Attachment id is required.' }
    if (typeof mediaType !== 'string' || !ALLOWED_IMAGE_MEDIA_TYPES.has(mediaType)) {
      return { ok: false, message: 'Attachments must be PNG, JPEG, WebP, or GIF images.' }
    }
    if (typeof dataBase64 !== 'string' || !dataBase64 || !BASE64_PATTERN.test(dataBase64) || dataBase64.length % 4 !== 0) {
      return { ok: false, message: 'Attachment image data must be base64-encoded.' }
    }
    if (name !== undefined && typeof name !== 'string') {
      return { ok: false, message: 'Attachment name must be a string when present.' }
    }
    // Trust the decoded length over the client-supplied byteLength for the guard.
    const decodedBytes = base64ByteLength(dataBase64)
    if (decodedBytes > MAX_IMAGE_BYTES) {
      return { ok: false, message: 'Each attached image must be 5 MB or smaller.' }
    }
    if (byteLength !== undefined && typeof byteLength !== 'number') {
      return { ok: false, message: 'Attachment byteLength must be a number when present.' }
    }
    attachments.push({
      id,
      mediaType,
      dataBase64,
      ...(typeof name === 'string' ? { name } : {}),
      byteLength: decodedBytes,
    })
  }
  return { ok: true, attachments }
}

function parseSendTurnInput(input: unknown):
  | { ok: true; input: ConversationSendTurnInput }
  | { ok: false; message: string } {
  const session = parseSessionIdInput(input)
  if (!session.ok) return session
  if (!isObject(input) || typeof input.message !== 'string') return { ok: false, message: 'message is required.' }
  if ('localTurnId' in input && input.localTurnId !== undefined && typeof input.localTurnId !== 'string') {
    return { ok: false, message: 'localTurnId must be a string when present.' }
  }
  let attachments: ConversationImageAttachment[] | undefined
  if ('attachments' in input && input.attachments !== undefined) {
    const parsed = parseImageAttachments(input.attachments)
    if (!parsed.ok) return parsed
    if (parsed.attachments.length > 0) attachments = parsed.attachments
  }
  return {
    ok: true,
    input: {
      sessionId: session.input.sessionId,
      message: input.message,
      ...(typeof input.localTurnId === 'string' ? { localTurnId: input.localTurnId } : {}),
      ...(attachments ? { attachments } : {}),
    },
  }
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
  let answers: Record<string, string> | undefined
  if ('answers' in input && input.answers !== undefined) {
    if (!isObject(input.answers) || Object.values(input.answers).some((value) => typeof value !== 'string')) {
      return { ok: false, message: 'answers must map question text to answer strings.' }
    }
    answers = input.answers as Record<string, string>
  }
  return {
    ok: true,
    input: {
      sessionId: session.input.sessionId,
      requestId: input.requestId,
      approved: input.approved,
      ...(answers ? { answers } : {}),
    },
  }
}
