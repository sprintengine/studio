import { StudioError } from './errors.js'
import type {
  ConversationCreateRequest,
  ConversationPlanDecision,
  ConversationQuestion,
  ConversationQuestionAnswers,
  ConversationRequestDecision,
  ConversationWireEvent,
  ConversationWirePage,
  ConversationWirePermissionPreset,
  ConversationWirePhase,
  StudioCreatedConversation,
  StudioCursor,
} from './protocol.js'

// The conversation API, in two layers.
//
// `ConversationService` is the module SDK's conversation service, name for
// name and result for result: a ref `{ workspaceId, agentId }`, an optional
// `commandId` on every mutation, and `{ ok: true, … } | { ok: false, code,
// message }` answers. Code written against `getConversationService(host)` in a
// module runs against a Studio client by swapping the service object.
//
// `Conversation` is the handle on top of it, for scripts: one chat's methods,
// which throw a `StudioError` instead of answering `ok: false`, and its
// events as an async iterator that resumes across reconnects.

/**
 * How a conversation is addressed. `workspaceRoot` names the folder it is kept
 * in when that is not its workspace's (a chat started in a run worktree); only
 * a Studio's own connections may name one, where it serves the
 * `conversation-folders` capability.
 */
export type ConversationRef = { workspaceId: string; agentId: string; workspaceRoot?: string }

/**
 * The client's own id for a mutation. A retry with the same id is answered
 * with the first attempt's result and never carried out twice, across a
 * reconnect and a restart of the app. Without one, the client mints one per
 * call and reuses it for that call's retries.
 */
export type CommandOptions = { commandId?: string }

/** `errorId` is the id Studio logged the real cause under, when it answered in stable words. */
export type ConversationResult<T = object> =
  ({ ok: true } & T) | { ok: false; code: string; message: string; errorId?: string }

/** What `follow` and `events` deliver: the conversation lane's stream frames, snapshot parts already joined. */
export type ConversationFollowFrame =
  | { type: 'snapshot'; page: ConversationWirePage; reset?: true; generation?: string }
  | { type: 'event'; event: ConversationWireEvent }
  | { type: 'synchronized'; seq: number; generation?: string }

/**
 * Where a `follow` starts, as the module SDK takes it. `resubscribe: false`
 * ends the stream with an `error` frame when Studio could not start or keep it,
 * instead of subscribing again by itself, for a consumer that retries on its own.
 */
export type ConversationFollowOptions = {
  afterSeq?: number
  generation?: string
  turnLimit?: number
  resubscribe?: boolean
}

export type CreateConversationInput = ConversationCreateRequest & CommandOptions

/** A listed conversation, as both a Studio and a module host can list one. */
export type ConversationListing = {
  workspaceId: string
  agentId: string
  title: string
  providerId: string
  modelId: string
  sessionId?: string | null
  phase?: ConversationWirePhase
  permissionPreset?: ConversationWirePermissionPreset
  permissionMode?: string
}

export type ConversationService = {
  create(input: CreateConversationInput): Promise<ConversationResult<{ conversation: StudioCreatedConversation }>>
  /** Answered when the turn ends, as a send is everywhere else. */
  send(
    ref: ConversationRef,
    input: { message: string } & CommandOptions,
  ): Promise<ConversationResult<{ notice?: string }>>
  interrupt(ref: ConversationRef, options?: CommandOptions): Promise<ConversationResult>
  /** Answer a tool request with `decision`, or the older `approved` (true is `once`, false is `deny`). */
  respondToApproval(
    ref: ConversationRef,
    input: { requestId: string; decision?: ConversationRequestDecision; approved?: boolean } & CommandOptions,
  ): Promise<ConversationResult>
  answerQuestion(
    ref: ConversationRef,
    input: { requestId: string; answers: ConversationQuestionAnswers } & CommandOptions,
  ): Promise<ConversationResult>
  resolvePlan(
    ref: ConversationRef,
    input: { requestId: string; decision: ConversationPlanDecision } & CommandOptions,
  ): Promise<ConversationResult>
  setPermissionPreset(
    ref: ConversationRef,
    preset: ConversationWirePermissionPreset,
    options?: CommandOptions & { permissionMode?: string },
  ): Promise<
    ConversationResult<{ permissionPreset: ConversationWirePermissionPreset; permissionMode?: string; notice?: string }>
  >
  setModel(
    ref: ConversationRef,
    modelId: string,
    options?: CommandOptions,
  ): Promise<ConversationResult<{ modelId: string; notice?: string }>>
  stop(ref: ConversationRef, options?: CommandOptions): Promise<ConversationResult>
  /** Callback form of `events`, as the module SDK has it. An `error` frame ends the stream. Returns the unsubscriber. */
  follow(
    ref: ConversationRef,
    options: ConversationFollowOptions | undefined,
    onFrame: (frame: ConversationFollowFrame | { type: 'error'; message: string }) => void,
  ): () => void
  events(ref: ConversationRef, options?: EventStreamOptions): ConversationEventStream
  list(): Promise<ConversationListing[]>
}

export type EventStreamOptions = {
  /** Resume after this cursor: only the events after it, then the fence. */
  cursor?: StudioCursor
  /** How many turns a snapshot holds when one is needed. */
  turnLimit?: number
  signal?: AbortSignal
  /**
   * When Studio could not start the stream or keep it going but says trying
   * again may work, subscribe again after the delay it names (the default), or
   * `false` to end the stream with that error and leave the retry to you.
   * Reconnecting after a dropped connection is not a failure: it always resumes.
   */
  resubscribe?: boolean
}

/**
 * One conversation's frames, in order: a `snapshot` (or, resuming from a
 * cursor the log can vouch for, only the events after it), a `synchronized`
 * fence, then live `event`s. Across a reconnect it resumes from `cursor` by
 * itself: no event is skipped and none repeats. A snapshot with `reset` — one
 * whose cursor could not be vouched for, or any after the stream's first —
 * replaces what you held.
 */
export type ConversationEventStream = AsyncIterableIterator<ConversationFollowFrame> & {
  /**
   * The last sequence this stream has handed you, and its log's generation;
   * null until the first fence has been read. It never runs ahead of what you
   * have taken from the stream, so persisting it after applying a frame never
   * skips one that was received but not yet read.
   */
  readonly cursor: StudioCursor | null
  close(): void
}

/** What an `approval_requested` event asks, read from its payload. */
export type ApprovalRequest =
  | { kind: 'tool'; requestId: string; action?: string; summary?: string }
  | { kind: 'question'; requestId: string; questions: ConversationQuestion[] }
  | { kind: 'plan'; requestId: string; plan: string }

/** The request an event asks the client to answer, or null when it asks nothing. */
export function approvalRequestOf(event: ConversationWireEvent): ApprovalRequest | null {
  if (event.type !== 'approval_requested' || !event.payload) return null
  const payload = event.payload
  if (typeof payload.requestId !== 'string') return null
  if (payload.kind === 'question')
    return {
      kind: 'question',
      requestId: payload.requestId,
      questions: Array.isArray(payload.questions) ? (payload.questions as ConversationQuestion[]) : [],
    }
  if (payload.kind === 'plan')
    return { kind: 'plan', requestId: payload.requestId, plan: typeof payload.plan === 'string' ? payload.plan : '' }
  return {
    kind: 'tool',
    requestId: payload.requestId,
    ...(typeof payload.action === 'string' ? { action: payload.action } : {}),
    ...(typeof payload.summary === 'string' ? { summary: payload.summary } : {}),
  }
}

/** One chat, for scripts. Each method throws a `StudioError` where the service would answer `ok: false`. */
export type Conversation = {
  readonly ref: ConversationRef
  send(message: string, options?: CommandOptions): Promise<{ notice?: string }>
  interrupt(options?: CommandOptions): Promise<void>
  respondToApproval(
    input: { requestId: string; decision: ConversationRequestDecision },
    options?: CommandOptions,
  ): Promise<void>
  answerQuestion(
    input: { requestId: string; answers: ConversationQuestionAnswers },
    options?: CommandOptions,
  ): Promise<void>
  resolvePlan(input: { requestId: string; decision: ConversationPlanDecision }, options?: CommandOptions): Promise<void>
  /**
   * Switch the chat's preset, and the CLI's own mode at it. A preset above
   * the client's ceiling is lowered to it; the answer names what is in force.
   * The tools a chat may use unasked are chosen when it is created
   * (`allowedTools`), because the agent's session is started with them.
   */
  setPermissions(
    input: { preset: ConversationWirePermissionPreset; mode?: string },
    options?: CommandOptions,
  ): Promise<{ permissionPreset: ConversationWirePermissionPreset; permissionMode?: string; notice?: string }>
  setModel(modelId: string, options?: CommandOptions): Promise<{ modelId: string; notice?: string }>
  stop(options?: CommandOptions): Promise<void>
  events(options?: EventStreamOptions): ConversationEventStream
}

/** The handle-level API every way of reaching conversations offers. */
export type AgentConversations = {
  list(): Promise<ConversationListing[]>
  createConversation(input: CreateConversationInput): Promise<Conversation & { info: StudioCreatedConversation }>
  conversation(ref: ConversationRef): Conversation
}

function settled<T>(result: ConversationResult<T>): T {
  if (!result.ok) throw new StudioError(result.code, result.message)
  const { ok: _ok, ...rest } = result as { ok: true } & T
  return rest as T
}

/** The handle for one conversation over any `ConversationService`. */
export function conversationHandle(service: ConversationService, ref: ConversationRef): Conversation {
  const target = { workspaceId: ref.workspaceId, agentId: ref.agentId }
  return {
    ref: target,
    send: async (message, options) => settled(await service.send(target, { message, ...options })),
    interrupt: async (options) => void settled(await service.interrupt(target, options)),
    respondToApproval: async (input, options) =>
      void settled(await service.respondToApproval(target, { ...input, ...options })),
    answerQuestion: async (input, options) =>
      void settled(await service.answerQuestion(target, { ...input, ...options })),
    resolvePlan: async (input, options) => void settled(await service.resolvePlan(target, { ...input, ...options })),
    setPermissions: async (input, options) =>
      settled(
        await service.setPermissionPreset(target, input.preset, {
          ...options,
          ...(input.mode === undefined ? {} : { permissionMode: input.mode }),
        }),
      ),
    setModel: async (modelId, options) => settled(await service.setModel(target, modelId, options)),
    stop: async (options) => void settled(await service.stop(target, options)),
    events: (options) => service.events(target, options),
  }
}

/** The handle-level API over any `ConversationService`. */
export function agentConversations(service: ConversationService): AgentConversations {
  return {
    list: () => service.list(),
    async createConversation(input) {
      const { conversation } = settled(await service.create(input))
      return { ...conversationHandle(service, conversation), info: conversation }
    },
    conversation: (ref) => conversationHandle(service, ref),
  }
}

/**
 * A queue an event stream reads from: frames pushed by whatever follows the
 * conversation, pulled by the consumer's `for await`. `onDepth` hears how
 * many frames wait, so a producer can stop reading while a consumer lags.
 * Frames already received are delivered before an end or a failure.
 */
export function createFrameQueue(hooks: { onClose: () => void; onDepth?: (depth: number) => void }): {
  stream: ConversationEventStream
  /** Queue a frame, with the cursor that holds once the consumer has taken it (null: none yet; absent: unchanged). */
  push(frame: ConversationFollowFrame, cursor?: StudioCursor | null): void
  fail(error: Error): void
  end(): void
} {
  const queue: Array<{ frame: ConversationFollowFrame; cursor?: StudioCursor | null }> = []
  // Moved only as the consumer takes frames: the cursor it has applied.
  let applied: StudioCursor | null = null
  const take = (entry: { frame: ConversationFollowFrame; cursor?: StudioCursor | null }) => {
    if (entry.cursor !== undefined) applied = entry.cursor
    return entry.frame
  }
  const waiters: Array<{
    resolve: (result: IteratorResult<ConversationFollowFrame>) => void
    reject: (error: Error) => void
  }> = []
  // The consumer stopped reading.
  let closed = false
  // The producer is done: after the queue drains, the stream ends this way,
  // and the end (an error, or done) is delivered exactly once.
  let ending: { error: Error | null; delivered: boolean } | null = null
  const deliverEnd = (): Promise<IteratorResult<ConversationFollowFrame>> => {
    const error = ending && !ending.delivered ? ending.error : null
    if (ending) ending.delivered = true
    return error ? Promise.reject(error) : Promise.resolve({ value: undefined, done: true })
  }
  const stop = (error: Error | null) => {
    if (closed || ending) return
    ending = { error, delivered: false }
    if (queue.length > 0) return
    // Only a reader already waiting can be waiting on an empty queue.
    for (const [index, waiter] of waiters.splice(0).entries()) {
      if (index === 0 && error) {
        ending.delivered = true
        waiter.reject(error)
      } else waiter.resolve({ value: undefined, done: true })
    }
  }
  const stream: ConversationEventStream = {
    get cursor() {
      return applied
    },
    next() {
      const entry = queue.shift()
      if (entry) {
        hooks.onDepth?.(queue.length)
        return Promise.resolve({ value: take(entry), done: false })
      }
      if (closed || ending) return deliverEnd()
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
    },
    return() {
      if (!closed) {
        closed = true
        queue.length = 0
        hooks.onClose()
        for (const waiter of waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
      }
      if (ending) ending.delivered = true
      return Promise.resolve({ value: undefined, done: true })
    },
    close() {
      void stream.return!()
    },
    [Symbol.asyncIterator]() {
      return stream
    },
  }
  return {
    stream,
    push(frame, cursor) {
      if (closed || ending) return
      const entry = cursor === undefined ? { frame } : { frame, cursor }
      const waiter = waiters.shift()
      if (waiter) waiter.resolve({ value: take(entry), done: false })
      else {
        queue.push(entry)
        hooks.onDepth?.(queue.length)
      }
    },
    fail: (error) => stop(error),
    end: () => stop(null),
  }
}
