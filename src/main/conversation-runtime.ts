import { stat, readFile } from 'fs/promises'

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
} from '../shared/conversation-runtime'
import { getConversationProviderById } from './plugin-registry-instance'
import { ProviderSecretStore } from './secret-store'
import { clampSuspendIdleAfterMs, DEFAULT_SUSPEND_IDLE_AFTER_MS } from './terminal-reap-policy'
import type { TerminalRootInfo } from './workspace-memory'
import {
  createMockConversationProvider,
  type ConversationMessage,
  type ConversationProviderAdapter,
  type ConversationProviderEventStream,
} from './providers/mock-conversation-provider'
import { createOpenAiCompatibleProvider } from './providers/openai-compatible-provider'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './providers/claude-agent-provider'
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
  cliRuntimes?: ConversationCliRuntimeOverrides
  permissionPreset?: ConversationPermissionPreset
  allowedTools?: string[]
}

type ConversationRuntimeOptions = {
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
  private readonly readFile: typeof readFile
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly prepareStudioMcp?: ConversationRuntimeOptions['prepareStudioMcp']
  private readonly sessions = new Map<string, RuntimeSession>()
  private readonly listeners = new Set<ConversationRuntimeListener>()
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
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? (() => Math.random().toString(36).slice(2, 10))
    this.prepareStudioMcp = options.prepareStudioMcp
    // Startup-time epoch (not randomId — tests inject deterministic id
    // sequences that must not be consumed by construction).
    this.eventEpoch = this.now().toString(36)
  }

  onEvent(listener: ConversationRuntimeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async startSession(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult> {
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
      cliRuntimes: input.cliRuntimes,
      permissionPreset: input.permissionPreset,
      allowedTools: input.allowedTools,
    }
    this.sessions.set(sessionId, session)

    // Stateful providers resume their own durable session; the latest cursor
    // lives in the JSONL transcript this runtime already writes.
    const resumeSessionId = stateful
      ? await this.readResumeCursor(session.workspaceRoot, session.workspaceId, session.agentId)
      : undefined
    await this.emitAll(
      session,
      validation.adapter.startSession({
        ...session,
        resumeSessionId,
        // Continuation channel: the adapter opens a mirror turn here when its
        // child resumes after a `result` (background subagents completing).
        onSessionEvent: (event) => this.enqueueContinuationEvent(session, event),
      }),
    )
    session.status = 'ready'
    session.updatedAt = this.now()
    return { ok: true, session: this.toSummary(session) }
  }

  async sendTurn(input: ConversationSendTurnInput): Promise<ConversationSessionActionResult> {
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, message: 'Conversation session is invalid.' }
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
    if (!message && attachments.length === 0) return { ok: false, message: 'Conversation turn message is required.' }

    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }

    const turnId = `turn_${this.randomId()}`
    const requestId = `approval_${this.randomId()}`
    const turnAbort = new AbortController()
    session.activeTurnId = turnId
    session.pendingRequestId = requestId
    session.turnLockRequestId = requestId
    session.activeTurnAbort = turnAbort
    session.status = 'active'
    session.updatedAt = this.now()
    // Persist the user's side of the exchange so the JSONL transcript replays
    // as a complete conversation after a restart.
    await this.emit(
      session,
      this.eventForSession(session, 'user_message', {
        turnId,
        text: message,
        ...(input.localTurnId ? { localTurnId: input.localTurnId } : {}),
      }),
      { turnId },
    )
    // The model sees prior completed turns plus this message, so it has memory.
    // Stateful providers own their history natively — replaying ours would
    // duplicate context and defeat resume, so they get only the new message.
    const messages: ConversationMessage[] | undefined = session.stateful
      ? undefined
      : [...session.history, { role: 'user', content: message }]
    // Attachments are carried live into the turn call; only vision-capable
    // adapters read them. They are not persisted into history (v1 is
    // live-only), so history and JSONL replay stay text-only.
    const events = await this.emitAll(
      session,
      adapter.sendTurn({
        ...session,
        turnId,
        requestId,
        message,
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
  }

  async respondToRequest(input: ConversationRespondToRequestInput): Promise<ConversationSessionActionResult> {
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, message: 'Conversation session is invalid.' }
    const requestIsPending =
      session.pendingRequestId === input.requestId || session.pendingApprovalRequestIds.has(input.requestId)
    if (!session.activeTurnId || !requestIsPending) {
      return { ok: false, message: 'Conversation approval request is invalid.' }
    }
    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }

    await this.emitAll(
      session,
      adapter.resolveApproval({
        ...session,
        turnId: session.activeTurnId,
        requestId: input.requestId,
        approved: input.approved,
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
    if (this.shouldSuppressEvent(session, event, options)) return null
    const stamped: ConversationEvent = {
      ...event,
      id: `conv_evt_${this.eventEpoch}_${++this.eventSequence}`,
      createdAt: this.now(),
    }
    this.trackStatefulSessionEvent(session, stamped)
    // Listeners first: the chat on screen never waits for the disk. A delta is
    // only buffered here; a boundary event is awaited, which writes the text
    // run before it and keeps the transcript's order the emission order.
    for (const listener of this.listeners) listener(stamped)
    await this.persistEvent(session, stamped)
    return stamped
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
  async readTranscript(input: ConversationTranscriptInput): Promise<ConversationTranscriptResult> {
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
        if (parsed && typeof parsed.type === 'string') events.push(...expandCoalescedDeltas(parsed))
      } catch {
        // Skip torn/corrupt lines (e.g. a crash mid-append).
      }
    }
    const bounded = events.slice(-MAX_TRANSCRIPT_REPLAY_EVENTS)
    return { ok: true, events: [...bounded, ...syntheticTurnClosures(bounded)] }
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
function isSessionBusy(session: RuntimeSession): boolean {
  return session.activeTurnId !== null || session.pendingRequestId !== null
}

function safeSegment(value: string): string {
  return encodeURIComponent(value.trim().replace(/[\\/]/g, '-'))
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
  return JSON.parse(
    JSON.stringify(event, (key, value) => {
      if (key === 'inputTokens' || key === 'outputTokens' || key === 'totalTokens') {
        return value
      }
      if (typeof key === 'string' && /secret|token|api[-_]?key|authorization/i.test(key)) {
        return '[redacted]'
      }
      return value
    }),
  ) as ConversationEvent
}
