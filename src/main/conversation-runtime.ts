import { stat, readFile, rm, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'

import type {
  ConversationCliRuntimeOverrides,
  ConversationEvent,
  ConversationInterruptInput,
  ConversationPermissionPreset,
  ConversationListSessionsInput,
  ConversationListSessionsResult,
  ConversationRespondToRequestInput,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationSessionSummary,
  ConversationSetPermissionInput,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationStopSessionInput,
  ConversationTranscriptInput,
  ConversationTranscriptResult,
  ConversationToolDetailInput,
  ConversationToolDetailResult,
  ConversationToolDetail,
  ConversationJsonValue,
  ConversationTurnDiffInput,
  ConversationTurnDiffResult,
  ConversationRevertInput,
  ConversationRevertResult,
} from '../shared/conversation-runtime'
import { inferConversationToolKind } from '../shared/conversation/toolKind'
import { readToolDetail, writeToolDetail, redactConversationValue } from './conversation-tool-details'
import { createConversationSkillsResolver, type ConversationSkillsResolver } from './conversation-skills'
import { resolveConversationMentions } from './conversation-mentions'
import { ConversationCheckpoints } from './conversation-checkpoints'
import { ConversationIndex } from './conversation-index'
import type {
  ConversationWorkspaceKey,
  ConversationSearchInput,
  ConversationSearchHit,
  ConversationRenameInput,
} from '../shared/conversation-index'
import { presentToolItem } from '../shared/conversation/presentation'
import { ConversationApprovalRuleStore } from './conversation-approval-rules'
import type { ApprovalRuleRequest } from '../shared/conversation/approvalRules'
import { getConversationProviderById } from './plugin-registry-instance'
import { ProviderSecretStore } from './secret-store'
import { clampSuspendIdleAfterMs, DEFAULT_SUSPEND_IDLE_AFTER_MS } from './terminal-reap-policy'
import type { TerminalRootInfo } from './workspace-memory'
import {
  type ConversationMessage,
  type ConversationProviderAdapter,
  type ConversationProviderEventStream,
} from './providers/conversation-provider-adapter'
import { createMockConversationProvider } from './providers/mock-conversation-provider'
import { createOpenAiCompatibleProvider } from './providers/openai-compatible-provider'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './providers/claude-agent-provider'
import { createCodexConversationProvider } from './providers/codex-conversation-provider'
import { ACP_PROFILES, createAcpConversationProvider } from './providers/acp-conversation-provider'
import { workspaceSidecarPath } from './workspace-sidecar'
import { ConversationEventLog, expandCoalescedDeltas, type ConversationEventLogOptions } from './conversation-event-log'

type RuntimeSession = ConversationSessionSummary & {
  workspaceRoot: string
  activeTurnId: string | null
  pendingRequestId: string | null
  activeTurnAbort: AbortController | null
  canceledTurnIds: Set<string>
  // Completed turns only, in send order, so each new turn carries prior context.
  // A failed/interrupted turn is not recorded, so a retry re-sends cleanly.
  history: ConversationMessage[]
  // True when the provider adapter owns history/resume (sessions: 'stateful').
  // Stateful sessions never replay history and resolve approvals mid-turn.
  stateful: boolean
  // The requestId allocated at turn start. For stateful sessions it doubles as
  // the send lock while a turn is streaming; mid-turn approvals temporarily
  // override pendingRequestId with their own ids.
  turnLockRequestId: string | null
  // All approval request ids currently unresolved on a stateful turn (the
  // provider can hold several permission callbacks open at once).
  pendingApprovalRequestIds: Set<string>
  // Serializes continuation-channel events (post-`result` turns the provider
  // opens outside a sendTurn) so their persistence and broadcast stay ordered.
  continuationTail: Promise<void>
  checkpointTurnSeq: number | null
  checkpointCapture: Promise<void> | null
  checkpointCaptured: boolean
  checkpointNotice?: string
  checkpointNoticeSent?: boolean
  revertedNote?: string
  approvalRequests: Map<string, ApprovalRuleRequest>
  automaticApprovals: Map<string, string>
  cliRuntimes?: ConversationCliRuntimeOverrides
  permissionPreset?: ConversationPermissionPreset
  allowedTools?: string[]
}

type ConversationRuntimeOptions = {
  approvalRules?: ConversationApprovalRuleStore
  resolveSkills?: ConversationSkillsResolver
  adapters?: ConversationProviderAdapter[]
  secretStore?: Pick<ProviderSecretStore, 'getStatus'> & Partial<Pick<ProviderSecretStore, 'resolveSecret'>>
  getProviderById?: typeof getConversationProviderById
  stat?: typeof stat
  readFile?: typeof readFile
  // How transcript lines reach disk; tests shorten the delta flush or stub the
  // stream. Defaults to one append stream per transcript file.
  eventLog?: ConversationEventLogOptions
  now?: () => number
  randomId?: () => string
  prepareStudioMcp?: (input: {
    workspaceRoot: string
    workspaceId: string
    agentId: string
  }) => Promise<{ ok: true } | { ok: false; message: string }>
}

type ConversationRuntimeListener = (event: ConversationEvent) => void

// Cap on how many persisted events a transcript replay returns to the
// renderer; the JSONL on disk keeps everything.
const MAX_TRANSCRIPT_REPLAY_EVENTS = 2000

// Same cadence as the terminal runtime's stale-terminal sweep: often enough
// that an idle child process does not outlive the threshold by much, rare
// enough to be free.
const IDLE_SWEEP_INTERVAL_MS = 3 * 60 * 1000

export class ConversationRuntime {
  private readonly adapters = new Map<string, ConversationProviderAdapter>()
  private readonly secretStore: Pick<ProviderSecretStore, 'getStatus'> &
    Partial<Pick<ProviderSecretStore, 'resolveSecret'>>
  private readonly getProviderById: typeof getConversationProviderById
  private readonly stat: typeof stat
  private readonly eventLog: ConversationEventLog
  private readonly threadIndex: ConversationIndex
  private readonly readFile: typeof readFile
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly prepareStudioMcp?: ConversationRuntimeOptions['prepareStudioMcp']
  private readonly resolveSkills: ConversationSkillsResolver
  private readonly checkpoints = new ConversationCheckpoints()
  private readonly approvalRules: ConversationApprovalRuleStore
  private readonly sessions = new Map<string, RuntimeSession>()
  private readonly deletingTranscripts = new Set<string>()
  private readonly startingTranscripts = new Set<string>()
  private readonly sequenceInitializations = new Map<string, Promise<void>>()
  private readonly listeners = new Set<ConversationRuntimeListener>()
  private readonly sequences = new Map<string, number>()
  private readonly emissionTails = new Map<string, Promise<unknown>>()
  private readonly receipts = new Map<string, Promise<Map<string, ConversationSessionActionResult>>>()
  private readonly pendingCommands = new Map<string, Promise<ConversationSessionActionResult>>()
  private readonly receiptWrites = new Map<string, Promise<void>>()
  private eventSequence = 0
  // Event ids must stay unique across app restarts: the persisted transcript
  // is replayed into the renderer, which dedupes live pushes against it by id.
  private readonly eventEpoch: string
  private idleThresholdMs = DEFAULT_SUSPEND_IDLE_AFTER_MS
  private idleSweepTimer: NodeJS.Timeout | null = null

  constructor(options: ConversationRuntimeOptions = {}) {
    this.secretStore = options.secretStore ?? new ProviderSecretStore()
    this.getProviderById = options.getProviderById ?? getConversationProviderById
    const defaultAdapters = [
      createMockConversationProvider(),
      createOpenAiCompatibleProvider({
        getProviderById: this.getProviderById,
        resolveSecret: (providerId) => this.resolveSecret(providerId),
      }),
      createClaudeAgentProvider(),
      createCodexConversationProvider(),
      ...ACP_PROFILES.map((profile) => createAcpConversationProvider(profile)),
    ]
    for (const adapter of options.adapters ?? defaultAdapters) {
      this.adapters.set(adapter.id, adapter)
    }
    this.stat = options.stat ?? stat
    this.eventLog = new ConversationEventLog({
      onError: (filePath, error) => {
        console.warn(
          `[conversation-runtime] transcript write failed for ${filePath}:`,
          error instanceof Error ? error.message : error,
        )
      },
      ...options.eventLog,
    })
    this.readFile = options.readFile ?? readFile
    this.threadIndex = new ConversationIndex({
      flush: (path) => this.eventLog.flush(path),
      close: (path) => this.eventLog.close(path),
    })
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? (() => Math.random().toString(36).slice(2, 10))
    this.prepareStudioMcp = options.prepareStudioMcp
    this.resolveSkills = options.resolveSkills ?? createConversationSkillsResolver()
    this.approvalRules = options.approvalRules ?? new ConversationApprovalRuleStore()
    // Startup-time epoch (not randomId — tests inject deterministic id
    // sequences that must not be consumed by construction).
    this.eventEpoch = this.now().toString(36)
  }

  onEvent(listener: ConversationRuntimeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getProviderCapabilities(providerId: string) {
    return this.getAdapterForProviderId(providerId)?.capabilities
  }
  getNativeProviderModels(providerId: string) {
    const adapter = this.getAdapterForProviderId(providerId)
    return adapter?.sessions === 'stateful'
      ? adapter.listModels().map((id) => ({ id, displayName: id === 'default' ? 'CLI default' : id }))
      : undefined
  }

  async startSession(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult> {
    if (!input.workspaceRoot?.trim() || !input.workspaceId?.trim() || !input.agentId?.trim())
      return { ok: false, message: 'Conversation identity is required.' }
    const path = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
    if (this.deletingTranscripts.has(path) || this.startingTranscripts.has(path))
      return { ok: false, message: 'Conversation lifecycle operation is already in progress.' }
    this.startingTranscripts.add(path)
    try {
      return await this.startSessionNow(input)
    } finally {
      this.startingTranscripts.delete(path)
    }
  }

  private async startSessionNow(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult> {
    const validation = await this.validateStartInput(input)
    if (!validation.ok) {
      return { ok: false, message: validation.message }
    }
    if (input.providerId === CLAUDE_AGENT_PROVIDER_ID && this.prepareStudioMcp) {
      const prepared = await this.prepareStudioMcp(input)
      if (!prepared.ok) return prepared
    }

    const sessionId = `conv_${this.randomId()}`
    const now = this.now()
    const stateful = validation.adapter.sessions === 'stateful'
    const session: RuntimeSession = {
      sessionId,
      workspaceId: input.workspaceId.trim(),
      agentId: input.agentId.trim(),
      providerId: input.providerId.trim(),
      modelId: input.modelId.trim(),
      status: 'starting',
      phase: 'starting',
      displayName: validation.adapter.displayName ?? input.providerId,
      capabilities: validation.adapter.capabilities
        ? {
            ...validation.adapter.capabilities,
            checkpoints:
              validation.adapter.capabilities.tools && (await this.checkpoints.available(input.workspaceRoot)),
          }
        : undefined,
      createdAt: now,
      updatedAt: now,
      workspaceRoot: input.workspaceRoot,
      activeTurnId: null,
      pendingRequestId: null,
      activeTurnAbort: null,
      canceledTurnIds: new Set(),
      history: [],
      stateful,
      turnLockRequestId: null,
      pendingApprovalRequestIds: new Set(),
      continuationTail: Promise.resolve(),
      checkpointTurnSeq: null,
      checkpointCapture: null,
      checkpointCaptured: false,
      approvalRequests: new Map(),
      automaticApprovals: new Map(),
      cliRuntimes: input.cliRuntimes,
      permissionPreset: input.permissionPreset,
      allowedTools: input.allowedTools,
    }
    await this.initializeSequence(input)
    const previousTranscript = await this.readTranscript(input, { all: true, closeOpenTurns: false })
    if (previousTranscript.ok) {
      for (const event of previousTranscript.events) this.updateExcerpts(session, event)
      session.history = completedHistory(previousTranscript.events)
    }
    this.sessions.set(sessionId, session)

    // Stateful providers resume their own durable session; the latest cursor
    // lives in the JSONL transcript this runtime already writes.
    const resumeSessionId = stateful
      ? await this.readResumeCursor(session.workspaceRoot, session.workspaceId, session.agentId)
      : undefined
    try {
      await this.emitAll(
        session,
        validation.adapter.startSession({
          ...session,
          resumeSessionId,
          fallbackHistory: session.history,
          // Continuation channel: the adapter opens a mirror turn here when its
          // child resumes after a `result` (background subagents completing).
          onSessionEvent: (event) => this.enqueueContinuationEvent(session, event),
          onBeforeTool: (name) => this.captureBeforeTool(session, name),
        }),
      )
      session.status = 'ready'
      session.phase = 'idle'
      session.updatedAt = this.now()
      return { ok: true, session: this.toSummary(session) }
    } catch (error) {
      this.sessions.delete(sessionId)
      validation.adapter.disposeChildProcess?.(sessionId)
      return { ok: false, message: error instanceof Error ? error.message : 'Conversation could not start.' }
    }
  }

  async sendTurn(input: ConversationSendTurnInput): Promise<ConversationSessionActionResult> {
    if (input.commandId)
      return this.runCommand(input.sessionId, input.commandId, () => this.sendTurn({ ...input, commandId: undefined }))
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, message: 'Conversation session is invalid.' }
    if (this.deletingTranscripts.has(this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)))
      return { ok: false, message: 'Conversation is being deleted.' }
    if (session.status === 'stopped') return { ok: false, message: 'Conversation session is stopped.' }
    if (isSessionBusy(session)) {
      return {
        ok: false,
        message: session.pendingRequestId
          ? 'Conversation turn is awaiting approval.'
          : 'Conversation turn is already in progress.',
      }
    }
    const message = input.message.trim()
    const attachments = input.attachments ?? []
    // A turn needs some payload: either text or at least one image attachment.
    if (!message && attachments.length === 0 && !input.mentions?.length)
      return { ok: false, message: 'Conversation turn message is required.' }

    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }

    if (input.mode === 'plan' && !session.capabilities?.planMode)
      return { ok: false, message: 'This provider does not support plan mode.' }

    let skills: Awaited<ReturnType<ConversationSkillsResolver>>
    let mentions: Awaited<ReturnType<typeof resolveConversationMentions>>
    try {
      skills = await this.resolveSkills({
        workspaceRoot: session.workspaceRoot,
        skills: input.skills ?? [],
        mode: adapter.capabilities?.skills ?? 'none',
      })
      mentions = await resolveConversationMentions({
        workspaceRoot: session.workspaceRoot,
        mentions: input.mentions ?? [],
        providerId: session.providerId,
        tools: session.capabilities?.tools === true,
      })
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Attached skills could not be loaded.' }
    }
    // Resolving a skill may await disk or installation; another send can take
    // the session while that happens, so acquire the turn only after rechecking.
    if (
      this.sessions.get(input.sessionId)?.status === 'stopped' ||
      this.sessions.get(input.sessionId) !== session ||
      this.deletingTranscripts.has(this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId))
    )
      return { ok: false, message: 'Conversation is no longer available.' }
    if (isSessionBusy(session)) return { ok: false, message: 'Conversation turn is already in progress.' }

    const turnId = `turn_${this.randomId()}`
    const requestId = `approval_${this.randomId()}`
    const turnAbort = new AbortController()
    session.activeTurnId = turnId
    session.pendingRequestId = requestId
    session.turnLockRequestId = requestId
    session.activeTurnAbort = turnAbort
    session.status = 'active'
    session.phase = 'running'
    session.updatedAt = this.now()
    session.checkpointTurnSeq = null
    session.checkpointCapture = null
    session.checkpointCaptured = false
    // Persist the user's side of the exchange so the JSONL transcript replays
    // as a complete conversation after a restart.
    try {
      await this.emit(
        session,
        this.eventForSession(session, 'user_message', {
          turnId,
          text: message,
          ...(input.localTurnId ? { localTurnId: input.localTurnId } : {}),
          ...(skills.ids.length ? { skills: skills.ids } : {}),
          ...(mentions.refs.length ? { mentions: mentions.refs } : {}),
        }),
        { turnId },
      )
      // The model sees prior completed turns plus this message, so it has memory.
      // Stateful providers own their history natively — replaying ours would
      // duplicate context and defeat resume, so they get only the new message.
      const messages: ConversationMessage[] | undefined = session.stateful
        ? undefined
        : [
            ...(skills.context ? [{ role: 'system' as const, content: skills.context }] : []),
            ...(session.revertedNote ? [{ role: 'system' as const, content: session.revertedNote }] : []),
            ...session.history,
            { role: 'user', content: [message, mentions.context].filter(Boolean).join('\n\n') },
          ]
      // Attachments are carried live into the turn call; only vision-capable
      // adapters read them. They are not persisted into history (v1 is
      // live-only), so history and JSONL replay stay text-only.
      const events = await this.emitAll(
        session,
        adapter.sendTurn({
          ...session,
          turnId,
          requestId,
          message: [session.stateful ? skills.context : undefined, session.revertedNote, message, mentions.context]
            .filter(Boolean)
            .join('\n\n'),
          skills: skills.ids,
          reasoningEffort: input.reasoningEffort,
          mode: input.mode,
          ...(attachments.length > 0 ? { attachments } : {}),
          messages,
          signal: turnAbort.signal,
        }),
        { turnId },
      )
      const currentSession = this.sessions.get(input.sessionId)
      if (
        currentSession &&
        currentSession.status !== 'stopped' &&
        currentSession.activeTurnId === turnId &&
        !currentSession.canceledTurnIds.has(turnId)
      ) {
        this.applyTurnState(currentSession, events, requestId)
        currentSession.activeTurnAbort = null
        // Record only a cleanly completed turn (no failure) into history, so a
        // failed turn leaves history untouched and a retry re-sends without
        // duplicating the user message. Stateful providers keep their own.
        const completed =
          !currentSession.stateful &&
          events.some((event) => event.type === 'turn_completed') &&
          !events.some((event) => event.type === 'turn_failed')
        if (completed) {
          currentSession.history.push({ role: 'user', content: message })
          const assistantText = events
            .filter((event) => event.type === 'content_delta')
            .map((event) => (typeof event.payload?.text === 'string' ? event.payload.text : ''))
            .join('')
          if (assistantText) currentSession.history.push({ role: 'assistant', content: assistantText })
        }
      }
      return { ok: true, session: this.toSummary(currentSession ?? session) }
    } catch (error) {
      return this.failTurn(session, error)
    }
  }

  private async failTurn(session: RuntimeSession, error: unknown): Promise<ConversationSessionActionResult> {
    const turnId = session.activeTurnId
    session.activeTurnAbort?.abort()
    session.activeTurnId = null
    session.pendingRequestId = null
    session.turnLockRequestId = null
    session.pendingApprovalRequestIds.clear()
    session.activeTurnAbort = null
    session.status = 'failed'
    session.phase = 'failed'
    session.updatedAt = this.now()
    const message = error instanceof Error ? error.message : 'Conversation turn failed.'
    const event = this.eventForSession(session, 'turn_failed', { turnId, reason: 'runtime', message })
    try {
      await this.emit(session, event, { allowCanceledTurnId: turnId })
    } catch {
      this.notify(event)
    }
    return { ok: false, message, event }
  }

  private notify(event: ConversationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        this.listeners.delete(listener)
      }
    }
  }

  async respondToRequest(input: ConversationRespondToRequestInput): Promise<ConversationSessionActionResult> {
    if (input.commandId)
      return this.runCommand(input.sessionId, input.commandId, () =>
        this.respondToRequest({ ...input, commandId: undefined }),
      )
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, message: 'Conversation session is invalid.' }
    const requestIsPending =
      session.pendingRequestId === input.requestId || session.pendingApprovalRequestIds.has(input.requestId)
    if (!session.activeTurnId || !requestIsPending) {
      return { ok: false, message: 'Conversation approval request is invalid.' }
    }
    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }

    if (input.approved && (input.decision === 'conversation' || input.decision === 'always')) {
      const request = session.approvalRequests.get(input.requestId)
      if (!request || (request.requestKind && request.requestKind !== 'tool'))
        return { ok: false, message: 'This request can only be allowed once.' }
      try {
        await this.approvalRules.remember(session.workspaceRoot, session.sessionId, request, input.decision)
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Permission rule could not be saved.' }
      }
    }

    await this.emitAll(
      session,
      adapter.resolveApproval({
        ...session,
        turnId: session.activeTurnId,
        requestId: input.requestId,
        approved: input.decision === 'deny' ? false : input.approved,
        answers: input.answers,
      }),
    )
    if (session.stateful) {
      // The turn is still streaming inside the adapter (the approval resolved
      // a mid-turn permission callback); restore the turn lock and let the
      // in-flight sendTurn stream carry the resolution + remaining events.
      session.pendingRequestId = session.turnLockRequestId
      session.status = 'active'
      session.updatedAt = this.now()
      return { ok: true, session: this.toSummary(session) }
    }
    session.activeTurnId = null
    session.pendingRequestId = null
    session.status = input.approved ? 'ready' : 'failed'
    session.updatedAt = this.now()
    return { ok: true, session: this.toSummary(session) }
  }

  // Change tool-permission behavior on a session that is already running. The
  // adapter applies it to its live provider session (taking effect on the next
  // tool call) and only then does the session record the new preset, so a
  // provider that refuses the change never leaves a preset it is not honoring.
  // An adapter that accepted the preset but cannot apply it to the turn already
  // running returns a `notice` — the change is recorded, and the sentence says
  // plainly when it starts applying.
  async setPermission(input: ConversationSetPermissionInput): Promise<ConversationSessionActionResult> {
    if (input.commandId)
      return this.runCommand(input.sessionId, input.commandId, () =>
        this.setPermission({ ...input, commandId: undefined }),
      )
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, message: 'Conversation session is invalid.' }
    if (session.status === 'stopped') return { ok: false, message: 'Conversation session is stopped.' }
    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }
    if (!adapter.setPermissionPreset) {
      return { ok: false, message: 'This conversation provider cannot change tool permissions mid-conversation.' }
    }
    const applied = await adapter.setPermissionPreset({ ...session, permissionPreset: input.permissionPreset })
    if (!applied.ok) return { ok: false, message: applied.message }
    session.permissionPreset = input.permissionPreset
    session.updatedAt = this.now()
    return { ok: true, session: this.toSummary(session), ...(applied.notice ? { notice: applied.notice } : {}) }
  }

  async interrupt(input: ConversationInterruptInput): Promise<ConversationSessionActionResult> {
    if (input.commandId)
      return this.runCommand(input.sessionId, input.commandId, () => this.interrupt({ ...input, commandId: undefined }))
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, message: 'Conversation session is invalid.' }
    if (!session.activeTurnId) return { ok: false, message: 'Conversation session has no active turn.' }
    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }

    const turnId = session.activeTurnId
    if (turnId) this.cancelActiveTurn(session)
    await this.emitAll(session, adapter.interrupt(session), { allowCanceledTurnId: turnId })
    session.activeTurnId = null
    session.pendingRequestId = null
    session.turnLockRequestId = null
    session.pendingApprovalRequestIds.clear()
    session.activeTurnAbort = null
    session.status = 'ready'
    session.updatedAt = this.now()
    return { ok: true, session: this.toSummary(session) }
  }

  async stopSession(input: ConversationStopSessionInput): Promise<ConversationSessionActionResult> {
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, message: 'Conversation session is invalid.' }
    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }

    const turnId = session.activeTurnId
    if (turnId) {
      this.cancelActiveTurn(session)
      await this.emit(
        session,
        this.eventForSession(session, 'turn_failed', {
          turnId,
          reason: 'interrupted',
          message: 'Conversation stopped.',
        }),
        { allowCanceledTurnId: turnId },
      )
    }
    await this.emitAll(session, adapter.stopSession(session), { allowCanceledTurnId: turnId })
    await this.eventLog.close(this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId))
    session.activeTurnId = null
    session.pendingRequestId = null
    session.turnLockRequestId = null
    session.pendingApprovalRequestIds.clear()
    session.activeTurnAbort = null
    session.status = 'stopped'
    this.approvalRules.dropSession(session.sessionId)
    session.approvalRequests.clear()
    session.automaticApprovals.clear()
    session.updatedAt = this.now()
    return { ok: true, session: this.toSummary(session) }
  }

  listSessions(input: ConversationListSessionsInput = {}): ConversationListSessionsResult {
    const sessions = Array.from(this.sessions.values())
      .filter((session) => !input.workspaceId || session.workspaceId === input.workspaceId)
      .filter((session) => !input.agentId || session.agentId === input.agentId)
      .map((session) => this.toSummary(session))
    return { ok: true, sessions }
  }

  // ── Lifecycle parity (idle disposal, quit disposal, process inventory) ────

  setIdleThresholdMs(value: unknown): void {
    this.idleThresholdMs = clampSuspendIdleAfterMs(value)
  }

  startIdleSweep(): void {
    if (this.idleSweepTimer) return
    this.idleSweepTimer = setInterval(() => {
      this.sweepIdleSessions()
    }, IDLE_SWEEP_INTERVAL_MS)
    this.idleSweepTimer.unref?.()
  }

  stopIdleSweep(): void {
    if (!this.idleSweepTimer) return
    clearInterval(this.idleSweepTimer)
    this.idleSweepTimer = null
  }

  // Dispose the child process of every idle stateful session, keeping the
  // session (and its resume cursor) so the next turn transparently respawns.
  // Never disposes mid-turn or while an approval/question card is pending.
  sweepIdleSessions(now: number = this.now()): string[] {
    const disposed: string[] = []
    for (const session of this.sessions.values()) {
      if (isSessionBusy(session)) continue
      if (now - session.updatedAt < this.idleThresholdMs) continue
      // An idle chat does not hold a file handle open for the rest of the run;
      // its next event reopens the stream.
      void this.eventLog.close(this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId))
      if (!session.stateful) continue
      if (session.status !== 'ready' && session.status !== 'failed') continue
      const adapter = this.getAdapterForProviderId(session.providerId)
      if (adapter?.disposeChildProcess?.(session.sessionId)) disposed.push(session.sessionId)
    }
    return disposed
  }

  // Live child processes across all adapters, shaped like terminal roots so
  // workspace-memory attribution and the process tree can consume them as-is.
  listLiveConversationRoots(): TerminalRootInfo[] {
    const roots: TerminalRootInfo[] = []
    for (const adapter of this.adapters.values()) {
      for (const live of adapter.listLiveSessions?.() ?? []) {
        if (!live.childPid) continue
        roots.push({
          sessionId: live.sessionId,
          rootPid: live.childPid,
          workspaceId: live.workspaceId || null,
          agentId: live.agentId || null,
          terminalId: null,
          kind: 'agent',
          cli: 'claude-code',
          activityKind: live.turnActive ? 'working' : 'idle',
          processAlive: true,
          startedAt: live.spawnedAt ?? live.lastActivityAt,
        })
      }
    }
    return roots
  }

  // App-quit disposal: stop every live session so no headless child outlives
  // the app. Sessions keep their resume cursors in the JSONL transcripts.
  /**
   * Put every chat's buffered transcript on disk without stopping anything.
   * The first thing quit does for chats: the streamed text is what a person
   * would miss, and stopping each session (the rest of `shutdown`) can take
   * longer than a quit that is being cut short allows.
   */
  async flushTranscripts(): Promise<void> {
    await this.eventLog.flush()
  }

  async shutdown(): Promise<void> {
    this.stopIdleSweep()
    for (const session of Array.from(this.sessions.values())) {
      if (session.status === 'stopped') continue
      try {
        await this.stopSession({ sessionId: session.sessionId })
      } catch {
        // Best-effort: adapter disposeAll below is the backstop.
      }
    }
    for (const adapter of this.adapters.values()) {
      adapter.disposeAll?.()
    }
    await this.eventLog.closeAll()
  }

  private async validateStartInput(
    input: ConversationStartSessionInput,
  ): Promise<{ ok: true; adapter: ConversationProviderAdapter } | { ok: false; message: string }> {
    if (!input.workspaceRoot?.trim()) return { ok: false, message: 'Workspace root is required.' }
    try {
      const stats = await this.stat(input.workspaceRoot)
      if (!stats.isDirectory()) return { ok: false, message: 'Workspace path is unavailable.' }
    } catch {
      return { ok: false, message: 'Workspace path is unavailable.' }
    }

    const providerId = input.providerId.trim()
    const registryProvider = this.getProviderById(providerId)
    const adapter = this.getAdapterForProviderId(providerId)
    if (!adapter && !registryProvider) return { ok: false, message: 'Conversation provider is not installed.' }

    if (registryProvider?.adapter.execution === 'blocked') {
      return {
        ok: false,
        message: registryProvider.adapter.trustError ?? 'Conversation provider adapter is not trusted for execution.',
      }
    }

    // Providers with a live catalog (e.g. OpenRouter) accept any model id from
    // their `/models` endpoint, which is not in the static seed list — so only
    // enforce seed membership for static-only providers. Agent-harness
    // providers ride a local CLI whose model vocabulary (aliases like
    // 'opus[1m]', full model ids, custom ids) is far wider than the manifest
    // seed, so the CLI is the validator there too. A truly invalid model is
    // surfaced by the provider as a `turn_failed` model error at call time.
    const supportsDynamicModels =
      Boolean(registryProvider?.manifest.openaiCompatible?.modelsPath) ||
      registryProvider?.manifest.providerType === 'agent-harness'
    if (!input.modelId.trim()) return { ok: false, message: 'Conversation model is invalid.' }
    if (!supportsDynamicModels) {
      const models = registryProvider?.manifest.models.map((model) => model.id) ?? adapter?.listModels() ?? []
      if (!models.includes(input.modelId.trim())) return { ok: false, message: 'Conversation model is invalid.' }
    }

    if (registryProvider?.manifest.auth) {
      const secretStatus = await this.secretStore.getStatus(providerId)
      if (!secretStatus.ok) return { ok: false, message: secretStatus.message }
      if (!secretStatus.status.configured)
        return { ok: false, message: 'Conversation provider secret is not configured.' }
    }

    if (!adapter) return { ok: false, message: 'Conversation provider adapter is unavailable.' }

    return { ok: true, adapter }
  }

  private getAdapterForProviderId(providerId: string): ConversationProviderAdapter | undefined {
    const direct = this.adapters.get(providerId)
    if (direct) return direct
    const provider = this.getProviderById(providerId)
    if (provider?.manifest.openaiCompatible) return this.adapters.get('openai-compatible-api')
    return undefined
  }

  private async resolveSecret(
    providerId: string,
  ): Promise<{ ok: true; value: string } | { ok: false; message: string }> {
    if (!this.secretStore.resolveSecret) {
      return { ok: false, message: 'Conversation provider secret resolver is unavailable.' }
    }
    return this.secretStore.resolveSecret(providerId)
  }

  private cancelActiveTurn(session: RuntimeSession): void {
    const turnId = session.activeTurnId
    if (!turnId) return
    session.canceledTurnIds.add(turnId)
    session.activeTurnAbort?.abort()
  }

  private async emitAll(
    session: RuntimeSession,
    events: ConversationProviderEventStream,
    options: { turnId?: string; allowCanceledTurnId?: string | null } = {},
  ): Promise<ConversationEvent[]> {
    const emitted: ConversationEvent[] = []
    const resolved = await events
    if (isAsyncIterable(resolved)) {
      for await (const event of resolved) {
        const stamped = await this.emit(session, event, options)
        if (stamped) emitted.push(stamped)
      }
      return emitted
    }
    for (const event of resolved) {
      const stamped = await this.emit(session, event, options)
      if (stamped) emitted.push(stamped)
    }
    return emitted
  }

  private async emit(
    session: RuntimeSession,
    event: ConversationEvent,
    options: { turnId?: string; allowCanceledTurnId?: string | null } = {},
  ): Promise<ConversationEvent | null> {
    const path = this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)
    const result = (this.emissionTails.get(path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.emitNow(session, event, options))
    this.emissionTails.set(path, result)
    return result
  }

  private async emitNow(
    session: RuntimeSession,
    event: ConversationEvent,
    options: { turnId?: string; allowCanceledTurnId?: string | null },
  ): Promise<ConversationEvent | null> {
    if (this.shouldSuppressEvent(session, event, options)) return null
    const path = this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)
    const stamped: ConversationEvent = {
      ...(await this.prepareToolEvent(session, event)),
      id: `conv_evt_${this.eventEpoch}_${++this.eventSequence}`,
      seq: (this.sequences.get(path) ?? 0) + 1,
      createdAt: this.now(),
    }
    this.sequences.set(path, stamped.seq!)
    if (stamped.type === 'user_message' || (stamped.type === 'turn_started' && session.checkpointTurnSeq === null))
      session.checkpointTurnSeq = stamped.seq!
    if (stamped.type === 'tool_started')
      await this.captureBeforeTool(session, String(stamped.payload?.name ?? stamped.payload?.tool ?? ''))
    if (
      (stamped.type === 'turn_completed' || stamped.type === 'turn_failed') &&
      session.checkpointCaptured &&
      session.checkpointTurnSeq
    ) {
      const checkpoint = await this.checkpoints.capture(session, session.checkpointTurnSeq, 'post')
      stamped.payload = {
        ...stamped.payload,
        checkpointTurnSeq: session.checkpointTurnSeq,
        checkpointAvailable: checkpoint.ok,
      }
      if (checkpoint.ok) {
        const diff = await this.checkpoints.getTurnDiff({ key: session, turnSeq: session.checkpointTurnSeq })
        if (diff.ok)
          stamped.payload.checkpointSummary = {
            files: diff.diff.files.length,
            addedLines: diff.diff.files.reduce((sum, file) => sum + file.addedLines, 0),
            removedLines: diff.diff.files.reduce((sum, file) => sum + file.removedLines, 0),
          }
      }
    }
    if (session.checkpointNotice && !session.checkpointNoticeSent) {
      stamped.payload = { ...stamped.payload, notice: session.checkpointNotice }
      session.checkpointNoticeSent = true
    }
    this.trackStatefulSessionEvent(session, stamped)
    if (stamped.type === 'approval_requested' && typeof stamped.payload?.requestId === 'string') {
      const request: ApprovalRuleRequest = {
        action: String(stamped.payload.action ?? ''),
        input: stamped.payload.input,
        toolKind: stamped.payload.toolKind as ApprovalRuleRequest['toolKind'],
        requestKind: String(stamped.payload.kind ?? 'tool'),
      }
      const requestId = stamped.payload.requestId
      session.approvalRequests.set(requestId, request)
      void this.approvalRules
        .match(session.workspaceRoot, session.sessionId, request)
        .then(async (rule) => {
          if (!rule || !session.approvalRequests.has(requestId) || session.status === 'stopped') return
          session.automaticApprovals.set(requestId, rule.label)
          await this.respondToRequest({ sessionId: session.sessionId, requestId, approved: true, decision: 'once' })
        })
        .catch(() => undefined)
    } else if (stamped.type === 'approval_resolved' && typeof stamped.payload?.requestId === 'string') {
      const requestId = stamped.payload.requestId
      const ruleLabel = session.automaticApprovals.get(requestId)
      if (ruleLabel) stamped.payload = { ...stamped.payload, autoApproved: true, ruleLabel }
      session.approvalRequests.delete(requestId)
      session.automaticApprovals.delete(requestId)
    }
    this.updateExcerpts(session, stamped)
    // A streamed delta goes to listeners immediately; persistence coalesces text.
    if (isStreamedDelta(stamped)) {
      this.notify(stamped)
      await this.persistEvent(session, stamped)
      return stamped
    }
    await this.persistEvent(session, stamped)
    if (stamped.type === 'turn_completed' && session.status !== 'stopped')
      await this.threadIndex.refresh(session).catch(() => undefined)
    // Publish status at the same boundary as the terminal notification, after
    // persistence. Pollers and event-driven consumers must observe one state.
    if (session.status !== 'stopped' && (stamped.type === 'turn_completed' || stamped.type === 'turn_failed')) {
      session.status = stamped.type === 'turn_completed' ? 'ready' : 'failed'
      session.updatedAt = this.now()
    }
    this.notify(stamped)
    return stamped
  }

  private updateExcerpts(session: RuntimeSession, event: ConversationEvent): void {
    if ((event.type === 'session_started' || event.type === 'session_updated') && event.payload?.capabilities)
      session.capabilities = {
        ...session.capabilities,
        ...(event.payload.capabilities as import('../shared/conversation-runtime').ConversationCapabilities),
      }
    if (event.type === 'session_updated' && typeof event.payload?.revertedAfterSeq === 'number')
      session.revertedNote = `Files were ${event.payload.undo ? 'restored from the undo checkpoint' : `reverted to before conversation turn ${event.payload.revertedAfterSeq}`}. Inspect the current files before continuing; later transcript messages describe the previous file state.`
    if (event.type === 'tool_started')
      session.currentToolTitle = presentToolItem({
        kind: event.payload?.kind as import('../shared/conversation-runtime').ConversationToolKind,
        name: String(event.payload?.name ?? event.payload?.tool ?? ''),
        input: event.payload?.input as ConversationJsonValue | undefined,
        status: 'running',
      }).title
    else if (event.type === 'tool_output' || event.type === 'turn_completed' || event.type === 'turn_failed')
      session.currentToolTitle = undefined
    if (event.type === 'turn_completed') session.phase = 'completed'
    else if (event.type === 'turn_failed') session.phase = 'failed'
    else if (event.type === 'turn_started' || event.type === 'user_message' || event.type === 'approval_resolved')
      session.phase = 'running'
    else if (event.type === 'approval_requested')
      session.phase = event.payload?.kind === 'question' ? 'waiting_for_input' : 'waiting_for_approval'
    if (event.type === 'user_message' && typeof event.payload?.text === 'string') {
      session.firstUserText ??= event.payload.text.slice(0, 240)
      session.lastUserText = event.payload.text.slice(0, 240)
      session.lastAssistantText = ''
    } else if (event.type === 'content_delta' && typeof event.payload?.text === 'string') {
      session.lastAssistantText = ((session.lastAssistantText ?? '') + event.payload.text).slice(0, 240)
    }
  }

  private runCommand(
    sessionId: string,
    commandId: string,
    action: () => Promise<ConversationSessionActionResult>,
  ): Promise<ConversationSessionActionResult> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.resolve({ ok: false, message: 'Conversation session is invalid.' })
    const path = this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId).replace(
      /\.jsonl$/,
      '.receipts.json',
    )
    const key = `${path}:${commandId}`
    const pending = this.pendingCommands.get(key)
    if (pending) return pending
    if (!this.receipts.has(path)) {
      this.receipts.set(
        path,
        readFile(path, 'utf8')
          .then((raw) => new Map<string, ConversationSessionActionResult>(JSON.parse(raw)))
          .catch(() => new Map()),
      )
    }
    const result = (async () => {
      const receipts = await this.receipts.get(path)!
      const prior = receipts.get(commandId)
      if (prior) return prior
      const receipt = JSON.parse(JSON.stringify(await action())) as ConversationSessionActionResult
      receipts.set(commandId, receipt)
      while (receipts.size > 256) receipts.delete(receipts.keys().next().value!)
      const write = (this.receiptWrites.get(path) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, JSON.stringify(Array.from(receipts)), 'utf8')
        })
      this.receiptWrites.set(path, write)
      await write
      return receipt
    })()
    this.pendingCommands.set(key, result)
    void result.finally(() => this.pendingCommands.delete(key)).catch(() => undefined)
    return result
  }

  // Stateful adapters surface approvals mid-stream (the provider turn blocks
  // inside a permission callback while its event stream stays open), so the
  // pending-request cursor has to follow the events rather than the
  // end-of-stream summary that stateless turns use.
  private trackStatefulSessionEvent(session: RuntimeSession, event: ConversationEvent): void {
    if (!session.stateful) return
    if (event.type === 'approval_requested') {
      const requestId = typeof event.payload?.requestId === 'string' ? event.payload.requestId : null
      if (requestId) {
        session.pendingApprovalRequestIds.add(requestId)
        session.pendingRequestId = requestId
        session.status = 'awaiting_approval'
        session.updatedAt = this.now()
      }
    } else if (event.type === 'approval_resolved') {
      const requestId = typeof event.payload?.requestId === 'string' ? event.payload.requestId : null
      if (requestId) session.pendingApprovalRequestIds.delete(requestId)
      const remaining = Array.from(session.pendingApprovalRequestIds)
      if (remaining.length > 0) {
        session.pendingRequestId = remaining[remaining.length - 1]
        session.status = 'awaiting_approval'
      } else {
        session.pendingRequestId = session.turnLockRequestId
        if (session.status === 'awaiting_approval') session.status = 'active'
      }
      session.updatedAt = this.now()
    } else if (event.type === 'turn_failed' || event.type === 'turn_completed') {
      session.pendingApprovalRequestIds.clear()
    }
  }

  // The session-scoped continuation channel: a stateful adapter pushes events
  // here when its child resumes after a `result` with no open sendTurn (e.g. a
  // background subagent completed and the model issued another tool call). Runs
  // outside any sendTurn IPC, so the composer stays free to end the prior turn.
  // Serialized through session.continuationTail to keep persistence ordered.
  private enqueueContinuationEvent(session: RuntimeSession, event: ConversationEvent): void {
    session.continuationTail = session.continuationTail
      .catch(() => undefined)
      .then(() => this.processContinuationEvent(session, event))
      .catch(async (error) => {
        await this.failTurn(session, error)
      })
  }

  private async processContinuationEvent(session: RuntimeSession, event: ConversationEvent): Promise<void> {
    if (session.status === 'stopped') return
    const turnId = typeof event.payload?.turnId === 'string' ? event.payload.turnId : null
    if (turnId && session.canceledTurnIds.has(turnId)) return
    // First sight of a continuation turn: open a mirror in session state so its
    // events survive suppression and its approvals track through the normal
    // pendingRequestId path. A concurrently-completing sendTurn will see its own
    // turnId no longer active and skip its post-loop reset, so this stands.
    if (event.type === 'turn_started' && turnId && turnId !== session.activeTurnId) {
      // A live turn owns the session. The continuation raced a send that the
      // busy guard could not see yet (the channel is serialized off the send
      // path), and the adapter has since taken the turn over — so this mirror
      // would only blank the live turn by suppressing every event it has left.
      if (isSessionBusy(session)) return
      session.activeTurnId = turnId
      session.activeTurnAbort = null
      session.turnLockRequestId = null
      session.pendingRequestId = null
      session.pendingApprovalRequestIds.clear()
      session.status = 'active'
      session.checkpointTurnSeq = null
      session.checkpointCapture = null
      session.checkpointCaptured = false
      session.updatedAt = this.now()
    }
    await this.emit(session, event, turnId ? { turnId } : {})
    if (
      turnId &&
      session.activeTurnId === turnId &&
      (event.type === 'turn_completed' || event.type === 'turn_failed')
    ) {
      session.activeTurnId = null
      session.activeTurnAbort = null
      session.turnLockRequestId = null
      session.pendingRequestId = null
      session.pendingApprovalRequestIds.clear()
      session.status = event.type === 'turn_completed' ? 'ready' : 'failed'
      session.updatedAt = this.now()
    }
  }

  private shouldSuppressEvent(
    session: RuntimeSession,
    event: ConversationEvent,
    options: { turnId?: string; allowCanceledTurnId?: string | null },
  ): boolean {
    const eventTurnId =
      event.payload && typeof event.payload.turnId === 'string' ? event.payload.turnId : options.turnId
    if (!eventTurnId) return false
    if (eventTurnId === options.allowCanceledTurnId) return false
    if (session.status === 'stopped') return true
    if (session.canceledTurnIds.has(eventTurnId)) return true
    return session.activeTurnId !== eventTurnId
  }

  private eventForSession(
    session: RuntimeSession,
    type: ConversationEvent['type'],
    payload?: Record<string, unknown>,
  ): ConversationEvent {
    return {
      id: '',
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      providerId: session.providerId,
      modelId: session.modelId,
      type,
      createdAt: 0,
      payload,
    }
  }

  private applyTurnState(session: RuntimeSession, events: ConversationEvent[], requestId: string): void {
    // A terminal event always wins: a dead turn cannot keep an approval
    // pending (e.g. the provider child crashed while a card was up — leaving
    // the session in awaiting_approval would wedge it forever, since the
    // adapter-side permission no longer exists to resolve).
    const failed = events.some((event) => event.type === 'turn_failed')
    const completed = events.some((event) => event.type === 'turn_completed')
    if (failed || completed) {
      session.pendingRequestId = null
      session.pendingApprovalRequestIds.clear()
      session.status = failed ? 'failed' : 'ready'
      session.activeTurnId = null
      session.turnLockRequestId = null
      session.updatedAt = this.now()
      return
    }
    // An approval is pending at end-of-stream only when a request was never
    // resolved. Stateless turns end their stream at the request; stateful
    // turns resolve requests mid-stream and keep going.
    const requested = events.filter((event) => event.type === 'approval_requested').length
    const resolved = events.filter((event) => event.type === 'approval_resolved').length
    if (requested > resolved) {
      session.pendingRequestId = session.stateful ? session.pendingRequestId : requestId
      session.status = 'awaiting_approval'
    } else {
      session.pendingRequestId = null
      session.status = 'active'
    }
    session.updatedAt = this.now()
  }

  private persistEvent(session: RuntimeSession, event: ConversationEvent): Promise<void> {
    return this.eventLog.append(
      this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId),
      redactEvent(event),
    )
  }

  private toolDetailPath(input: ConversationToolDetailInput): string {
    return workspaceSidecarPath(
      input.workspaceRoot,
      'conversations',
      safeSegment(input.workspaceId),
      `${safeSegment(input.agentId)}.tools`,
      `${safeSegment(input.toolUseId)}.json`,
    )
  }

  async getToolDetail(input: ConversationToolDetailInput): Promise<ConversationToolDetailResult> {
    if (
      !input.workspaceRoot?.trim() ||
      !input.workspaceId?.trim() ||
      !input.agentId?.trim() ||
      !input.toolUseId?.trim()
    ) {
      return { ok: false, code: 'invalid_input', message: 'Conversation and tool identity are required.' }
    }
    return readToolDetail(this.toolDetailPath(input))
  }

  /** Explicit deletion removes the paired detail store as well as the transcript. */
  async listThreads(input: ConversationWorkspaceKey) {
    try {
      await this.eventLog.flush()
      return { ok: true as const, threads: await this.threadIndex.list(input) }
    } catch (error) {
      return { ok: false as const, message: String(error) }
    }
  }

  async searchThreads(
    input: ConversationSearchInput,
    options: { signal?: AbortSignal; onBatch?: (hits: ConversationSearchHit[]) => void } = {},
  ) {
    try {
      await this.eventLog.flush()
      return { ok: true as const, hits: await this.threadIndex.search(input, options) }
    } catch (error) {
      return { ok: false as const, message: String(error) }
    }
  }

  async renameThread(input: ConversationRenameInput, titleSource: 'user' | 'generated' = 'user') {
    if (this.deletingTranscripts.has(this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)))
      return { ok: false as const, message: 'Conversation is being deleted.' }
    const title = input.title.trim().slice(0, 200)
    if (!title) return { ok: false as const, message: 'A conversation title is required.' }
    try {
      const threads = await this.threadIndex.list(input)
      const thread = threads.find((entry) => entry.agentId === input.agentId)
      if (!thread) return { ok: false as const, message: 'Conversation was not found.' }
      if (titleSource === 'generated' && thread.titleSource === 'user') return { ok: true as const }
      const path = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
      const pending = (this.emissionTails.get(path) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const replay = await this.readTranscript(input, { all: true, closeOpenTurns: false })
          if (!replay.ok) throw new Error(replay.message)
          const previous = replay.events.at(-1)
          if (!previous) throw new Error('Conversation was not found.')
          // The source event is authoritative even if another rename raced the index lookup.
          if (titleSource === 'generated' && replay.events.some((event) => event.payload?.titleSource === 'user'))
            return
          const event: ConversationEvent = {
            ...previous,
            id: `conv_evt_${this.eventEpoch}_${++this.eventSequence}`,
            seq: Math.max(this.sequences.get(path) ?? 0, previous.seq ?? 0) + 1,
            createdAt: this.now(),
            type: 'session_updated',
            payload: { conversationTitle: title, titleSource },
          }
          this.sequences.set(path, event.seq!)
          await this.eventLog.append(path, event)
          this.notify(event)
        })
      this.emissionTails.set(path, pending)
      await pending
      await this.threadIndex.refresh(input)
      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, message: String(error) }
    }
  }

  async deleteTranscript(input: ConversationTranscriptInput): Promise<ConversationTranscriptResult> {
    if (!input.workspaceRoot?.trim() || !input.workspaceId?.trim() || !input.agentId?.trim())
      return { ok: false, message: 'Conversation identity is required.' }
    const path = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
    if (this.deletingTranscripts.has(path) || this.startingTranscripts.has(path))
      return { ok: false, message: 'Conversation lifecycle operation is already in progress.' }
    const matching = Array.from(this.sessions.values()).filter(
      (session) =>
        session.workspaceRoot === input.workspaceRoot &&
        session.workspaceId === input.workspaceId &&
        session.agentId === input.agentId,
    )
    if (matching.some((session) => isSessionBusy(session) || session.status === 'starting'))
      return { ok: false, message: 'Stop the active conversation turn before deleting it.' }
    this.deletingTranscripts.add(path)
    try {
      for (const session of matching)
        if (session.status !== 'stopped') await this.stopSession({ sessionId: session.sessionId })
      await this.emissionTails.get(path)
      for (const session of matching) await session.continuationTail
      await this.threadIndex.delete(input)
      await this.checkpoints.deleteConversation(input)
      await rm(path, { force: true })
      await rm(path.replace(/\.jsonl$/, '.tools'), { recursive: true, force: true })
      const receiptsPath = path.replace(/\.jsonl$/, '.receipts.json')
      await this.receiptWrites.get(receiptsPath)
      await rm(receiptsPath, { force: true })
      this.receipts.delete(receiptsPath)
      this.sequences.delete(path)
      this.emissionTails.delete(path)
      for (const session of matching) this.sessions.delete(session.sessionId)
      return { ok: true, events: [] }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      this.deletingTranscripts.delete(path)
    }
  }

  private async prepareToolEvent(session: RuntimeSession, event: ConversationEvent): Promise<ConversationEvent> {
    if (event.type !== 'tool_started' && event.type !== 'tool_output') return event
    const payload = redactConversationValue({ ...event.payload })
    const toolUseId =
      typeof payload.toolUseId === 'string'
        ? payload.toolUseId
        : typeof payload.toolCallId === 'string'
          ? payload.toolCallId
          : undefined
    if (!toolUseId) return { ...event, payload }
    payload.toolUseId = toolUseId
    const path = this.toolDetailPath({ ...session, toolUseId })
    const previous = await readToolDetail(path)
    const detail: ConversationToolDetail = previous.ok
      ? previous.detail
      : { input: {}, output: '', status: 'ok', clipped: false }
    if (event.type === 'tool_started') {
      const name =
        typeof payload.name === 'string' ? payload.name : typeof payload.tool === 'string' ? payload.tool : ''
      payload.name = name
      payload.kind = payload.kind ?? inferConversationToolKind(name)
      detail.input = (payload.input ?? {}) as ConversationJsonValue
      if (Buffer.byteLength(JSON.stringify(detail.input)) > 64 * 1024) {
        payload.input = {}
        payload.inputTruncated = true
      }
    } else {
      detail.output = (payload.output ?? payload.preview ?? '') as ConversationJsonValue
      if (payload.clipped === true) detail.clipped = true
      detail.status =
        payload.status === 'declined' || payload.status === 'stopped' || payload.status === 'error'
          ? payload.status
          : payload.isError
            ? 'error'
            : 'ok'
      if (typeof payload.exitCode === 'number') detail.exitCode = payload.exitCode
      if (typeof payload.mime === 'string') detail.mime = payload.mime
      const text = typeof detail.output === 'string' ? detail.output : JSON.stringify(detail.output)
      const binary = detail.mime !== undefined && !/^(text\/|application\/(json|xml))/.test(detail.mime)
      detail.totalBytes = typeof payload.totalBytes === 'number' ? payload.totalBytes : Buffer.byteLength(text)
      if (binary) detail.output = ''
      payload.preview = binary ? '' : text.slice(0, 4000)
      payload.output = payload.preview
      payload.totalBytes = detail.totalBytes
      payload.truncated = binary || text.length > 4000
      payload.status = detail.status
    }
    await writeToolDetail(path, detail)
    return { ...event, payload }
  }

  private transcriptPath(workspaceRoot: string, workspaceId: string, agentId: string): string {
    return workspaceSidecarPath(
      workspaceRoot,
      'conversations',
      safeSegment(workspaceId),
      `${safeSegment(agentId)}.jsonl`,
    )
  }

  // Replay the persisted transcript for one agent, bounded to the most recent
  // events so a long-lived chat cannot flood the renderer.
  async readTranscript(
    input: ConversationTranscriptInput,
    options: { all?: boolean; closeOpenTurns?: boolean } = {},
  ): Promise<ConversationTranscriptResult> {
    if (!input.workspaceRoot?.trim() || !input.workspaceId?.trim() || !input.agentId?.trim()) {
      return { ok: false, message: 'Conversation transcript request is invalid.' }
    }
    const filePath = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
    // Buffered deltas first, so a reload mid-stream sees everything emitted.
    await this.eventLog.flush(filePath)
    let raw: string
    try {
      raw = (await this.readFile(filePath, 'utf-8')) as string
    } catch {
      return { ok: true, events: [] }
    }
    const events: ConversationEvent[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as ConversationEvent
        // A merged run of deltas comes back as the deltas that were emitted,
        // ids included — the chat view dedupes replay against live pushes.
        if (parsed && typeof parsed.type === 'string') {
          if (parsed.type === 'tool_started' && parsed.payload && !parsed.payload.kind) {
            parsed.payload.kind = inferConversationToolKind(String(parsed.payload.name ?? parsed.payload.tool ?? ''))
          }
          events.push(...expandCoalescedDeltas(parsed))
        }
      } catch {
        // Skip torn/corrupt lines (e.g. a crash mid-append).
      }
    }
    let seq = 0
    for (const event of events) {
      event.seq = typeof event.seq === 'number' && event.seq > seq ? event.seq : seq + 1
      seq = event.seq
    }
    const bounded = options.all ? events : events.slice(-MAX_TRANSCRIPT_REPLAY_EVENTS)
    const live = Array.from(this.sessions.values()).some(
      (session) =>
        session.workspaceRoot === input.workspaceRoot &&
        session.workspaceId === input.workspaceId &&
        session.agentId === input.agentId &&
        session.status !== 'stopped',
    )
    return {
      ok: true,
      events: [...bounded, ...(options.closeOpenTurns !== false && !live ? syntheticTurnClosures(bounded) : [])],
    }
  }

  async recoverTranscript(input: ConversationTranscriptInput): Promise<void> {
    if (this.deletingTranscripts.has(this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)))
      throw new Error('Conversation is being deleted.')
    await this.initializeSequence(input)
  }

  private async initializeSequence(input: ConversationTranscriptInput): Promise<void> {
    const path = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
    const existing = this.sequenceInitializations.get(path)
    if (existing) return existing
    const pending = this.initializeSequenceNow(input)
    this.sequenceInitializations.set(path, pending)
    try {
      await pending
    } finally {
      if (this.sequenceInitializations.get(path) === pending) this.sequenceInitializations.delete(path)
    }
  }

  private async initializeSequenceNow(input: ConversationTranscriptInput): Promise<void> {
    const path = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
    if (this.sequences.has(path)) return
    const transcript = await this.readTranscript(input, { all: true })
    if (!transcript.ok) throw new Error(transcript.message)
    for (const event of transcript.events) {
      if (event.id.startsWith('conv_evt_replay_close_')) await this.eventLog.append(path, event)
    }
    this.sequences.set(path, transcript.events.at(-1)?.seq ?? 0)
    await this.checkpoints.collectExpired(input.workspaceRoot)
  }

  private async captureBeforeTool(session: RuntimeSession, name: string): Promise<void> {
    if (!session.capabilities?.checkpoints || !session.checkpointTurnSeq) return
    if (['file_read', 'search', 'list', 'web', 'todo'].includes(inferConversationToolKind(name))) return
    if (!session.checkpointCapture) {
      session.checkpointCapture = (async () => {
        const result = await this.checkpoints.capture(session, session.checkpointTurnSeq!, 'pre')
        session.checkpointCaptured = result.ok
        if (!result.ok) session.checkpointNotice = result.message
      })()
    }
    await session.checkpointCapture
  }

  getTurnDiff(input: ConversationTurnDiffInput): Promise<ConversationTurnDiffResult> {
    return this.checkpoints.getTurnDiff(input)
  }
  async listApprovalRules() {
    try {
      return { ok: true as const, rules: await this.approvalRules.list() }
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : 'Permission rules are unavailable.',
      }
    }
  }
  async revokeApprovalRule(ruleId: string) {
    try {
      await this.approvalRules.revoke(ruleId)
      return { ok: true as const }
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : 'Permission rule could not be revoked.',
      }
    }
  }

  async revertToTurn(input: ConversationRevertInput): Promise<ConversationRevertResult> {
    const matching = Array.from(this.sessions.values()).filter(
      (session) =>
        session.workspaceRoot === input.key.workspaceRoot &&
        session.workspaceId === input.key.workspaceId &&
        session.agentId === input.key.agentId,
    )
    if (matching.some(isSessionBusy)) return { ok: false, message: 'Stop the running turn before reverting files.' }
    const result = await this.checkpoints.revert(input)
    if (result.ok && result.reverted) {
      for (const session of matching) {
        session.revertedNote = `Files were ${input.undo ? 'restored from the undo checkpoint' : `reverted to before conversation turn ${input.turnSeq}`}. Inspect the current files before continuing; later transcript messages describe the previous file state.`
      }
      const session = matching.at(-1)
      if (session)
        await this.emit(
          session,
          this.eventForSession(session, 'session_updated', {
            revertedAfterSeq: input.turnSeq,
            undo: input.undo === true,
          }),
        )
    }
    return result
  }

  // The latest provider-session cursor recorded in the transcript; stateful
  // providers use it to natively resume after a restart.
  private async readResumeCursor(
    workspaceRoot: string,
    workspaceId: string,
    agentId: string,
  ): Promise<string | undefined> {
    const transcript = await this.readTranscript({ workspaceRoot, workspaceId, agentId })
    if (!transcript.ok) return undefined
    for (let index = transcript.events.length - 1; index >= 0; index -= 1) {
      const event = transcript.events[index]
      if (event.type !== 'session_updated' && event.type !== 'session_started') continue
      const cursor = event.payload?.providerSessionId
      if (typeof cursor === 'string' && cursor.trim()) return cursor.trim()
    }
    return undefined
  }

  private toSummary(session: RuntimeSession): ConversationSessionSummary {
    const { sessionId, workspaceId, agentId, providerId, modelId, status, createdAt, updatedAt, permissionPreset } =
      session
    return {
      sessionId,
      workspaceId,
      agentId,
      providerId,
      modelId,
      status,
      createdAt,
      updatedAt,
      displayName: session.displayName,
      capabilities: session.capabilities,
      phase: session.phase,
      currentToolTitle: session.currentToolTitle,
      firstUserText: session.firstUserText,
      lastUserText: session.lastUserText,
      lastAssistantText: session.lastAssistantText,
      // Only when the session carries one, so a session that never chose a
      // preset reports absence rather than an invented 'default'.
      ...(permissionPreset ? { permissionPreset } : {}),
    }
  }
}

// The one busy predicate: a session is busy while any turn is open, whether it
// came from `sendTurn` or from the adapter's continuation channel. A
// continuation turn clears `pendingRequestId`, so that field alone would report
// an occupied session as free and let a second turn take it over.
function completedHistory(events: ConversationEvent[]): ConversationMessage[] {
  const history: ConversationMessage[] = []
  let user: string | undefined
  let assistant = ''
  for (const event of events) {
    if (event.type === 'user_message') {
      user = typeof event.payload?.text === 'string' ? event.payload.text : undefined
      assistant = ''
    } else if (event.type === 'content_delta' && typeof event.payload?.text === 'string')
      assistant += event.payload.text
    else if (event.type === 'turn_completed' && user !== undefined) {
      history.push({ role: 'user', content: user })
      if (assistant) history.push({ role: 'assistant', content: assistant })
      user = undefined
      assistant = ''
    } else if (event.type === 'turn_failed') {
      user = undefined
      assistant = ''
    }
  }
  return history
}

function isSessionBusy(session: RuntimeSession): boolean {
  return session.activeTurnId !== null || session.pendingRequestId !== null
}

function safeSegment(value: string): string {
  const encoded = encodeURIComponent(value.trim().replace(/[\\/]/g, '-'))
  return encoded === '.' || encoded === '..' ? encoded.replace(/\./g, '%2E') : encoded
}

// A transcript can end mid-turn (the app died while streaming). Replaying it
// verbatim would leave the projection permanently "streaming" and block the
// composer, so unfinished turns are closed with synthetic interrupt events —
// not persisted, only appended to the replay result.
function syntheticTurnClosures(events: ConversationEvent[]): ConversationEvent[] {
  const openTurns = new Map<string, ConversationEvent>()
  for (const event of events) {
    const turnId = typeof event.payload?.turnId === 'string' ? event.payload.turnId : null
    if (!turnId) continue
    if (event.type === 'turn_started' || event.type === 'user_message') {
      if (!openTurns.has(turnId)) openTurns.set(turnId, event)
    } else if (event.type === 'turn_completed' || event.type === 'turn_failed') {
      openTurns.delete(turnId)
    }
  }
  let sequence = 0
  return Array.from(openTurns.entries()).map(([turnId, source]) => ({
    id: `conv_evt_replay_close_${++sequence}`,
    seq: (events.at(-1)?.seq ?? 0) + sequence,
    sessionId: source.sessionId,
    workspaceId: source.workspaceId,
    agentId: source.agentId,
    providerId: source.providerId,
    modelId: source.modelId,
    type: 'turn_failed',
    createdAt: source.createdAt,
    payload: { turnId, reason: 'interrupted', message: 'The app closed while this turn was streaming.' },
  }))
}

function isAsyncIterable(
  value: ConversationEvent[] | AsyncIterable<ConversationEvent>,
): value is AsyncIterable<ConversationEvent> {
  return typeof (value as AsyncIterable<ConversationEvent>)[Symbol.asyncIterator] === 'function'
}

function redactEvent(event: ConversationEvent): ConversationEvent {
  return redactConversationValue(event)
}

function isStreamedDelta(event: ConversationEvent): boolean {
  return event.type === 'content_delta' || event.type === 'reasoning_delta'
}
