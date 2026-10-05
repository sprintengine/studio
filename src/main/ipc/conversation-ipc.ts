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
import {
  parseProviderInput,
  parseRespondToRequestInput,
  parseSecretSetInput,
  parseSendTurnInput,
  parseSessionIdInput,
  parseSetModelInput,
  parseSetPermissionInput,
  parseStartSessionInput,
  parseTranscriptInput,
} from '../conversation-ipc-inputs'
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
      // A session, or the chat by its identity (a tab's menu holds no session).
      const chat =
        isRecord(input) &&
        input.sessionId === undefined &&
        typeof input.workspaceId === 'string' &&
        input.workspaceId.trim() &&
        typeof input.agentId === 'string' &&
        input.agentId.trim()
          ? { workspaceId: input.workspaceId, agentId: input.agentId }
          : null
      const parsed = chat ? { ok: true as const, input: chat } : parseSessionIdInput(input)
      if (!parsed.ok) return parsed
      if (!handlers.terminalHandoff) return { ok: false, message: 'Resuming a chat in a terminal is unavailable.' }
      try {
        return await handlers.terminalHandoff(
          'sessionId' in parsed.input ? { sessionId: parsed.input.sessionId } : parsed.input,
        )
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
