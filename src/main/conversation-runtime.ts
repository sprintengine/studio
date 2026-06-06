import { mkdir, stat, appendFile } from 'fs/promises'
import { join } from 'path'

import type {
  ConversationEvent,
  ConversationInterruptInput,
  ConversationListSessionsInput,
  ConversationListSessionsResult,
  ConversationRespondToRequestInput,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationSessionSummary,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationStopSessionInput,
} from '../shared/conversation-runtime'
import { getConversationProviderById } from './plugin-registry-instance'
import { ProviderSecretStore } from './secret-store'
import {
  createMockConversationProvider,
  type ConversationMessage,
  type ConversationProviderAdapter,
  type ConversationProviderEventStream,
} from './providers/mock-conversation-provider'
import { createOpenAiCompatibleProvider } from './providers/openai-compatible-provider'

type RuntimeSession = ConversationSessionSummary & {
  workspaceRoot: string
  activeTurnId: string | null
  pendingRequestId: string | null
  activeTurnAbort: AbortController | null
  canceledTurnIds: Set<string>
  // Completed turns only, in send order, so each new turn carries prior context.
  // A failed/interrupted turn is not recorded, so a retry re-sends cleanly.
  history: ConversationMessage[]
}

type ConversationRuntimeOptions = {
  adapters?: ConversationProviderAdapter[]
  secretStore?: Pick<ProviderSecretStore, 'getStatus'> & Partial<Pick<ProviderSecretStore, 'resolveSecret'>>
  getProviderById?: typeof getConversationProviderById
  stat?: typeof stat
  mkdir?: typeof mkdir
  appendFile?: typeof appendFile
  now?: () => number
  randomId?: () => string
}

type ConversationRuntimeListener = (event: ConversationEvent) => void

export class ConversationRuntime {
  private readonly adapters = new Map<string, ConversationProviderAdapter>()
  private readonly secretStore: Pick<ProviderSecretStore, 'getStatus'> & Partial<Pick<ProviderSecretStore, 'resolveSecret'>>
  private readonly getProviderById: typeof getConversationProviderById
  private readonly stat: typeof stat
  private readonly mkdir: typeof mkdir
  private readonly appendFile: typeof appendFile
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly sessions = new Map<string, RuntimeSession>()
  private readonly listeners = new Set<ConversationRuntimeListener>()
  private eventSequence = 0

  constructor(options: ConversationRuntimeOptions = {}) {
    this.secretStore = options.secretStore ?? new ProviderSecretStore()
    this.getProviderById = options.getProviderById ?? getConversationProviderById
    const defaultAdapters = [
      createMockConversationProvider(),
      createOpenAiCompatibleProvider({
        getProviderById: this.getProviderById,
        resolveSecret: (providerId) => this.resolveSecret(providerId),
      }),
    ]
    for (const adapter of options.adapters ?? defaultAdapters) {
      this.adapters.set(adapter.id, adapter)
    }
    this.stat = options.stat ?? stat
    this.mkdir = options.mkdir ?? mkdir
    this.appendFile = options.appendFile ?? appendFile
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? (() => Math.random().toString(36).slice(2, 10))
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

    const sessionId = `conv_${this.randomId()}`
    const now = this.now()
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
    }
    this.sessions.set(sessionId, session)

    await this.emitAll(session, validation.adapter.startSession(session))
    session.status = 'ready'
    session.updatedAt = this.now()
    return { ok: true, session: this.toSummary(session) }
  }

  async sendTurn(input: ConversationSendTurnInput): Promise<ConversationSessionActionResult> {
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, message: 'Conversation session is invalid.' }
    if (session.status === 'stopped') return { ok: false, message: 'Conversation session is stopped.' }
    if (session.pendingRequestId) return { ok: false, message: 'Conversation turn is awaiting approval.' }
    const message = input.message.trim()
    if (!message) return { ok: false, message: 'Conversation turn message is required.' }

    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }

    const turnId = `turn_${this.randomId()}`
    const requestId = `approval_${this.randomId()}`
    const turnAbort = new AbortController()
    session.activeTurnId = turnId
    session.pendingRequestId = requestId
    session.activeTurnAbort = turnAbort
    session.status = 'active'
    session.updatedAt = this.now()
    // The model sees prior completed turns plus this message, so it has memory.
    const messages: ConversationMessage[] = [...session.history, { role: 'user', content: message }]
    const events = await this.emitAll(
      session,
      adapter.sendTurn({ ...session, turnId, requestId, message, messages, signal: turnAbort.signal }),
      { turnId }
    )
    const currentSession = this.sessions.get(input.sessionId)
    if (
      currentSession
      && currentSession.status !== 'stopped'
      && currentSession.activeTurnId === turnId
      && !currentSession.canceledTurnIds.has(turnId)
    ) {
      this.applyTurnState(currentSession, events, requestId)
      currentSession.activeTurnAbort = null
      // Record only a cleanly completed turn (no failure) into history, so a
      // failed turn leaves history untouched and a retry re-sends without
      // duplicating the user message.
      const completed =
        events.some((event) => event.type === 'turn_completed')
        && !events.some((event) => event.type === 'turn_failed')
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
    if (!session.activeTurnId || session.pendingRequestId !== input.requestId) {
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
      })
    )
    session.activeTurnId = null
    session.pendingRequestId = null
    session.status = input.approved ? 'ready' : 'failed'
    session.updatedAt = this.now()
    return { ok: true, session: this.toSummary(session) }
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
        this.eventForSession(session, 'turn_failed', { turnId, reason: 'interrupted', message: 'Conversation stopped.' }),
        { allowCanceledTurnId: turnId }
      )
    }
    await this.emitAll(session, adapter.stopSession(session), { allowCanceledTurnId: turnId })
    session.activeTurnId = null
    session.pendingRequestId = null
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

  private async validateStartInput(input: ConversationStartSessionInput): Promise<
    | { ok: true; adapter: ConversationProviderAdapter }
    | { ok: false; message: string }
  > {
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
    // enforce seed membership for static-only providers. A truly invalid model is
    // surfaced by the provider as a `turn_failed` model error at call time.
    const supportsDynamicModels = Boolean(registryProvider?.manifest.openaiCompatible?.modelsPath)
    if (!input.modelId.trim()) return { ok: false, message: 'Conversation model is invalid.' }
    if (!supportsDynamicModels) {
      const models = registryProvider?.manifest.models.map((model) => model.id) ?? adapter?.listModels() ?? []
      if (!models.includes(input.modelId.trim())) return { ok: false, message: 'Conversation model is invalid.' }
    }

    if (registryProvider?.manifest.auth) {
      const secretStatus = await this.secretStore.getStatus(providerId)
      if (!secretStatus.ok) return { ok: false, message: secretStatus.message }
      if (!secretStatus.status.configured) return { ok: false, message: 'Conversation provider secret is not configured.' }
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

  private async resolveSecret(providerId: string): Promise<{ ok: true; value: string } | { ok: false; message: string }> {
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
    options: { turnId?: string; allowCanceledTurnId?: string | null } = {}
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
    options: { turnId?: string; allowCanceledTurnId?: string | null } = {}
  ): Promise<ConversationEvent | null> {
    if (this.shouldSuppressEvent(session, event, options)) return null
    const stamped: ConversationEvent = {
      ...event,
      id: `conv_evt_${++this.eventSequence}`,
      createdAt: this.now(),
    }
    await this.persistEvent(session, stamped)
    for (const listener of this.listeners) listener(stamped)
    return stamped
  }

  private shouldSuppressEvent(
    session: RuntimeSession,
    event: ConversationEvent,
    options: { turnId?: string; allowCanceledTurnId?: string | null }
  ): boolean {
    const eventTurnId = event.payload && typeof event.payload.turnId === 'string'
      ? event.payload.turnId
      : options.turnId
    if (!eventTurnId) return false
    if (eventTurnId === options.allowCanceledTurnId) return false
    if (session.status === 'stopped') return true
    if (session.canceledTurnIds.has(eventTurnId)) return true
    return session.activeTurnId !== eventTurnId
  }

  private eventForSession(
    session: RuntimeSession,
    type: ConversationEvent['type'],
    payload?: Record<string, unknown>
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
    if (events.some((event) => event.type === 'approval_requested')) {
      session.pendingRequestId = requestId
      session.status = 'awaiting_approval'
    } else {
      session.pendingRequestId = null
      if (events.some((event) => event.type === 'turn_failed')) {
        session.status = 'failed'
        session.activeTurnId = null
      } else if (events.some((event) => event.type === 'turn_completed')) {
        session.status = 'ready'
        session.activeTurnId = null
      } else {
        session.status = 'active'
      }
    }
    session.updatedAt = this.now()
  }

  private async persistEvent(session: RuntimeSession, event: ConversationEvent): Promise<void> {
    const dir = join(session.workspaceRoot, '.multi-code', 'conversations', safeSegment(session.workspaceId))
    await this.mkdir(dir, { recursive: true })
    await this.appendFile(
      join(dir, `${safeSegment(session.agentId)}.jsonl`),
      `${JSON.stringify(redactEvent(event))}\n`,
      'utf-8'
    )
  }

  private toSummary(session: RuntimeSession): ConversationSessionSummary {
    const { sessionId, workspaceId, agentId, providerId, modelId, status, createdAt, updatedAt } = session
    return { sessionId, workspaceId, agentId, providerId, modelId, status, createdAt, updatedAt }
  }
}

function safeSegment(value: string): string {
  return encodeURIComponent(value.trim().replace(/[\\/]/g, '-'))
}

function isAsyncIterable(value: ConversationEvent[] | AsyncIterable<ConversationEvent>): value is AsyncIterable<ConversationEvent> {
  return typeof (value as AsyncIterable<ConversationEvent>)[Symbol.asyncIterator] === 'function'
}

function redactEvent(event: ConversationEvent): ConversationEvent {
  return JSON.parse(JSON.stringify(event, (key, value) => {
    if (key === 'inputTokens' || key === 'outputTokens' || key === 'totalTokens') {
      return value
    }
    if (typeof key === 'string' && /secret|token|api[-_]?key|authorization/i.test(key)) {
      return '[redacted]'
    }
    return value
  })) as ConversationEvent
}
