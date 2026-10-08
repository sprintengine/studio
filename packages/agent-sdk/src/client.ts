import {
  agentConversations,
  createFrameQueue,
  type AgentConversations,
  type CommandOptions,
  type ConversationFollowFrame,
  type ConversationRef,
  type ConversationResult,
  type ConversationService,
  type EventStreamOptions,
} from './conversations.js'
import { StudioError, isTerminalStudioCode } from './errors.js'
import {
  STUDIO_METHODS,
  STUDIO_PROTOCOL_MIN_SUPPORTED,
  STUDIO_PROTOCOL_VERSION,
  checkStudioProtocolVersion,
  createStudioChunkAssembler,
  isKnownStudioServerFrameType,
  parseStudioServerFrame,
  studioPeerSupports,
  type ConversationParsedServerFrame,
  type ConversationThread,
  type ConversationWireEvent,
  type StudioAuth,
  type StudioCapability,
  type StudioClientKind,
  type StudioCursor,
  type StudioGrant,
  type StudioMethod,
  type StudioMethodParams,
  type StudioMethodResult,
  type StudioParsedServerFrame,
  type StudioTopic,
  type StudioWelcomeFrame,
} from './protocol.js'
import type { StudioTransport, StudioTransportFactory } from './transport.js'
import { createClientTools, type StudioClientTools } from './tools.js'

// The Studio client: one connection, every request and stream multiplexed on
// it, and the connection kept.
//
// What it does so a caller does not have to:
//
// - Reconnects after any drop that reconnecting can fix, with exponential
//   backoff and jitter, never sooner than a `retryAfterMs` Studio asked for.
//   It stops for good on a refusal that a new connection would only repeat
//   (an unknown or revoked credential, a version outside the window).
// - Resumes every open stream from its cursor on the new connection, so a
//   consumer sees no gap and no repeat; a cursor Studio cannot vouch for comes
//   back as a reset snapshot.
// - Sends again every request still unanswered when a connection dropped.
//   Every mutation carries a command id (minted here when the caller gave
//   none), so a resend is answered from Studio's receipt, never carried out
//   twice. A `busy` answer is retried after the delay it names.
// - Holds a pairing code's token: the first welcome carries it once, and it is
//   handed to `onToken` to keep and used for every reconnect.
// - Stops reading when a stream's consumer falls far behind, so Studio sees
//   the backpressure and merges what it can, instead of the client buffering
//   without bound.
//
// Nothing here imports Node: the client runs in a browser as well, given a
// transport.

/**
 * `parked`: not connected, and not trying, until woken. A credential Studio
 * refused (`unauthorized`, `revoked`) parks the client, since another try
 * would only be refused again, and so does being offline. A wake is `wake()`,
 * or in a browser the page coming back online or to the foreground.
 */
export type StudioClientState = 'open' | 'reconnecting' | 'parked' | 'closed'

export type ConnectOptions = {
  transport: StudioTransportFactory
  /**
   * Who this client is, for the audit and Settings. Never authority. `kind` is
   * read only from an owner's grant (a desktop, a web client, a headless
   * runner); an app is an app whatever it says.
   */
  client: { name: string; version?: string; kind?: StudioClientKind }
  /**
   * A token from an earlier pairing, or a one-time pairing code from Studio's
   * Settings. Optional only for a transport that brings a credential of its
   * own for each connection (`StudioTransport.credential`).
   */
  auth?: StudioAuth
  /** Called once with the token a pairing code was exchanged for. Keep it: the code will not work again. */
  onToken?: (token: string) => void | Promise<void>
  /** `false` to fail on the first drop instead of reconnecting. */
  reconnect?: false | { initialDelayMs?: number; maxDelayMs?: number; maxAttempts?: number }
  onStateChange?: (state: StudioClientState, error?: StudioError) => void
  /** How long to wait for the welcome. */
  helloTimeoutMs?: number
  /** Mints the command id for a mutation the caller gave none. */
  newCommandId?: () => string
  /**
   * The Studio this client follows, by `welcome.environment.id`. Absent, it is
   * the one the first connection reaches. A connection that reaches any other
   * (a server restarted on another data directory, another Studio on a reused
   * address) is refused: this client's cursors and command ids mean nothing
   * there, so it closes with `environment_changed` rather than resume or
   * resend against it.
   */
  environmentId?: string
  /**
   * After `intervalMs` with nothing heard from Studio, ask it for a ping; if
   * nothing is heard within `timeoutMs` more, the connection is dropped and
   * made again. A socket a sleeping machine left half-open never closes by
   * itself; this is how it is found. `false` turns it off.
   */
  heartbeat?: false | { intervalMs?: number; timeoutMs?: number }
  /**
   * How long a read may go unanswered before it is refused `timeout`, waiting
   * through a reconnect included. A mutation waits for its answer however long
   * it takes: a send is answered when its turn ends.
   */
  readTimeoutMs?: number
  /**
   * Wake a parked client, or cut a reconnect's wait short, when the page comes
   * back online or to the foreground. Default on wherever those events exist.
   */
  wakeups?: boolean
  /**
   * `false` for a Studio on this machine (a desktop window's own server): the
   * device being offline says nothing about reaching it, so the client keeps
   * reconnecting rather than park until the network is back. Default on.
   */
  parkWhenOffline?: boolean
}

/** The ref-level conversation service, plus the reads only a Studio serves. */
export type StudioConversationService = ConversationService & {
  list(): Promise<ConversationThread[]>
  loadEarlier(
    ref: ConversationRef,
    beforeCursor: number,
    turnLimit?: number,
  ): Promise<ConversationResult<StudioMethodResult<'conversation.loadEarlier'>>>
  toolDetail(
    ref: ConversationRef,
    toolUseId: string,
  ): Promise<ConversationResult<StudioMethodResult<'conversation.toolDetail'>>>
  turnDiff(
    ref: ConversationRef,
    turnSeq: number,
    path?: string,
  ): Promise<ConversationResult<StudioMethodResult<'conversation.turnDiff'>>>
}

/** What a push stream hears: each payload as it comes, and why it ended if it did. */
export type StudioPushListener = {
  onPayload(payload: unknown): void
  /** The stream ended for good: refused, or the client closed. A drop it can resume from is not an end. */
  onEnd?(error?: StudioError): void
}

export type StudioClient = AgentConversations & {
  /** The ref-level service, shaped as the module SDK's conversation service. */
  readonly conversations: StudioConversationService
  /** The latest welcome: who this Studio is, what it serves, what this client may do. */
  readonly welcome: StudioWelcomeFrame
  readonly grant: StudioGrant
  readonly state: StudioClientState
  /** Whether this Studio serves a capability. Ask this, never the version. */
  supports(capability: StudioCapability): boolean
  /** One request, answered or thrown as a `StudioError`. */
  request<M extends StudioMethod>(method: M, params: StudioMethodParams<M>): Promise<StudioMethodResult<M>>
  /** Give Studio's agents tools that run here (`supports('client-tools')`). */
  readonly tools: StudioClientTools
  /**
   * Follow a push topic (`STUDIO_TOPICS[topic].push`): every payload as it is
   * sent, subscribed again on each new connection. Nothing is replayed, so
   * ask for the current state after subscribing. Returns the unsubscriber.
   */
  subscribe(topic: StudioTopic, params: unknown, listener: StudioPushListener): () => void
  /** Connect now: after being parked, or to cut a reconnect's wait short. Nothing while open or closed. */
  wake(): void
  close(): void
  /** Settles when the client has closed for good; rejects with why, if it was not asked to. */
  readonly closed: Promise<void>
}

const DEFAULT_HELLO_TIMEOUT_MS = 15_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000
const DEFAULT_READ_TIMEOUT_MS = 60_000
// Refusals of the credential: trying again would be refused again, so the
// client waits to be woken instead of backing off for ever.
const PARKING_CODES: ReadonlySet<string> = new Set(['unauthorized', 'revoked'])
const BUSY_RETRIES = 5
// A stream whose consumer has this many frames waiting stops the connection
// reading until it is down to the lower mark.
const PAUSE_DEPTH = 2_000
const RESUME_DEPTH = 500

type Pending = {
  id: string
  method: StudioMethod
  params: unknown
  busyRetries: number
  /** The resend a `busy` answer scheduled; cleared when the request is sent again by a reconnect, or ends. */
  busyRetry: ReturnType<typeof setTimeout> | null
  resolve: (result: unknown) => void
  reject: (error: StudioError) => void
  timeout: ReturnType<typeof setTimeout> | null
}

/** A request's timers, stopped: it has ended, or is about to be sent again. */
function stopTimers(pending: Pending): void {
  if (pending.timeout) clearTimeout(pending.timeout)
  if (pending.busyRetry) clearTimeout(pending.busyRetry)
  pending.timeout = null
  pending.busyRetry = null
}

/** A timer that does not keep a Node process alive by itself. */
function quietly<T extends ReturnType<typeof setTimeout>>(timer: T): T {
  ;(timer as { unref?: () => void }).unref?.()
  return timer
}

type Push = {
  id: string
  topic: StudioTopic
  params: unknown
  listener: StudioPushListener
  retry: ReturnType<typeof setTimeout> | null
}

type Stream = {
  id: string
  ref: ConversationRef
  turnLimit?: number
  cursor: StudioCursor | null
  /** Snapshot parts received so far. */
  parts: ConversationWireEvent[] | null
  queue: ReturnType<typeof createFrameQueue>
  /** Whether a snapshot has been delivered: any later one replaces it, and says so. */
  snapshotted: boolean
  /** Subscribe again after a retryable failure, rather than ending with it. */
  resubscribe: boolean
  depth: number
  retry: ReturnType<typeof setTimeout> | null
}

function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (crypto?.randomUUID) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

/** Connect to a Studio and say hello. Rejects when the first connection cannot be made or is refused. */
export async function connect(options: ConnectOptions): Promise<StudioClient> {
  const newCommandId = options.newCommandId ?? randomId
  const reconnect = options.reconnect === false ? null : (options.reconnect ?? {})
  const initialDelayMs = reconnect?.initialDelayMs ?? 250
  const maxDelayMs = reconnect?.maxDelayMs ?? 30_000
  const maxAttempts = reconnect?.maxAttempts ?? Number.POSITIVE_INFINITY
  const heartbeat =
    options.heartbeat === false
      ? null
      : {
          intervalMs: options.heartbeat?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
          timeoutMs: options.heartbeat?.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
        }
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS

  let auth: StudioAuth | undefined = options.auth
  // This process run, the same across its reconnects: Studio sends a call it
  // was running back to the same process after a drop, and to no other.
  const instanceId = `sdk-${randomId()}`
  // The Studio this client is bound to; its streams' cursors and its command
  // ids are that Studio's.
  let environmentId: string | null = options.environmentId ?? null
  let transport: StudioTransport | null = null
  let welcome: StudioWelcomeFrame | null = null
  let state: StudioClientState | 'connecting' = 'connecting'
  let sequence = 0
  let attempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let lastBye: { code: string; message: string; retryAfterMs?: number } | null = null
  let paused = false
  // When anything was last heard on the open connection, and the timer that
  // asks for a ping after a quiet spell.
  let lastHeard = 0
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  const requests = new Map<string, Pending>()
  const streams = new Map<string, Stream>()
  const pushes = new Map<string, Push>()
  let resolveClosed!: () => void
  let rejectClosed!: (error: StudioError) => void
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve
    rejectClosed = reject
  })
  // A rejection nobody awaits is not an unhandled one: `closed` is optional to read.
  closed.catch(() => undefined)

  const setState = (next: StudioClientState, error?: StudioError) => {
    if (state === next) return
    state = next
    options.onStateChange?.(next, error)
  }
  const send = (frame: unknown) => transport?.send(JSON.stringify(frame))

  // The toolsets this client offers and the calls Studio sends it.
  const tools = createClientTools({
    request: (method, params) => request(method, params as never),
    send: (frame) => {
      if (state !== 'open' || !transport) return false
      send(frame)
      return true
    },
    supports: (capability) => studioPeerSupports(welcome?.capabilities, capability),
    isOpen: () => state === 'open' && transport !== null,
  })

  // ── Flow control ──────────────────────────────────────────────────────────

  function adjustReading(): void {
    const lagging = [...streams.values()].some((stream) => stream.depth >= (paused ? RESUME_DEPTH : PAUSE_DEPTH))
    if (lagging === paused) return
    paused = lagging
    if (paused) transport?.pause?.()
    else transport?.resume?.()
  }

  // ── Streams ───────────────────────────────────────────────────────────────

  function subscribe(stream: Stream): void {
    if (state !== 'open') return
    send({
      t: 'sub',
      id: stream.id,
      topic: 'conversation.session',
      params: { key: stream.ref, ...(stream.turnLimit === undefined ? {} : { turnLimit: stream.turnLimit }) },
      ...(stream.cursor ? { cursor: stream.cursor } : {}),
    })
  }

  function subscribePush(push: Push): void {
    if (state !== 'open') return
    send({ t: 'sub', id: push.id, topic: push.topic, params: push.params })
  }

  function endPush(push: Push, error?: StudioError): void {
    if (push.retry) clearTimeout(push.retry)
    if (!pushes.delete(push.id)) return
    push.listener.onEnd?.(error)
  }

  function accept(stream: Stream, frame: ConversationParsedServerFrame): void {
    if (frame.type === 'snapshot') {
      // A snapshot in parts is applied once, whole, when its last part arrives.
      const events = [...(stream.parts ?? []), ...frame.page.events]
      if (frame.part && frame.part.index < frame.part.total - 1) {
        stream.parts = events
        return
      }
      stream.parts = null
      const delivered: ConversationFollowFrame = {
        type: 'snapshot',
        page: { ...frame.page, events },
        ...(frame.reset || stream.snapshotted ? { reset: true as const } : {}),
        ...(frame.generation === undefined ? {} : { generation: frame.generation }),
      }
      stream.snapshotted = true
      // A snapshot replaces what came before: the cursor is the fence's now.
      stream.cursor = null
      stream.queue.push(delivered, null)
      return
    }
    if (frame.type === 'event') {
      const seq = frame.event.seq
      // Never twice: what the cursor already covers was delivered.
      if (seq !== undefined && stream.cursor && seq <= stream.cursor.afterSeq) return
      if (seq !== undefined && stream.cursor) stream.cursor = { ...stream.cursor, afterSeq: seq }
      // What resumes the stream is what was received; what its consumer reads
      // as `cursor` moves only as it takes each frame.
      stream.queue.push({ type: 'event', event: frame.event }, stream.cursor ? { ...stream.cursor } : undefined)
      return
    }
    if (frame.type === 'synchronized') {
      if (frame.generation) stream.cursor = { afterSeq: frame.seq, generation: frame.generation }
      stream.queue.push(
        {
          type: 'synchronized',
          seq: frame.seq,
          ...(frame.generation === undefined ? {} : { generation: frame.generation }),
        },
        stream.cursor ? { ...stream.cursor } : undefined,
      )
    }
  }

  function openStream(ref: ConversationRef, streamOptions: EventStreamOptions = {}) {
    const id = `s${++sequence}`
    const stream: Stream = {
      id,
      ref: {
        workspaceId: ref.workspaceId,
        agentId: ref.agentId,
        ...(ref.workspaceRoot === undefined ? {} : { workspaceRoot: ref.workspaceRoot }),
      },
      ...(streamOptions.turnLimit === undefined ? {} : { turnLimit: streamOptions.turnLimit }),
      cursor: streamOptions.cursor ?? null,
      parts: null,
      snapshotted: false,
      resubscribe: streamOptions.resubscribe !== false,
      depth: 0,
      retry: null,
      queue: createFrameQueue({
        onDepth: (depth) => {
          stream.depth = depth
          adjustReading()
        },
        onClose: () => {
          if (stream.retry) clearTimeout(stream.retry)
          if (streams.delete(id) && state === 'open') send({ t: 'unsub', id })
          stream.depth = 0
          adjustReading()
        },
      }),
    }
    if (state === 'closed') {
      stream.queue.fail(new StudioError('closed', 'The client is closed.'))
      return stream.queue
    }
    streams.set(id, stream)
    streamOptions.signal?.addEventListener('abort', () => stream.queue.stream.close(), { once: true })
    subscribe(stream)
    return stream.queue
  }

  // ── Requests ──────────────────────────────────────────────────────────────

  function request<M extends StudioMethod>(method: M, params: StudioMethodParams<M>): Promise<StudioMethodResult<M>> {
    if (state === 'closed') return Promise.reject(new StudioError('closed', 'The client is closed.'))
    // Parked by a refused credential, a request would only be refused too;
    // parked offline, it waits to go out once the network is back.
    if (state === 'parked' && parkedBy && parkedBy.code !== 'offline')
      return Promise.reject(new StudioError(parkedBy.code, parkedBy.message, undefined, parkedBy.errorId))
    return new Promise((resolve, reject) => {
      const id = `r${++sequence}`
      const pending: Pending = {
        id,
        method,
        params,
        busyRetries: 0,
        busyRetry: null,
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout: null,
      }
      // A read is answered or refused in bounded time, a reconnect included.
      if (readTimeoutMs > 0 && STUDIO_METHODS[method]?.mutation === false)
        pending.timeout = quietly(
          setTimeout(() => {
            if (requests.get(id) !== pending) return
            requests.delete(id)
            stopTimers(pending)
            reject(new StudioError('timeout', 'Studio did not answer in time.'))
          }, readTimeoutMs),
        )
      requests.set(id, pending)
      // Unsent while reconnecting: every pending request goes out on the next connection.
      if (state === 'open') send({ t: 'req', id, method, params })
    })
  }

  function settle(pending: Pending): void {
    stopTimers(pending)
    requests.delete(pending.id)
  }

  function answer(frame: Extract<StudioParsedServerFrame, { t: 'res' }>): void {
    const pending = requests.get(frame.id)
    if (!pending) return
    if (!frame.ok && frame.error.code === 'busy' && pending.busyRetries < BUSY_RETRIES) {
      pending.busyRetries++
      if (pending.busyRetry) clearTimeout(pending.busyRetry)
      pending.busyRetry = quietly(
        setTimeout(() => {
          pending.busyRetry = null
          if (requests.get(pending.id) === pending && state === 'open')
            send({ t: 'req', id: pending.id, method: pending.method, params: pending.params })
        }, frame.error.retryAfterMs ?? 250),
      )
      return
    }
    settle(pending)
    if (frame.ok) pending.resolve(frame.result)
    else
      pending.reject(
        new StudioError(frame.error.code, frame.error.message, frame.error.retryAfterMs, frame.error.errorId),
      )
  }

  // ── The connection ────────────────────────────────────────────────────────

  // ── Liveness ──────────────────────────────────────────────────────────────

  function stopHeartbeat(): void {
    if (heartbeatTimer) clearTimeout(heartbeatTimer)
    heartbeatTimer = null
  }

  /** After a quiet spell, a ping; after more quiet, the connection is given up and made again. */
  function startHeartbeat(): void {
    stopHeartbeat()
    if (!heartbeat) return
    const watched = transport
    const check = () => {
      heartbeatTimer = null
      if (state !== 'open' || transport !== watched) return
      // Reading paused for a consumer that is behind hears nothing, however
      // well the line works: quiet then says nothing about the connection.
      if (paused) lastHeard = Date.now()
      const quiet = Date.now() - lastHeard
      if (quiet < heartbeat.intervalMs) {
        heartbeatTimer = quietly(setTimeout(check, heartbeat.intervalMs - quiet))
        return
      }
      const asked = Date.now()
      // Any frame is an answer: an older Studio refusing the method proves the line too.
      send({ t: 'req', id: `ping${++sequence}`, method: 'server.ping', params: {} })
      heartbeatTimer = quietly(
        setTimeout(() => {
          heartbeatTimer = null
          if (state !== 'open' || transport !== watched) return
          if (lastHeard >= asked || paused) check()
          else watched?.close()
        }, heartbeat.timeoutMs),
      )
    }
    heartbeatTimer = quietly(setTimeout(check, heartbeat.intervalMs))
  }

  // ── Parking ───────────────────────────────────────────────────────────────

  let parkedBy: StudioError | null = null

  /**
   * Stop trying until woken. A refused credential also ends what was waiting
   * on it: requests and streams are told why, since a wake may never come.
   * Offline keeps them, to go out once the network is back.
   */
  function park(error: StudioError): void {
    if (state === 'closed') return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    stopHeartbeat()
    parkedBy = error
    if (error.code !== 'offline') {
      for (const pending of requests.values()) {
        stopTimers(pending)
        pending.reject(error)
      }
      requests.clear()
      for (const stream of streams.values()) {
        if (stream.retry) clearTimeout(stream.retry)
        stream.queue.fail(error)
      }
      streams.clear()
      for (const push of [...pushes.values()]) endPush(push, error)
    }
    setState('parked', error)
  }

  const offline = () =>
    options.parkWhenOffline !== false &&
    (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine === false

  function attempt(): void {
    reconnectTimer = null
    establish().catch((error: unknown) => {
      const failure =
        error instanceof StudioError
          ? error
          : new StudioError('disconnected', error instanceof Error ? error.message : String(error))
      if (PARKING_CODES.has(failure.code)) park(failure)
      else if (isTerminalStudioCode(failure.code, failure.retryAfterMs)) fail(failure)
      else schedule(failure.retryAfterMs)
    })
  }

  function wake(): void {
    if (state === 'parked') {
      parkedBy = null
      attempts = 0
      setState('reconnecting')
      attempt()
      return
    }
    // A wait out of a backoff, not out of a delay Studio asked for.
    if (state === 'reconnecting' && reconnectTimer && !lastBye?.retryAfterMs) {
      clearTimeout(reconnectTimer)
      attempt()
    }
  }

  const wakeups: Array<() => void> = []
  if (options.wakeups !== false) {
    const scope = globalThis as {
      addEventListener?: (type: string, listener: () => void) => void
      removeEventListener?: (type: string, listener: () => void) => void
      document?: {
        visibilityState?: string
        addEventListener?: (type: string, listener: () => void) => void
        removeEventListener?: (type: string, listener: () => void) => void
      }
    }
    const online = () => wake()
    const visible = () => {
      if (scope.document?.visibilityState === 'visible') wake()
    }
    if (typeof scope.addEventListener === 'function') {
      scope.addEventListener('online', online)
      wakeups.push(() => scope.removeEventListener?.('online', online))
    }
    if (typeof scope.document?.addEventListener === 'function') {
      scope.document.addEventListener('visibilitychange', visible)
      wakeups.push(() => scope.document?.removeEventListener?.('visibilitychange', visible))
    }
  }
  const unwatch = () => {
    for (const stop of wakeups.splice(0)) stop()
  }

  function fail(error: StudioError): void {
    if (state === 'closed') return
    setState('closed', error)
    tools.close()
    unwatch()
    stopHeartbeat()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    for (const pending of requests.values()) {
      stopTimers(pending)
      pending.reject(error)
    }
    requests.clear()
    for (const stream of streams.values()) {
      if (stream.retry) clearTimeout(stream.retry)
      stream.queue.fail(error)
    }
    streams.clear()
    for (const push of [...pushes.values()]) endPush(push, error)
    transport?.close()
    transport = null
    rejectClosed(error)
  }

  async function open(): Promise<{ welcomed: StudioWelcomeFrame; opened: StudioTransport }> {
    lastBye = null
    paused = false
    const next = await options.transport()
    // Checked before anything waits on a hello that will never be sent.
    const credential = next.credential ?? auth
    if (!credential) {
      next.close()
      throw new StudioError('unauthorized', 'No credential: pass `auth`, or a transport that brings its own.')
    }
    const assembler = createStudioChunkAssembler()
    let greeted: ((welcome: StudioWelcomeFrame) => void) | null = null
    let refused: ((error: StudioError) => void) | null = null
    const greeting = new Promise<StudioWelcomeFrame>((resolve, reject) => {
      greeted = resolve
      refused = reject
    })
    const timer = setTimeout(
      () => refused?.(new StudioError('hello_timeout', 'Studio did not answer the hello in time.')),
      options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS,
    )
    const route = (frame: StudioParsedServerFrame): void => {
      switch (frame.t) {
        case 'chunk': {
          const step = assembler.push(frame)
          if (step.kind === 'error') next.close()
          else if (step.kind === 'frame') receive(step.json)
          return
        }
        case 'welcome':
          greeted?.(frame)
          return
        case 'bye':
          lastBye = {
            code: frame.code,
            message: frame.message,
            ...(frame.retryAfterMs === undefined ? {} : { retryAfterMs: frame.retryAfterMs }),
          }
          refused?.(new StudioError(frame.code, frame.message, frame.retryAfterMs))
          return
        case 'res':
          answer(frame)
          return
        case 'frame': {
          const stream = streams.get(frame.sub)
          if (stream) accept(stream, frame.frame)
          return
        }
        case 'push': {
          const push = pushes.get(frame.sub)
          if (!push) return
          try {
            push.listener.onPayload(frame.payload)
          } catch {
            // A listener's own failure is its own; the stream goes on.
          }
          return
        }
        case 'call':
          tools.handleCall(frame)
          return
        case 'cancel':
          tools.handleCancel(frame)
          return
        case 'subFailed': {
          const push = pushes.get(frame.sub)
          if (push) {
            if (frame.retryable)
              push.retry = setTimeout(() => {
                push.retry = null
                if (pushes.get(push.id) === push) subscribePush(push)
              }, frame.retryAfterMs ?? 1_000)
            else endPush(push, new StudioError(frame.code, frame.message))
            return
          }
          const stream = streams.get(frame.sub)
          if (!stream) return
          stream.parts = null
          if (frame.retryable && stream.resubscribe) {
            stream.retry = setTimeout(() => {
              stream.retry = null
              if (streams.get(stream.id) === stream) subscribe(stream)
            }, frame.retryAfterMs ?? 1_000)
            return
          }
          streams.delete(stream.id)
          stream.queue.fail(new StudioError(frame.code, frame.message, frame.retryAfterMs, frame.errorId))
          return
        }
      }
    }
    const receive = (text: string): void => {
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        next.close()
        return
      }
      lastHeard = Date.now()
      const frame = parseStudioServerFrame(value)
      // A frame type this client does not know is a newer Studio's, and skipped;
      // a known one it cannot read would leave a cursor wrong, so the
      // connection is dropped and resumed instead.
      if (!frame) {
        if (isKnownStudioServerFrameType(value)) next.close()
        return
      }
      route(frame)
    }
    next.onMessage(receive)
    next.onClose((error) => {
      clearTimeout(timer)
      refused?.(
        new StudioError(
          lastBye?.code ?? 'disconnected',
          lastBye?.message ?? error?.message ?? 'The connection closed.',
        ),
      )
      if (transport === next) dropped()
    })
    next.send(
      JSON.stringify({
        t: 'hello',
        protocolVersion: STUDIO_PROTOCOL_VERSION,
        minProtocolVersion: STUDIO_PROTOCOL_MIN_SUPPORTED,
        client: { ...options.client, instanceId },
        auth: credential,
      }),
    )
    try {
      const welcomed = await greeting
      const window = checkStudioProtocolVersion(welcomed.protocolVersion, welcomed.minProtocolVersion)
      if (!window.ok) throw new StudioError('unsupported_protocol_version', window.message)
      return { welcomed, opened: next }
    } catch (error) {
      next.close()
      throw error
    } finally {
      clearTimeout(timer)
      greeted = null
      refused = null
    }
  }

  async function establish(): Promise<void> {
    const { welcomed: frame, opened } = await open()
    if (state === 'closed') {
      opened.close()
      return
    }
    // Checked before a stream resumes from its cursor or a request goes out again.
    if (environmentId !== null && frame.environment.id !== environmentId) {
      opened.close()
      throw new StudioError(
        'environment_changed',
        `This connection reached a different Studio (${frame.environment.id}) from the one this client follows (${environmentId}).`,
      )
    }
    environmentId = frame.environment.id
    transport = opened
    welcome = frame
    if (frame.pairing) {
      try {
        await options.onToken?.(frame.pairing.token)
      } catch (error) {
        // A token that could not be kept is not used: Studio holds the pairing
        // code good until its token is first presented, so the same code works
        // again once whatever kept it can.
        opened.close()
        throw new StudioError(
          'token_not_kept',
          `The token this pairing code was exchanged for could not be kept (${error instanceof Error ? error.message : String(error)}). Fix that and connect again with the same code.`,
        )
      }
      auth = { token: frame.pairing.token }
      // The connection may have closed, or the client, while the token was kept.
      if (transport !== opened) return
    }
    attempts = 0
    parkedBy = null
    lastHeard = Date.now()
    const unanswered = [...requests.values()]
    setState('open')
    startHeartbeat()
    // What this client offers goes first: a call Studio sends again after the
    // drop finds its toolset, and an agent's next call finds it at all.
    tools.reoffer()
    // A retry a refusal before the drop scheduled is overtaken: left armed, it
    // would subscribe the id a second time and be refused as a duplicate.
    for (const stream of streams.values()) {
      if (stream.retry) clearTimeout(stream.retry)
      stream.retry = null
      stream.parts = null
      subscribe(stream)
    }
    for (const push of pushes.values()) {
      if (push.retry) clearTimeout(push.retry)
      push.retry = null
      subscribePush(push)
    }
    for (const pending of unanswered)
      if (requests.get(pending.id) === pending) {
        // Sent again here: a resend a `busy` answer scheduled before the drop
        // would send the same id twice on this connection.
        if (pending.busyRetry) clearTimeout(pending.busyRetry)
        pending.busyRetry = null
        send({ t: 'req', id: pending.id, method: pending.method, params: pending.params })
      }
    // A consumer still behind from before the drop holds the new connection too.
    adjustReading()
  }

  function dropped(): void {
    transport = null
    stopHeartbeat()
    tools.dropped()
    if (state === 'closed') return
    const bye = lastBye
    if (bye && PARKING_CODES.has(bye.code) && reconnect) {
      park(new StudioError(bye.code, bye.message))
      return
    }
    if (bye && isTerminalStudioCode(bye.code, bye.retryAfterMs)) {
      fail(new StudioError(bye.code, bye.message))
      return
    }
    if (!reconnect) {
      fail(new StudioError(bye?.code ?? 'disconnected', bye?.message ?? 'The connection to Studio closed.'))
      return
    }
    setState('reconnecting')
    schedule(bye?.retryAfterMs)
  }

  function schedule(retryAfterMs?: number): void {
    if (state === 'closed') return
    // Offline, trying again only fails again: wait for the network to come back.
    if (offline()) {
      park(new StudioError('offline', 'This device is offline; Studio is reached again once it is back.'))
      return
    }
    attempts++
    if (attempts > maxAttempts) {
      fail(new StudioError('disconnected', `Studio could not be reached after ${maxAttempts} attempts.`))
      return
    }
    // Full jitter: many clients dropped at once (Studio restarting) do not
    // come back in step.
    const backoff = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempts - 1))
    const delay = Math.max(retryAfterMs ?? 0, Math.round(Math.random() * backoff))
    reconnectTimer = setTimeout(attempt, delay)
  }

  await establish().catch((error: unknown) => {
    const failure =
      error instanceof StudioError
        ? error
        : new StudioError('disconnected', error instanceof Error ? error.message : String(error))
    fail(failure)
    throw failure
  })

  // ── The services ──────────────────────────────────────────────────────────

  async function result<M extends StudioMethod>(
    method: M,
    params: StudioMethodParams<M>,
  ): Promise<ConversationResult<StudioMethodResult<M>>> {
    try {
      return { ok: true, ...(await request(method, params)) } as ConversationResult<StudioMethodResult<M>>
    } catch (error) {
      if (error instanceof StudioError)
        return {
          ok: false,
          code: error.code,
          message: error.message,
          ...(error.errorId === undefined ? {} : { errorId: error.errorId }),
        }
      throw error
    }
  }
  const commandId = (options?: CommandOptions) => options?.commandId ?? newCommandId()
  const key = (ref: ConversationRef) => ({
    workspaceId: ref.workspaceId,
    agentId: ref.agentId,
    ...(ref.workspaceRoot === undefined ? {} : { workspaceRoot: ref.workspaceRoot }),
  })

  const conversations: StudioConversationService = {
    create: (input) => result('conversation.create', { ...input, commandId: commandId(input) }),
    send: (ref, input) =>
      result('conversation.send', { key: key(ref), commandId: commandId(input), message: input.message }),
    interrupt: (ref, options) => result('conversation.interrupt', { key: key(ref), commandId: commandId(options) }),
    respondToApproval: (ref, input) =>
      result('conversation.resolveApproval', {
        key: key(ref),
        commandId: commandId(input),
        requestId: input.requestId,
        // The older boolean reads as the narrowest answer it can mean.
        decision: input.decision ?? (input.approved ? 'once' : 'deny'),
      }),
    answerQuestion: (ref, input) =>
      result('conversation.answerQuestion', {
        key: key(ref),
        commandId: commandId(input),
        requestId: input.requestId,
        answers: input.answers,
      }),
    resolvePlan: (ref, input) =>
      result('conversation.resolvePlan', {
        key: key(ref),
        commandId: commandId(input),
        requestId: input.requestId,
        decision: input.decision,
      }),
    setPermissionPreset: (ref, preset, options) =>
      result('conversation.setPermissionPreset', {
        key: key(ref),
        commandId: commandId(options),
        preset,
        ...(options?.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
      }),
    setModel: (ref, modelId, options) =>
      result('conversation.setModel', { key: key(ref), commandId: commandId(options), modelId }),
    stop: (ref, options) => result('conversation.stop', { key: key(ref), commandId: commandId(options) }),
    events: (ref, streamOptions) => openStream(ref, streamOptions).stream,
    follow(ref, followOptions, onFrame) {
      const stream = openStream(ref, {
        ...(followOptions?.afterSeq !== undefined && followOptions.generation
          ? { cursor: { afterSeq: followOptions.afterSeq, generation: followOptions.generation } }
          : {}),
        ...(followOptions?.turnLimit === undefined ? {} : { turnLimit: followOptions.turnLimit }),
        ...(followOptions?.resubscribe === false ? { resubscribe: false } : {}),
      }).stream
      void (async () => {
        try {
          for await (const frame of stream) onFrame(frame)
        } catch (error) {
          onFrame({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      })()
      return () => stream.close()
    },
    list: async () => (await request('conversation.list', {})).conversations,
    loadEarlier: (ref, beforeCursor, turnLimit) =>
      result('conversation.loadEarlier', {
        key: key(ref),
        beforeCursor,
        ...(turnLimit === undefined ? {} : { turnLimit }),
      }),
    toolDetail: (ref, toolUseId) => result('conversation.toolDetail', { key: key(ref), toolUseId }),
    turnDiff: (ref, turnSeq, path) =>
      result('conversation.turnDiff', { key: key(ref), turnSeq, ...(path === undefined ? {} : { path }) }),
  }

  return {
    ...agentConversations(conversations),
    conversations,
    get welcome() {
      return welcome!
    },
    get grant() {
      return welcome!.grant
    },
    get state() {
      return state as StudioClientState
    },
    supports: (capability) => studioPeerSupports(welcome?.capabilities, capability),
    request,
    tools: tools.api,
    wake,
    subscribe(topic, params, listener) {
      const push: Push = { id: `p${++sequence}`, topic, params, listener, retry: null }
      if (state === 'closed') {
        listener.onEnd?.(new StudioError('closed', 'The client is closed.'))
        return () => undefined
      }
      pushes.set(push.id, push)
      subscribePush(push)
      return () => {
        if (push.retry) clearTimeout(push.retry)
        if (pushes.delete(push.id) && state === 'open') send({ t: 'unsub', id: push.id })
      }
    },
    close() {
      if (state === 'closed') return
      setState('closed')
      tools.close()
      unwatch()
      stopHeartbeat()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      const error = new StudioError('closed', 'The client is closed.')
      for (const pending of requests.values()) {
        stopTimers(pending)
        pending.reject(error)
      }
      requests.clear()
      for (const stream of streams.values()) {
        if (stream.retry) clearTimeout(stream.retry)
        stream.queue.end()
      }
      streams.clear()
      for (const push of [...pushes.values()]) endPush(push)
      transport?.close()
      transport = null
      resolveClosed()
    },
    closed,
  }
}
