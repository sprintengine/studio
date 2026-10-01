import type { IpcMain, WebContents } from 'electron'
import type {
  ConversationWorkspaceKey,
  ConversationThreadsResult,
  ConversationSearchInput,
  ConversationSearchResult,
  ConversationRenameInput,
} from '../../shared/conversation-index'
import type { ConversationSearchHit } from '../../shared/conversation-index'

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
  ConversationProviderSignInInput,
  ConversationProviderSignInResult,
  ConversationListSessionsInput,
  ConversationListSessionsResult,
  ConversationRespondToRequestInput,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationSetModelInput,
  ConversationSetPermissionInput,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationStopSessionInput,
  ConversationSuspendSessionInput,
  ConversationTerminalHandoffInput,
  ConversationTerminalHandoffResult,
  ConversationTranscriptInput,
  ConversationTranscriptResult,
  ConversationToolDetailInput,
  ConversationToolDetailResult,
  ConversationAttachmentResult,
  ConversationPlanDocumentInput,
  ConversationPlanDocumentResult,
  ConversationSubscribeInput,
  ConversationLoadEarlierInput,
  ConversationSessionFrame,
  ConversationPageResult,
  ConversationTurnDiffInput,
  ConversationTurnDiffResult,
  ConversationRevertInput,
  ConversationRevertResult,
  ConversationRewindInput,
  ConversationRewindResult,
  ConversationForkInput,
  ConversationForkResult,
  ConversationApprovalRulesResult,
  ConversationApprovalRuleRevokeResult,
  ConversationEventType,
} from '../../shared/conversation-runtime'
import { CONVERSATION_PERMISSION_PRESETS } from '../../shared/conversation-runtime'
import { parseCliPermissionPreset } from '../../shared/cli-permission-preset'
import { parseCliPermissionModeId } from '../../shared/cli-permission-mode'
import {
  ATTACHABLE_IMAGE_TYPES,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_ATTACHMENT_BYTES,
} from '../../shared/conversation-attachments'
import { ConversationRuntime } from '../conversation-runtime'
import type { ConversationBackend } from '../../server/core/conversation-backend'
import { ConversationSessionApi } from '../conversation-session-api'
import { detectCli } from '../cli-runtime-install'
import { resolveConversationSignIn } from '../conversation-sign-in'
import { getConversationProviderById, listConversationProviderRegistryEntries } from '../plugin-registry-instance'
import { listOpenAiCompatibleModels } from '../providers/openai-compatible-provider'
import { getSharedCredentialStore } from '../secret-store'
import { isRecord } from '../../shared/records'
import { cliForConversationProvider } from '../../shared/conversation-harness'
import { parseConversationMentions } from '../../shared/conversation/mentions'

export type ConversationIpcHandlers = {
  listThreads?(input: ConversationWorkspaceKey): Promise<ConversationThreadsResult>
  searchThreads?(
    input: ConversationSearchInput,
    options: { signal: AbortSignal; onBatch?: (hits: ConversationSearchHit[]) => void },
  ): Promise<ConversationSearchResult>
  renameThread?(input: ConversationRenameInput): Promise<{ ok: true } | { ok: false; message: string }>
  deleteThread?(input: ConversationTranscriptInput): Promise<{ ok: true } | { ok: false; message: string }>
  listProviders(input?: ConversationProvidersListInput): Promise<ConversationProviderListResult>
  listProviderModels(input: ConversationProviderModelsInput): Promise<ConversationProviderModelsResult>
  resolveSignIn?(input: ConversationProviderSignInInput): Promise<ConversationProviderSignInResult>
  getSecretStatus(input: ConversationSecretStatusInput): Promise<ConversationSecretStatusResult>
  setSecret(input: ConversationSecretSetInput): Promise<ConversationSecretSetResult>
  clearSecret(input: ConversationSecretClearInput): Promise<ConversationSecretClearResult>
  startSession(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult>
  sendTurn(input: ConversationSendTurnInput): Promise<ConversationSessionActionResult>
  interrupt(input: ConversationInterruptInput): Promise<ConversationSessionActionResult>
  respondToRequest(input: ConversationRespondToRequestInput): Promise<ConversationSessionActionResult>
  setPermission(input: ConversationSetPermissionInput): Promise<ConversationSessionActionResult>
  setModel?(input: ConversationSetModelInput): Promise<ConversationSessionActionResult>
  stopSession(input: ConversationStopSessionInput): Promise<ConversationSessionActionResult>
  suspendSession?(input: ConversationSuspendSessionInput): Promise<ConversationSessionActionResult>
  terminalHandoff?(input: ConversationTerminalHandoffInput): Promise<ConversationTerminalHandoffResult>
  listSessions(input?: ConversationListSessionsInput): ConversationListSessionsResult
  readTranscript(input: ConversationTranscriptInput): Promise<ConversationTranscriptResult>
  getToolDetail?(input: ConversationToolDetailInput): Promise<ConversationToolDetailResult>
  readAttachment?(ref: string): Promise<ConversationAttachmentResult>
  planDocument?(input: ConversationPlanDocumentInput): Promise<ConversationPlanDocumentResult>
  subscribe?(
    input: ConversationSubscribeInput,
    listener: (frame: ConversationSessionFrame) => void,
  ): { dispose: () => void; ready: Promise<void> }
  loadEarlier?(input: ConversationLoadEarlierInput): Promise<ConversationPageResult>
  getTurnDiff?(input: ConversationTurnDiffInput): Promise<ConversationTurnDiffResult>
  revertToTurn?(input: ConversationRevertInput): Promise<ConversationRevertResult>
  rewindToTurn?(input: ConversationRewindInput): Promise<ConversationRewindResult>
  forkAtTurn?(input: ConversationForkInput): Promise<ConversationForkResult>
  listApprovalRules?(): Promise<ConversationApprovalRulesResult>
  revokeApprovalRule?(ruleId: string): Promise<ConversationApprovalRuleRevokeResult>
  onEvent(listener: (event: ConversationEvent) => void): () => void
}

/**
 * What the all-conversations channel (`conversation:event`) forwards: a chat's
 * lifecycle and status, never its per-token stream. Every workspace window
 * subscribes, and its readers (the session list, the history rows) only ask
 * whether a chat started, moved, waited or ended. Reply and reasoning deltas,
 * and a running tool's partial output, went to every window, hidden ones
 * included, dozens of times a second per streaming chat, only to be dropped
 * there. The pane showing a chat reads its stream on the scoped channel
 * (`conversation:session-event`), which is unchanged.
 */
const BROADCAST_EVENT_TYPES: ReadonlySet<ConversationEventType> = new Set<ConversationEventType>([
  'session_started',
  'session_ready',
  'session_updated',
  'session_closed',
  'user_message',
  'turn_started',
  'tool_started',
  'tool_output',
  'approval_requested',
  'approval_resolved',
  'usage_updated',
  'context_compacted',
  'command_output',
  'turn_completed',
  'turn_failed',
  'subagent_status',
  'subagent_message',
])

export function isConversationBroadcastEvent(event: ConversationEvent): boolean {
  if (!BROADCAST_EVENT_TYPES.has(event.type)) return false
  // A running tool's output streams; its final output says the tool is done.
  return !(event.type === 'tool_output' && event.payload?.partial === true)
}

// Agent-harness conversation providers ride a local CLI (the shared table in
// conversation-harness); when that CLI is not installed the provider is hidden
// from the picker instead of failing at session start.

const CLI_AVAILABLE_TTL_MS = 60_000
// Negatives expire faster than positives so a just-installed CLI shows up
// quickly — but not so fast that every provider-list call re-runs the
// multi-second shell probes while the CLI is genuinely absent (the provider
// stays listed with its `unavailable` reason meanwhile).
const CLI_UNAVAILABLE_TTL_MS = 30_000

export function createConversationIpcHandlers(
  // The app passes the core's chats (the core owns the runtime, so shutdown and
  // diagnostics reach it); constructing a runtime here keeps tests/legacy
  // callers working standalone.
  runtime: ConversationBackend = new ConversationRuntime({ secretStore: getSharedCredentialStore() }),
): ConversationIpcHandlers {
  const secretStore = getSharedCredentialStore()
  const sessions = new ConversationSessionApi(runtime)
  const cliChecks = new Map<string, { at: number; installed: boolean }>()

  async function isHarnessCliInstalled(cli: string, cliRuntimes?: ConversationCliRuntimeOverrides): Promise<boolean> {
    const override = cliRuntimes?.[cli]
    const cacheKey = `${cli}:${override?.command?.trim() ?? ''}:${override?.hostId ?? 'local'}`
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
    listThreads: (input) => runtime.listThreads(input),
    searchThreads: (input, options) => runtime.searchThreads(input, options),
    renameThread: (input) => runtime.renameThread(input),
    deleteThread: (input) => runtime.deleteTranscript(input),
    async listProviders(input?: ConversationProvidersListInput): Promise<ConversationProviderListResult> {
      try {
        const providers = listConversationProviderRegistryEntries().map((provider) => ({
          ...provider,
          capabilities: runtime.getProviderCapabilities(provider.id),
        }))
        const listed: typeof providers = []
        for (const provider of providers) {
          const harnessCli = cliForConversationProvider(provider.id)
          if (harnessCli && !(await isHarnessCliInstalled(harnessCli, input?.cliRuntimes))) {
            // Never hide the provider: an undetectable CLI is annotated so the
            // picker can say WHY it is unavailable (spawn defaults skip it).
            listed.push({
              ...provider,
              unavailable: `The ${provider.displayName} CLI wasn’t found from the app. Launch SprintEngine from a terminal, or set a command override in Settings → CLI runtimes.`,
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
      const nativeModels = runtime.getNativeProviderModels(input.providerId)
      if (nativeModels) return Promise.resolve({ ok: true, models: nativeModels })
      return listOpenAiCompatibleModels({
        providerId: input.providerId,
        getProviderById: getConversationProviderById,
        resolveSecret: (providerId) => secretStore.resolveSecret(providerId),
      })
    },
    resolveSignIn(input: ConversationProviderSignInInput): Promise<ConversationProviderSignInResult> {
      return resolveConversationSignIn(input)
    },
    getSecretStatus(input: ConversationSecretStatusInput): Promise<ConversationSecretStatusResult> {
      return secretStore.getStatus(input.providerId)
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
    setPermission(input: ConversationSetPermissionInput): Promise<ConversationSessionActionResult> {
      return runtime.setPermission(input)
    },
    setModel(input: ConversationSetModelInput): Promise<ConversationSessionActionResult> {
      return runtime.setModel(input)
    },
    stopSession(input: ConversationStopSessionInput): Promise<ConversationSessionActionResult> {
      return runtime.stopSession(input)
    },
    suspendSession(input: ConversationSuspendSessionInput): Promise<ConversationSessionActionResult> {
      return runtime.suspendSession(input)
    },
    listSessions(input?: ConversationListSessionsInput): ConversationListSessionsResult {
      return runtime.listSessions(input)
    },
    readTranscript(input: ConversationTranscriptInput): Promise<ConversationTranscriptResult> {
      return runtime.readTranscript(input)
    },
    readAttachment(ref) {
      return runtime.readAttachment(ref)
    },
    planDocument(input) {
      return runtime.planDocument(input)
    },
    getToolDetail(input) {
      return runtime.getToolDetail(input)
    },
    listApprovalRules() {
      return runtime.listApprovalRules()
    },
    revokeApprovalRule(ruleId) {
      return runtime.revokeApprovalRule(ruleId)
    },
    subscribe(input, listener) {
      return sessions.subscribe(input, listener)
    },
    loadEarlier(input) {
      return sessions.loadEarlier(input)
    },
    getTurnDiff(input) {
      return sessions.getTurnDiff(input)
    },
    revertToTurn(input) {
      return sessions.revertToTurn(input)
    },
    rewindToTurn(input) {
      return sessions.rewindToTurn(input)
    },
    forkAtTurn(input) {
      return sessions.forkAtTurn(input)
    },
    onEvent(listener: (event: ConversationEvent) => void): () => void {
      return runtime.onEvent(listener)
    },
  }
}

export function registerConversationIpc(
  ipcMain: IpcMain,
  handlers: ConversationIpcHandlers = createConversationIpcHandlers(),
): void {
  let nextSubscriptionId = 0
  const eventSubscriptions = new Map<string, { senderId: number; dispose: () => void }>()
  const scopedSubscriptions = new Map<string, { senderId: number; dispose: () => void }>()
  // A reload keeps the webContents, so `destroyed` never fires for the page it
  // replaced: the new page subscribes again while the old page's subscriptions
  // keep sending to the same sender, one more copy of every event per reload.
  // Navigation ends everything the page held, as it does for the git watch.
  const watchedSenders = new WeakSet<WebContents>()
  const releaseOnNavigation = (sender: WebContents): void => {
    if (watchedSenders.has(sender)) return
    watchedSenders.add(sender)
    const senderId = sender.id
    // Emitted for main-frame, cross-document navigations only — a reload is
    // one — once the new page has committed, before its scripts run.
    sender.on('did-navigate', () => {
      for (const subscription of [...eventSubscriptions.values(), ...scopedSubscriptions.values()])
        if (subscription.senderId === senderId) subscription.dispose()
    })
  }
  const searches = new Map<string, AbortController>()
  ipcMain.handle('conversation:threads', (_, input: unknown) => {
    const parsed = parseTranscriptInput(isRecord(input) ? { ...input, agentId: 'history' } : input)
    if (!parsed.ok) return parsed
    return handlers.listThreads?.(parsed.input) ?? { ok: false, message: 'Conversation history is unavailable.' }
  })
  ipcMain.handle('conversation:search', async (event, input: unknown) => {
    const parsed = parseTranscriptInput(isRecord(input) ? { ...input, agentId: 'history' } : input)
    if (!parsed.ok) return parsed
    if (
      !isRecord(input) ||
      typeof input.query !== 'string' ||
      input.query.length > 1000 ||
      (input.requestId !== undefined && (typeof input.requestId !== 'string' || input.requestId.length > 200))
    )
      return { ok: false, message: 'Search query and optional request identity are required.' }
    const key = `${event.sender.id}:${input.requestId ?? ++nextSubscriptionId}`
    searches.get(key)?.abort()
    const controller = new AbortController()
    searches.set(key, controller)
    const dispose = () => controller.abort()
    event.sender.once('destroyed', dispose)
    try {
      return (
        (await handlers.searchThreads?.(
          { ...parsed.input, query: input.query, requestId: input.requestId as string | undefined },
          {
            signal: controller.signal,
            onBatch: (hits) => {
              if (typeof input.requestId === 'string' && !controller.signal.aborted && !event.sender.isDestroyed())
                event.sender.send('conversation:search:batch', { requestId: input.requestId, hits })
            },
          },
        )) ?? { ok: false, message: 'Conversation search is unavailable.' }
      )
    } finally {
      event.sender.removeListener('destroyed', dispose)
      if (searches.get(key) === controller) searches.delete(key)
    }
  })
  ipcMain.handle('conversation:search:cancel', (event, input: unknown) => {
    if (!isRecord(input) || typeof input.requestId !== 'string') return { ok: false }
    searches.get(`${event.sender.id}:${input.requestId}`)?.abort()
    return { ok: true }
  })
  ipcMain.handle('conversation:rename', (_, input: unknown) => {
    const parsed = parseTranscriptInput(input)
    if (!parsed.ok) return parsed
    if (!isRecord(input) || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200)
      return { ok: false, message: 'A title of 1–200 characters is required.' }
    return (
      handlers.renameThread?.({ ...parsed.input, title: input.title }) ?? {
        ok: false,
        message: 'Conversation history is unavailable.',
      }
    )
  })
  ipcMain.handle('conversation:delete', (_, input: unknown) => {
    const parsed = parseTranscriptInput(input)
    if (!parsed.ok) return parsed
    return handlers.deleteThread?.(parsed.input) ?? { ok: false, message: 'Conversation history is unavailable.' }
  })
  ipcMain.handle(
    'conversation:approval-rules:list',
    () => handlers.listApprovalRules?.() ?? { ok: false, message: 'Permission rules are unavailable.' },
  )
  ipcMain.handle('conversation:approval-rules:revoke', (_, input: unknown) => {
    if (!isRecord(input) || typeof input.ruleId !== 'string')
      return { ok: false, message: 'Rule identity is required.' }
    return handlers.revokeApprovalRule?.(input.ruleId) ?? { ok: false, message: 'Permission rules are unavailable.' }
  })
  ipcMain.handle('conversation:turn:diff', async (_, input: unknown): Promise<ConversationTurnDiffResult> => {
    if (
      !isRecord(input) ||
      !Number.isSafeInteger(input.turnSeq) ||
      Number(input.turnSeq) < 1 ||
      (input.path !== undefined && typeof input.path !== 'string')
    )
      return { ok: false, message: 'Turn sequence and optional file path are required.' }
    const key = parseTranscriptInput(input.key)
    if (!key.ok) return key
    return (
      handlers.getTurnDiff?.({
        key: key.input,
        turnSeq: Number(input.turnSeq),
        path: input.path as string | undefined,
      }) ?? { ok: false, message: 'Checkpoints are unavailable.' }
    )
  })
  ipcMain.handle('conversation:turn:revert', async (_, input: unknown): Promise<ConversationRevertResult> => {
    if (
      !isRecord(input) ||
      !Number.isSafeInteger(input.turnSeq) ||
      Number(input.turnSeq) < 1 ||
      (input.confirmed !== undefined && typeof input.confirmed !== 'boolean') ||
      (input.undo !== undefined && typeof input.undo !== 'boolean') ||
      (input.files !== undefined &&
        (!Array.isArray(input.files) || !input.files.every((path) => typeof path === 'string')))
    )
      return { ok: false, message: 'Turn sequence and explicit confirmation are required.' }
    const key = parseTranscriptInput(input.key)
    if (!key.ok) return key
    return (
      handlers.revertToTurn?.({
        key: key.input,
        turnSeq: Number(input.turnSeq),
        confirmed: input.confirmed === true,
        undo: input.undo === true,
        ...(Array.isArray(input.files) ? { files: input.files as string[] } : {}),
      }) ?? { ok: false, message: 'Checkpoints are unavailable.' }
    )
  })
  ipcMain.handle('conversation:turn:rewind', async (_, input: unknown): Promise<ConversationRewindResult> => {
    if (!isRecord(input) || !Number.isSafeInteger(input.turnSeq) || Number(input.turnSeq) < 1)
      return { ok: false, message: 'The message to edit is required.' }
    const key = parseTranscriptInput(input.key)
    if (!key.ok) return key
    return (
      handlers.rewindToTurn?.({ key: key.input, turnSeq: Number(input.turnSeq) }) ?? {
        ok: false,
        message: 'Editing an earlier message is unavailable.',
      }
    )
  })
  ipcMain.handle('conversation:turn:fork', async (_, input: unknown): Promise<ConversationForkResult> => {
    if (
      !isRecord(input) ||
      typeof input.newAgentId !== 'string' ||
      !input.newAgentId.trim() ||
      (input.title !== undefined && typeof input.title !== 'string') ||
      (input.side === 'user'
        ? !Number.isSafeInteger(input.turnSeq) || Number(input.turnSeq) < 1
        : input.side !== 'assistant' || typeof input.turnId !== 'string' || !input.turnId)
    )
      return { ok: false, message: 'The message to fork from is required.' }
    const key = parseTranscriptInput(input.key)
    if (!key.ok) return key
    const common = {
      key: key.input,
      newAgentId: input.newAgentId,
      ...(typeof input.title === 'string' ? { title: input.title } : {}),
    }
    return (
      handlers.forkAtTurn?.(
        input.side === 'user'
          ? { ...common, side: 'user', turnSeq: Number(input.turnSeq) }
          : { ...common, side: 'assistant', turnId: input.turnId as string },
      ) ?? { ok: false, message: 'Forking a conversation is unavailable.' }
    )
  })
  ipcMain.handle('conversation:session:subscribe', (event, input: unknown) => {
    if (!isRecord(input) || typeof input.subscriptionId !== 'string' || !isRecord(input.key))
      return { ok: false, message: 'Subscription identity is required.' }
    const parsed = parseTranscriptInput(input.key)
    if (!parsed.ok) return parsed
    if (input.afterSeq !== undefined && (!Number.isSafeInteger(input.afterSeq) || Number(input.afterSeq) < 0))
      return { ok: false, message: 'afterSeq must be a nonnegative integer.' }
    if (
      input.generation !== undefined &&
      (typeof input.generation !== 'string' || input.generation.length < 1 || input.generation.length > 200)
    )
      return { ok: false, message: 'generation must be a string of 1–200 characters.' }
    if (input.turnLimit !== undefined && (!Number.isSafeInteger(input.turnLimit) || Number(input.turnLimit) < 1))
      return { ok: false, message: 'turnLimit must be a positive integer.' }
    if (!handlers.subscribe) return { ok: false, message: 'Conversation subscriptions are unavailable.' }
    const subscriptionId = input.subscriptionId
    const key = `${event.sender.id}:${subscriptionId}`
    scopedSubscriptions.get(key)?.dispose()
    const subscription = handlers.subscribe(
      {
        key: parsed.input,
        afterSeq: input.afterSeq as number | undefined,
        // Without the cursor's log generation the session cannot vouch for
        // the cursor, and every reconnect would be answered with a reset.
        generation: input.generation as string | undefined,
        turnLimit: input.turnLimit as number | undefined,
      },
      (frame) => {
        if (!event.sender.isDestroyed()) event.sender.send('conversation:session-event', { subscriptionId, frame })
      },
    )
    const dispose = () => {
      subscription.dispose()
      event.sender.removeListener('destroyed', dispose)
      if (scopedSubscriptions.get(key)?.dispose === dispose) scopedSubscriptions.delete(key)
    }
    event.sender.once('destroyed', dispose)
    scopedSubscriptions.set(key, { senderId: event.sender.id, dispose })
    releaseOnNavigation(event.sender)
    return { ok: true, subscriptionId }
  })
  ipcMain.handle('conversation:session:unsubscribe', (event, input: unknown) => {
    if (isRecord(input) && typeof input.subscriptionId === 'string')
      scopedSubscriptions.get(`${event.sender.id}:${input.subscriptionId}`)?.dispose()
    return { ok: true }
  })
  ipcMain.handle('conversation:session:earlier', async (_, input: unknown): Promise<ConversationPageResult> => {
    if (!isRecord(input) || !Number.isSafeInteger(input.beforeCursor) || Number(input.beforeCursor) < 1)
      return { ok: false, message: 'beforeCursor must be a positive integer.' }
    const parsed = parseTranscriptInput(input.key)
    if (!parsed.ok) return parsed
    if (input.turnLimit !== undefined && (!Number.isSafeInteger(input.turnLimit) || Number(input.turnLimit) < 1))
      return { ok: false, message: 'turnLimit must be a positive integer.' }
    return (
      handlers.loadEarlier?.({
        key: parsed.input,
        beforeCursor: Number(input.beforeCursor),
        turnLimit: input.turnLimit as number | undefined,
      }) ?? { ok: false, message: 'Conversation history is unavailable.' }
    )
  })

  ipcMain.handle('conversation:providers:list', async (_, input: unknown): Promise<ConversationProviderListResult> => {
    if (input !== undefined && !isRecord(input)) return { ok: false, message: 'Provider list input must be an object.' }
    try {
      return await handlers.listProviders(input as ConversationProvidersListInput | undefined)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle(
    'conversation:providers:models',
    async (_, input: unknown): Promise<ConversationProviderModelsResult> => {
      const parsed = parseProviderInput(input)
      if (!parsed.ok) return parsed
      try {
        return await handlers.listProviderModels(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:providers:sign-in',
    async (_, input: unknown): Promise<ConversationProviderSignInResult> => {
      const parsed = parseProviderInput(input)
      if (!parsed.ok) return parsed
      const cliRuntimes = isRecord(input) ? input.cliRuntimes : undefined
      if (cliRuntimes !== undefined && !isRecord(cliRuntimes))
        return { ok: false, message: 'cliRuntimes must be an object.' }
      try {
        return (
          (await handlers.resolveSignIn?.({
            providerId: parsed.input.providerId,
            ...(cliRuntimes ? { cliRuntimes: cliRuntimes as ConversationProviderSignInInput['cliRuntimes'] } : {}),
          })) ?? { ok: false, message: 'Sign-in is unavailable.' }
        )
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle('conversation:secrets:status', async (_, input: unknown): Promise<ConversationSecretStatusResult> => {
    const parsed = parseProviderInput(input)
    if (!parsed.ok) return parsed
    try {
      return handlers.getSecretStatus(parsed.input)
    } catch (err) {
      return { ok: false, message: formatError(err) }
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

  ipcMain.handle(
    'conversation:sessions:send-turn',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseSendTurnInput(input)
      if (!parsed.ok) return parsed
      try {
        return handlers.sendTurn(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:interrupt',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseSessionIdInput(input)
      if (!parsed.ok) return parsed
      try {
        return handlers.interrupt(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

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
    },
  )

  ipcMain.handle(
    'conversation:sessions:set-permission',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseSetPermissionInput(input)
      if (!parsed.ok) return parsed
      try {
        return handlers.setPermission(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:set-model',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseSetModelInput(input)
      if (!parsed.ok) return parsed
      if (!handlers.setModel) return { ok: false, message: 'Changing models mid-conversation is unavailable.' }
      try {
        return await handlers.setModel(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
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

  ipcMain.handle(
    'conversation:sessions:suspend',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseSessionIdInput(input)
      if (!parsed.ok) return parsed
      if (!handlers.suspendSession) return { ok: false, message: 'Suspending a conversation is unavailable.' }
      try {
        return await handlers.suspendSession(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:terminal-handoff',
    async (_, input: unknown): Promise<ConversationTerminalHandoffResult> => {
      const parsed = parseSessionIdInput(input)
      if (!parsed.ok) return parsed
      if (!handlers.terminalHandoff) return { ok: false, message: 'Resuming a chat in a terminal is unavailable.' }
      try {
        return await handlers.terminalHandoff(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle('conversation:sessions:list', async (_, input: unknown): Promise<ConversationListSessionsResult> => {
    if (input !== undefined && !isRecord(input)) return { ok: false, message: 'Session list input must be an object.' }
    try {
      return handlers.listSessions(input as ConversationListSessionsInput | undefined)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle('conversation:tool-detail', async (_, input: unknown): Promise<ConversationToolDetailResult> => {
    const parsed = parseTranscriptInput(input)
    if (!parsed.ok || !isRecord(input) || typeof input.toolUseId !== 'string' || !input.toolUseId.trim())
      return { ok: false, code: 'invalid_input', message: 'Conversation and tool identity are required.' }
    return (
      handlers.getToolDetail?.({ ...parsed.input, toolUseId: input.toolUseId }) ?? {
        ok: false,
        code: 'unavailable',
        message: 'Tool details are unavailable.',
      }
    )
  })

  // A sent image, read back for a replayed bubble. The reference is resolved
  // inside the attachment store only; this is not a general file read.
  ipcMain.handle('conversation:attachment', async (_, input: unknown): Promise<ConversationAttachmentResult> => {
    if (!isRecord(input) || typeof input.ref !== 'string') return { ok: false, message: 'ref is required.' }
    return handlers.readAttachment?.(input.ref) ?? { ok: false, message: 'Attachments are unavailable.' }
  })

  // A proposed plan, as a file the workspace pane opens. The agent's own plan
  // file is only ever answered with when it still holds this text; otherwise
  // the text is copied into app data (conversation-plan-store).
  ipcMain.handle('conversation:plan-document', async (_, input: unknown): Promise<ConversationPlanDocumentResult> => {
    const key = parseTranscriptInput(input)
    if (!key.ok) return key
    if (!isRecord(input) || typeof input.plan !== 'string') return { ok: false, message: 'plan is required.' }
    const title = typeof input.title === 'string' ? input.title : undefined
    const planFilePath = typeof input.planFilePath === 'string' ? input.planFilePath : undefined
    try {
      return (
        (await handlers.planDocument?.({ ...key.input, plan: input.plan, title, planFilePath })) ?? {
          ok: false,
          message: 'Plans are unavailable.',
        }
      )
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
      if (!eventSubscriptions.delete(subscriptionId)) return
      sender.removeListener('destroyed', cleanup)
      unsubscribe()
    }
    const unsubscribe = handlers.onEvent((conversationEvent) => {
      if (sender.isDestroyed()) {
        cleanup()
        return
      }
      if (isConversationBroadcastEvent(conversationEvent)) sender.send('conversation:event', conversationEvent)
    })
    eventSubscriptions.set(subscriptionId, { senderId: sender.id, dispose: cleanup })
    sender.once('destroyed', cleanup)
    releaseOnNavigation(sender)
    return { ok: true, subscriptionId }
  })

  ipcMain.handle(
    'conversation:events:unsubscribe',
    (_event, input: unknown): { ok: true } | { ok: false; message: string } => {
      if (!isRecord(input) || typeof input.subscriptionId !== 'string') {
        return { ok: false, message: 'subscriptionId is required.' }
      }
      eventSubscriptions.get(input.subscriptionId)?.dispose()
      return { ok: true }
    },
  )
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function parseProviderInput(
  input: unknown,
): { ok: true; input: ConversationSecretStatusInput } | { ok: false; message: string } {
  if (!isRecord(input) || typeof input.providerId !== 'string') {
    return { ok: false, message: 'providerId is required.' }
  }
  return { ok: true, input: { providerId: input.providerId } }
}

function parseSecretSetInput(
  input: unknown,
): { ok: true; input: ConversationSecretSetInput } | { ok: false; message: string } {
  const parsed = parseProviderInput(input)
  if (!parsed.ok) return parsed
  if (!isRecord(input) || typeof input.value !== 'string') {
    return { ok: false, message: 'Secret value is required.' }
  }
  return { ok: true, input: { providerId: parsed.input.providerId, value: input.value } }
}

function parseStartSessionInput(
  input: unknown,
): { ok: true; input: ConversationStartSessionInput } | { ok: false; message: string } {
  if (!isRecord(input)) return { ok: false, message: 'Start session input must be an object.' }
  const { workspaceRoot, workspaceId, agentId, providerId, modelId, cliRuntimes, permissionPreset, allowedTools } =
    input
  if (typeof workspaceRoot !== 'string') return { ok: false, message: 'workspaceRoot is required.' }
  if (typeof workspaceId !== 'string') return { ok: false, message: 'workspaceId is required.' }
  if (typeof agentId !== 'string') return { ok: false, message: 'agentId is required.' }
  if (typeof providerId !== 'string') return { ok: false, message: 'providerId is required.' }
  if (typeof modelId !== 'string') return { ok: false, message: 'modelId is required.' }
  if (cliRuntimes !== undefined && !isRecord(cliRuntimes)) {
    return { ok: false, message: 'cliRuntimes must be an object when present.' }
  }
  const preset = permissionPreset === undefined ? undefined : parseCliPermissionPreset(permissionPreset)
  if (preset === null) return { ok: false, message: PERMISSION_PRESET_ERROR }
  // A mode of the CLI's own rides only beside a preset; one that is not a mode
  // id is dropped, and the preset's own mode runs.
  const mode = preset ? parseCliPermissionModeId(input.permissionMode) : null
  if (
    allowedTools !== undefined &&
    (!Array.isArray(allowedTools) || allowedTools.some((tool) => typeof tool !== 'string'))
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
      ...(isRecord(cliRuntimes) ? { cliRuntimes: cliRuntimes as ConversationCliRuntimeOverrides } : {}),
      ...(preset ? { permissionPreset: preset } : {}),
      ...(mode ? { permissionMode: mode } : {}),
      ...(Array.isArray(allowedTools) ? { allowedTools: allowedTools as string[] } : {}),
    },
  }
}

function parseTranscriptInput(
  input: unknown,
): { ok: true; input: ConversationTranscriptInput } | { ok: false; message: string } {
  if (!isRecord(input)) return { ok: false, message: 'Transcript input must be an object.' }
  const { workspaceRoot, workspaceId, agentId } = input
  if (typeof workspaceRoot !== 'string') return { ok: false, message: 'workspaceRoot is required.' }
  if (typeof workspaceId !== 'string') return { ok: false, message: 'workspaceId is required.' }
  if (typeof agentId !== 'string') return { ok: false, message: 'agentId is required.' }
  return { ok: true, input: { workspaceRoot, workspaceId, agentId } }
}

// Image attachments accepted on a send-turn. The media-type set, the per-image
// byte ceiling and the per-turn cap are the shared boundary limits the composer
// stages against (src/shared/conversation-attachments.ts) — one declaration, so
// the composer can never stage an image this boundary then refuses (1810).
// Anything outside them is rejected here rather than failing deep in the
// provider.
const ALLOWED_IMAGE_MEDIA_TYPES = new Set<string>(ATTACHABLE_IMAGE_TYPES)
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

// Decoded byte length of a base64 string without allocating the buffer.
function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

function parseImageAttachments(
  raw: unknown,
): { ok: true; attachments: ConversationImageAttachment[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: 'attachments must be an array when present.' }
  if (raw.length > MAX_ATTACHMENTS_PER_TURN) {
    return { ok: false, message: `A turn can carry at most ${MAX_ATTACHMENTS_PER_TURN} attachments.` }
  }
  const attachments: ConversationImageAttachment[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) return { ok: false, message: 'Each attachment must be an object.' }
    const { id, mediaType, dataBase64, name, byteLength } = entry
    if (typeof id !== 'string' || !id.trim()) return { ok: false, message: 'Attachment id is required.' }
    if (typeof mediaType !== 'string' || !ALLOWED_IMAGE_MEDIA_TYPES.has(mediaType)) {
      return { ok: false, message: 'Attachments must be PNG, JPEG, WebP, or GIF images.' }
    }
    if (
      typeof dataBase64 !== 'string' ||
      !dataBase64 ||
      !BASE64_PATTERN.test(dataBase64) ||
      dataBase64.length % 4 !== 0
    ) {
      return { ok: false, message: 'Attachment image data must be base64-encoded.' }
    }
    if (name !== undefined && typeof name !== 'string') {
      return { ok: false, message: 'Attachment name must be a string when present.' }
    }
    // Trust the decoded length over the client-supplied byteLength for the guard.
    const decodedBytes = base64ByteLength(dataBase64)
    if (decodedBytes > MAX_ATTACHMENT_BYTES) {
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

function parseSendTurnInput(
  input: unknown,
): { ok: true; input: ConversationSendTurnInput } | { ok: false; message: string } {
  const session = parseSessionIdInput(input)
  if (!session.ok) return session
  if (!isRecord(input) || typeof input.message !== 'string') return { ok: false, message: 'message is required.' }
  if ('localTurnId' in input && input.localTurnId !== undefined && typeof input.localTurnId !== 'string') {
    return { ok: false, message: 'localTurnId must be a string when present.' }
  }
  if (
    input.reasoningEffort !== undefined &&
    (typeof input.reasoningEffort !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(input.reasoningEffort))
  )
    return { ok: false, message: 'Invalid reasoning effort.' }
  if (input.mode !== undefined && !['default', 'plan', 'ask'].includes(String(input.mode)))
    return { ok: false, message: 'Invalid conversation mode.' }
  if (input.steer !== undefined && typeof input.steer !== 'boolean')
    return { ok: false, message: 'steer must be a boolean when present.' }
  let attachments: ConversationImageAttachment[] | undefined
  const mentions = input.mentions === undefined ? undefined : parseConversationMentions(input.mentions)
  if (mentions === null) return { ok: false, message: 'Mention references are invalid.' }
  if (
    input.skills !== undefined &&
    (!Array.isArray(input.skills) ||
      input.skills.length > 32 ||
      input.skills.some(
        (skill) =>
          !isRecord(skill) ||
          typeof skill.id !== 'string' ||
          (skill.sourcePath !== undefined && typeof skill.sourcePath !== 'string'),
      ))
  )
    return { ok: false, message: 'skills must contain skill identities and optional source paths.' }
  if ('attachments' in input && input.attachments !== undefined) {
    const parsed = parseImageAttachments(input.attachments)
    if (!parsed.ok) return parsed
    if (parsed.attachments.length > 0) attachments = parsed.attachments
  }
  return {
    ok: true,
    input: {
      ...session.input,
      message: input.message,
      ...(typeof input.localTurnId === 'string' ? { localTurnId: input.localTurnId } : {}),
      ...(attachments ? { attachments } : {}),
      ...(mentions ? { mentions } : {}),
      ...(Array.isArray(input.skills) ? { skills: input.skills as ConversationSendTurnInput['skills'] } : {}),
      ...(typeof input.reasoningEffort === 'string' ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.mode ? { mode: input.mode as ConversationSendTurnInput['mode'] } : {}),
      ...(input.steer === true ? { steer: true } : {}),
    },
  }
}

function parseSessionIdInput(
  input: unknown,
): { ok: true; input: ConversationInterruptInput } | { ok: false; message: string } {
  if (!isRecord(input) || typeof input.sessionId !== 'string') return { ok: false, message: 'sessionId is required.' }
  if (
    input.commandId !== undefined &&
    (typeof input.commandId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.commandId))
  )
    return { ok: false, message: 'commandId must be a UUID.' }
  return {
    ok: true,
    input: {
      sessionId: input.sessionId,
      ...(typeof input.commandId === 'string' ? { commandId: input.commandId } : {}),
    },
  }
}

// A window built before the preset rename can still send `default`,
// `auto_workspace` or `bypass_all`; parseCliPermissionPreset reads each as the
// preset it meant rather than refusing it.
const PERMISSION_PRESET_ERROR = `permissionPreset must be ${CONVERSATION_PERMISSION_PRESETS.join(' or ')}.`

function parseSetPermissionInput(
  input: unknown,
): { ok: true; input: ConversationSetPermissionInput } | { ok: false; message: string } {
  const session = parseSessionIdInput(input)
  if (!session.ok) return session
  const permissionPreset = parseCliPermissionPreset(isRecord(input) ? input.permissionPreset : undefined)
  if (!permissionPreset) return { ok: false, message: PERMISSION_PRESET_ERROR }
  const permissionMode = parseCliPermissionModeId(isRecord(input) ? input.permissionMode : undefined)
  return { ok: true, input: { ...session.input, permissionPreset, ...(permissionMode ? { permissionMode } : {}) } }
}

function parseSetModelInput(
  input: unknown,
): { ok: true; input: ConversationSetModelInput } | { ok: false; message: string } {
  const session = parseSessionIdInput(input)
  if (!session.ok) return session
  const modelId = isRecord(input) && typeof input.modelId === 'string' ? input.modelId.trim() : ''
  if (!modelId || modelId.length > 200) return { ok: false, message: 'modelId is required.' }
  return { ok: true, input: { ...session.input, modelId } }
}

function parseRespondToRequestInput(
  input: unknown,
): { ok: true; input: ConversationRespondToRequestInput } | { ok: false; message: string } {
  const session = parseSessionIdInput(input)
  if (!session.ok) return session
  if (!isRecord(input) || typeof input.requestId !== 'string') return { ok: false, message: 'requestId is required.' }
  if (typeof input.approved !== 'boolean') return { ok: false, message: 'approved is required.' }
  if (input.decision !== undefined && !['once', 'conversation', 'always', 'deny'].includes(String(input.decision)))
    return { ok: false, message: 'Permission decision is invalid.' }
  let answers: Record<string, string> | undefined
  if ('answers' in input && input.answers !== undefined) {
    if (!isRecord(input.answers) || Object.values(input.answers).some((value) => typeof value !== 'string')) {
      return { ok: false, message: 'answers must map question text to answer strings.' }
    }
    answers = input.answers as Record<string, string>
  }
  return {
    ok: true,
    input: {
      ...session.input,
      requestId: input.requestId,
      approved: input.approved,
      ...(input.decision ? { decision: input.decision as ConversationRespondToRequestInput['decision'] } : {}),
      ...(answers ? { answers } : {}),
    },
  }
}
