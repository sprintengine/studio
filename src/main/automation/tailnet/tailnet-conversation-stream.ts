import type { Duplex } from 'stream'
import { homedir } from 'node:os'

import {
  CONVERSATION_MAX_FRAME_BYTES,
  CONVERSATION_RESYNC_CLOSE_CODE,
  conversationCloseReason,
  parseConversationClientFrame,
  type ConversationClientFrame,
  type ConversationServerFrame,
  type ConversationWireCommand,
  type ConversationWireErrorCode,
} from '../../../../packages/conversation-protocol/src'
import { tailnetScopeGrantsAccess, type TailnetScope } from '../../../shared/tailnet'
import type { ConversationEvent, ConversationKey, ConversationPage } from '../../../shared/conversation-runtime'
import type { ConversationGatewayHost } from './tailnet-conversation-host'
import { redactConversationValue } from '../../conversation-tool-details'
import {
  createWebSocketFrameDecoder,
  encodeCloseFrame,
  encodePingFrame,
  encodePongFrame,
  encodeTextFrame,
  WEBSOCKET_CLOSE_GOING_AWAY,
} from './websocket-frames'

// Live frames waiting behind a slow reader. Consecutive deltas of one message
// merge into the frame already waiting and a tool's newer partial output
// replaces its older one, so a streaming reply is one entry however long the
// reader stalls. Only a reader that stops reading reaches these.
const MAX_LIVE_FRAMES = 256
const MAX_LIVE_BYTES = 4 * 1024 * 1024
// Replay and large responses are produced one wire frame at a time, paced by
// socket write completion, and do not count against the live limits. A read
// waits for room here instead of failing.
const MAX_BULK_BYTES = 48 * 1024 * 1024
// One logical response (a tool detail, a diff) above this is not sent at all.
const MAX_LOGICAL_FRAME_BYTES = 32 * 1024 * 1024
// A snapshot keeps its newest events within this; older ones stay reachable
// through `loadEarlier`, so a huge page pages instead of looping on a resync.
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
// The target size of one snapshot part, leaving room for its envelope.
const SNAPSHOT_PART_BYTES = CONVERSATION_MAX_FRAME_BYTES - 32 * 1024
// A chunk's text is re-escaped inside its envelope; at 3 bytes per UTF-16
// unit at worst this stays well under the frame cap.
const CHUNK_CHARS = 48_000
// The socket's own buffer beyond the frame being written: pings and a pong.
const MAX_SOCKET_BUFFER_BYTES = 2 * 1024 * 1024
const MAX_IN_FLIGHT_READS = 4
const MAX_IN_FLIGHT_COMMANDS = 16
const BUSY_RETRY_MS = 250
const PING_MS = 25_000
const PONG_TIMEOUT_MS = 60_000

const COMMAND_KINDS: Record<ConversationWireCommand['kind'], true> = {
  send: true,
  interrupt: true,
  resolveApproval: true,
  answerQuestion: true,
  setPermissionPreset: true,
}

/**
 * The audit names of remote conversation commands. They are mutations in the
 * gateway's own classification, which is what puts every one of them — a
 * refused one included — in the audit beside the MCP tools a device calls.
 */
export const CONVERSATION_COMMAND_TOOL_NAMES: readonly string[] = Object.keys(COMMAND_KINDS).map(
  (kind) => `conversation.${kind}`,
)

/** One remote command as the audit records it: who, which conversation, what kind, how it ended. Never its text. */
export type ConversationCommandAudit = {
  tool: string
  commandId: string
  key: Pick<ConversationKey, 'workspaceId' | 'agentId'> | null
  ok: boolean
  code?: ConversationWireErrorCode
  durationMs: number
}

export type TailnetConversationStream = {
  deviceId: string
  close(code: number, reason: string): void
  isClosed(): boolean
}

export type TailnetConversationStreamOptions = {
  socket: Duplex
  deviceId: string
  deviceName: string
  scopes: readonly TailnetScope[]
  host: ConversationGatewayHost
  onClosed(): void
  audit(entry: ConversationCommandAudit): void
  /** How long a client should wait before reconnecting after this socket falls too far behind. */
  resyncRetryAfterMs?: () => number
  now?: () => number
}

/**
 * The delay a device is told to wait after a resync close. It doubles with
 * each resync inside a few minutes, so a client that keeps falling behind
 * backs off instead of reconnecting straight into the same backlog.
 */
export function createResyncBackoff(now: () => number = Date.now): (deviceId: string) => number {
  const history = new Map<string, { count: number; at: number }>()
  return (deviceId) => {
    const at = now()
    const prior = history.get(deviceId)
    const count = prior && at - prior.at < 5 * 60_000 ? prior.count + 1 : 1
    history.set(deviceId, { count, at })
    return Math.min(60_000, 1_000 * 2 ** (count - 1))
  }
}

type LiveEntry = {
  kind: 'live'
  frame: ConversationServerFrame
  bytes: number
  subscription?: number
  // Consecutive deltas of one message extend this frame's event in place.
  delta?: { key: string; event: ConversationEvent }
  // A partial tool output a newer output for the same tool replaces.
  partialToolUseId?: string
}
type BulkEntry = {
  kind: 'bulk'
  frames: Iterator<string>
  bytes: number
  started: boolean
  subscription?: number
}
type SnapshotFrame = Extract<ConversationServerFrame, { type: 'snapshot' }> & { page: ConversationPage }

/** A single scoped socket: replay, a synchronization fence, then live events. */
export function createTailnetConversationStream(options: TailnetConversationStreamOptions): TailnetConversationStream {
  const { socket, host } = options
  const grants = new Set(options.scopes)
  const mayRead = tailnetScopeGrantsAccess(grants, 'conversation:read')
  const mayOperate = tailnetScopeGrantsAccess(grants, 'conversation:operate')
  const now = options.now ?? Date.now
  let closed = false
  const pending: Array<LiveEntry | BulkEntry> = []
  let liveFrames = 0
  let liveBytes = 0
  let bulkBytes = 0
  const bulkWaiters: Array<{ bytes: number; resolve: () => void }> = []
  let writing = false
  let lastPong = now()
  let currentKey: ConversationKey | null = null
  let subscription: { dispose(): void } | null = null
  let frameSequence = 0
  let subscriptionGeneration = 0
  let readsInFlight = 0
  let commandsInFlight = 0

  const close = (code: number, reason: string): void => {
    if (closed) return
    closed = true
    subscriptionGeneration++
    pending.length = 0
    for (const waiter of bulkWaiters.splice(0)) waiter.resolve()
    subscription?.dispose()
    subscription = null
    clearInterval(heartbeat)
    if (!socket.destroyed) {
      try {
        socket.write(encodeCloseFrame(code, reason))
      } catch {
        /* Peer already left. */
      }
      socket.end()
    }
    options.onClosed()
  }
  // The reader stopped reading: live events outgrew their bound. The frame
  // says why and when to come back, ahead of whatever is still buffered, and
  // the close reason repeats the delay for a client that only sees the close.
  const resync = (): void => {
    if (closed) return
    const retryAfterMs = options.resyncRetryAfterMs?.() ?? 1_000
    if (!socket.destroyed) {
      try {
        socket.write(
          encodeTextFrame(
            JSON.stringify({
              type: 'error',
              code: 'resync_required',
              message: 'This device fell too far behind the conversation. Reconnect with your last cursor.',
              retryAfterMs,
            } satisfies ConversationServerFrame),
          ),
        )
      } catch {
        /* Peer already left. */
      }
    }
    close(CONVERSATION_RESYNC_CLOSE_CODE, conversationCloseReason('resync_required', retryAfterMs))
  }
  const writeText = (json: string): Promise<void> =>
    new Promise((resolve) => {
      if (closed || socket.destroyed) {
        resolve()
        return
      }
      const frame = encodeTextFrame(json)
      if (
        frame.length > CONVERSATION_MAX_FRAME_BYTES ||
        socket.writableLength + frame.length > MAX_SOCKET_BUFFER_BYTES
      ) {
        resync()
        resolve()
        return
      }
      socket.write(frame, () => resolve())
    })
  const writeControl = (frame: Buffer): void => {
    if (closed || socket.destroyed) return
    if (socket.writableLength + frame.length > MAX_SOCKET_BUFFER_BYTES) {
      resync()
      return
    }
    socket.write(frame)
  }
  /** One logical frame as the wire frames that carry it: itself, or its chunks. */
  function* wireFrames(json: string): Generator<string> {
    if (Buffer.byteLength(json) <= CONVERSATION_MAX_FRAME_BYTES) {
      yield json
      return
    }
    const frameId = `${options.deviceId}:${++frameSequence}`
    const total = Math.ceil(json.length / CHUNK_CHARS)
    for (let index = 0; index < total; index++) {
      yield JSON.stringify({
        type: 'chunk',
        frameId,
        index,
        total,
        json: json.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS),
      } satisfies ConversationServerFrame)
    }
  }
  const releaseBulkWaiters = (): void => {
    while (bulkWaiters.length && (bulkBytes === 0 || bulkBytes + bulkWaiters[0].bytes <= MAX_BULK_BYTES))
      bulkWaiters.shift()!.resolve()
  }
  const drain = async (): Promise<void> => {
    if (writing) return
    writing = true
    try {
      while (!closed && pending.length) {
        const entry = pending[0]
        if (entry.kind === 'live') {
          pending.shift()
          liveFrames--
          liveBytes -= entry.bytes
          for (const json of wireFrames(JSON.stringify(entry.frame))) {
            if (closed) break
            await writeText(json)
          }
          continue
        }
        entry.started = true
        const next = entry.frames.next()
        if (next.done) {
          pending.shift()
          bulkBytes -= entry.bytes
          releaseBulkWaiters()
          continue
        }
        await writeText(next.value)
      }
    } finally {
      writing = false
    }
  }
  const redact = <T>(frame: T): T => redactHomePaths(redactConversationValue(frame), homedir())
  /** Extend a waiting delta with a later one of the same message. */
  const extend = (into: LiveEntry & { delta: object }, event: ConversationEvent): void => {
    const text = String(event.payload!.text)
    const merged = into.delta.event
    merged.payload = { ...merged.payload, text: String(merged.payload!.text) + text }
    merged.seq = event.seq
    const grown = Buffer.byteLength(JSON.stringify(text)) - 2
    into.bytes += grown
    liveBytes += grown
  }
  const mergeable = (entry: LiveEntry | BulkEntry | undefined, key: string, subscription?: number) =>
    entry?.kind === 'live' && entry.delta?.key === key && entry.subscription === subscription
  const removeLive = (entry: LiveEntry): void => {
    const index = pending.indexOf(entry)
    pending.splice(index, 1)
    liveFrames--
    liveBytes -= entry.bytes
    // Two runs of one message that the removed frame kept apart are adjacent
    // now, so they become one, as if it had never been between them.
    const before = pending[index - 1]
    const after = pending[index]
    if (before?.kind === 'live' && before.delta && after?.kind === 'live' && after.delta) {
      if (mergeable(after, before.delta.key, before.subscription)) {
        extend(before as LiveEntry & { delta: object }, after.delta.event)
        pending.splice(index, 1)
        liveFrames--
        liveBytes -= after.bytes
      }
    }
  }
  /** Queue one live frame, merging it into what already waits where it can. */
  const sendLive = (source: ConversationServerFrame, subscription?: number): void => {
    if (closed) return
    const frame = redact(source)
    const event = frame.type === 'event' ? (frame.event as ConversationEvent) : null
    const key = event ? deltaKey(event) : null
    const tail = pending.at(-1)
    if (key && event && mergeable(tail, key, subscription)) {
      // Only an unsent frame is ever in the queue, so this merges only while
      // the reader is behind. The merged delta keeps its first id and takes
      // the last sequence, which is how a stored run reads back too.
      extend(tail as LiveEntry & { delta: object }, event)
      if (liveBytes > MAX_LIVE_BYTES) resync()
      return
    }
    const toolUseId =
      event?.type === 'tool_output' && typeof event.payload?.toolUseId === 'string' ? event.payload.toolUseId : null
    if (toolUseId) {
      for (const queued of pending.filter(
        (entry): entry is LiveEntry => entry.kind === 'live' && entry.partialToolUseId === toolUseId,
      ))
        removeLive(queued)
    }
    const bytes = Buffer.byteLength(JSON.stringify(frame))
    if (liveFrames >= MAX_LIVE_FRAMES || liveBytes + bytes > MAX_LIVE_BYTES) {
      resync()
      return
    }
    pending.push({
      kind: 'live',
      frame,
      bytes,
      ...(subscription === undefined ? {} : { subscription }),
      ...(key && event ? { delta: { key, event } } : {}),
      ...(toolUseId && event?.payload?.partial === true ? { partialToolUseId: toolUseId } : {}),
    })
    liveFrames++
    liveBytes += bytes
    void drain()
  }
  const sendBulk = (frames: Iterator<string>, bytes: number, subscription?: number): void => {
    if (closed) return
    pending.push({
      kind: 'bulk',
      frames,
      bytes,
      started: false,
      ...(subscription === undefined ? {} : { subscription }),
    })
    bulkBytes += bytes
    void drain()
  }
  /** A response to a request: small ones queue live, large ones wait for bulk room and stream in chunks. */
  const respond = async (source: ConversationServerFrame): Promise<void> => {
    if (closed) return
    const json = JSON.stringify(redact(source))
    const bytes = Buffer.byteLength(json)
    if (bytes > MAX_LOGICAL_FRAME_BYTES) {
      resync()
      return
    }
    if (bytes <= CONVERSATION_MAX_FRAME_BYTES) {
      sendLive(source)
      return
    }
    if (bulkBytes > 0 && bulkBytes + bytes > MAX_BULK_BYTES)
      await new Promise<void>((resolve) => bulkWaiters.push({ bytes, resolve }))
    sendBulk(wireFrames(json), bytes)
  }
  /** Everything a join produced, streamed as one paced unit ahead of the live events that follow it. */
  const sendReplay = (frames: ConversationServerFrame[], subscription: number): void => {
    const redacted = frames.map((frame) => redact(frame))
    let bytes = 0
    const encoded: Array<() => Generator<string>> = []
    for (const frame of redacted) {
      if (frame.type === 'snapshot') {
        const parts = snapshotParts(frame as SnapshotFrame)
        bytes += parts.bytes
        encoded.push(() => parts.frames(wireFrames))
      } else {
        const json = JSON.stringify(frame)
        bytes += Buffer.byteLength(json)
        encoded.push(() => wireFrames(json))
      }
    }
    sendBulk(
      (function* () {
        for (const produce of encoded) yield* produce()
      })(),
      bytes,
      subscription,
    )
  }
  const error = (code: ConversationWireErrorCode, message: string): void => sendLive({ type: 'error', code, message })
  const result = (requestId: string, value: unknown): Promise<void> => {
    if (value && typeof value === 'object' && 'ok' in value && (value as { ok: boolean }).ok)
      return respond({ type: 'result', requestId, ok: true, data: value })
    return respond({ type: 'result', requestId, ok: false, code: 'unavailable' })
  }
  const requireKey = (requestId: string): ConversationKey | null => {
    if (currentKey) return currentKey
    sendLive({ type: 'result', requestId, ok: false, code: 'not_found' })
    return null
  }
  const subscribe = async (frame: Extract<ConversationClientFrame, { type: 'subscribe' }>): Promise<void> => {
    const key = host.resolveKey(frame.key.workspaceId, frame.key.agentId)
    if (!key) {
      error('not_found', 'Conversation is unavailable.')
      return
    }
    subscription?.dispose()
    const generation = ++subscriptionGeneration
    // What an earlier subscription left waiting to be sent is stale now.
    for (const entry of [...pending]) {
      if (entry.subscription === undefined || entry.subscription === generation) continue
      if (entry.kind === 'live') removeLive(entry)
      else if (!entry.started) {
        pending.splice(pending.indexOf(entry), 1)
        bulkBytes -= entry.bytes
      }
    }
    releaseBulkWaiters()
    currentKey = key
    // Frames before the fence are the join's replay. They are collected and
    // sent as one paced unit, so a catch-up of two thousand events or a large
    // snapshot never counts against the bound on live events behind it.
    let replay: ConversationServerFrame[] | null = []
    const cursor = { afterSeq: frame.afterSeq, generation: frame.generation, turnLimit: frame.turnLimit }
    const joined = host.subscribe(key, cursor, (event) => {
      if (closed || generation !== subscriptionGeneration) return
      if (event.type === 'error') {
        replay = null
        error('unavailable', event.message)
        return
      }
      if (!replay) {
        sendLive(event, generation)
        return
      }
      replay.push(event)
      if (event.type === 'synchronized') {
        const frames = replay
        replay = null
        sendReplay(frames, generation)
      }
    })
    subscription = joined
    await joined.ready
  }
  const handle = async (frame: ConversationClientFrame): Promise<void> => {
    if (!mayRead) {
      error('conversation_scope_required', 'This device has no conversation read grant.')
      return
    }
    if (frame.type === 'list') {
      await respond({ type: 'sessions', requestId: frame.requestId, sessions: await host.list() })
      return
    }
    if (frame.type === 'subscribe') {
      await subscribe(frame)
      return
    }
    if (frame.type === 'loadEarlier') {
      const key = requireKey(frame.requestId)
      if (key) await result(frame.requestId, await host.loadEarlier(key, frame.beforeCursor, frame.turnLimit))
      return
    }
    if (frame.type === 'getToolDetail') {
      const key = requireKey(frame.requestId)
      if (key) await result(frame.requestId, await host.getToolDetail(key, frame.toolUseId))
      return
    }
    if (frame.type === 'getTurnDiff') {
      const key = requireKey(frame.requestId)
      if (key) await result(frame.requestId, await host.getTurnDiff(key, frame.turnSeq, frame.path))
      return
    }
    if (frame.type === 'command') {
      const started = now()
      const key = currentKey
      const finish = (ok: boolean, code?: ConversationWireErrorCode, message?: string): void => {
        options.audit({
          tool: `conversation.${frame.command.kind}`,
          commandId: frame.commandId,
          key: key ? { workspaceId: key.workspaceId, agentId: key.agentId } : null,
          ok,
          ...(code ? { code } : {}),
          durationMs: now() - started,
        })
        sendLive({
          type: 'commandResult',
          commandId: frame.commandId,
          ok,
          ...(code ? { code } : {}),
          ...(message ? { message } : {}),
        })
      }
      if (!mayOperate) return finish(false, 'conversation_operate_required')
      if (!key) return finish(false, 'not_found')
      const commandResult = await host.command(key, options.deviceId, frame.commandId, frame.command)
      if (commandResult.ok) finish(true)
      else finish(false, 'unavailable', commandResult.message)
    }
  }
  // Reads and commands are bounded per socket: one device cannot queue up
  // unbounded transcript reads or turns. Over the bound the request is
  // answered as busy, with a delay, and the socket stays open.
  const admit = (frame: ConversationClientFrame): boolean => {
    const busy = { ok: false as const, code: 'busy' as const, retryAfterMs: BUSY_RETRY_MS }
    if (frame.type === 'command') {
      if (commandsInFlight < MAX_IN_FLIGHT_COMMANDS) return true
      sendLive({ type: 'commandResult', commandId: frame.commandId, ...busy })
      return false
    }
    if (readsInFlight < MAX_IN_FLIGHT_READS) return true
    if (frame.type === 'subscribe')
      sendLive({ type: 'error', code: 'busy', message: 'Too many requests.', retryAfterMs: BUSY_RETRY_MS })
    else sendLive({ type: 'result', requestId: frame.requestId, ...busy })
    return false
  }

  const heartbeat = setInterval(() => {
    if (closed) return
    if (now() - lastPong > PONG_TIMEOUT_MS) {
      close(WEBSOCKET_CLOSE_GOING_AWAY, 'pong_timeout')
      return
    }
    writeControl(encodePingFrame())
  }, PING_MS)
  heartbeat.unref()
  if (!mayRead) {
    error('conversation_scope_required', 'This device has no conversation read grant.')
    close(1000, 'conversation_scope_required')
    return { deviceId: options.deviceId, close, isClosed: () => closed }
  }

  const decoder = createWebSocketFrameDecoder(CONVERSATION_MAX_FRAME_BYTES)
  socket.on('data', (chunk: Buffer) => {
    if (closed) return
    const decoded = decoder.push(chunk)
    if (decoded.kind === 'error') {
      close(decoded.code, decoded.reason)
      return
    }
    for (const frame of decoded.frames) {
      if (closed) return
      if (frame.kind === 'close') {
        close(WEBSOCKET_CLOSE_GOING_AWAY, '')
        return
      }
      if (frame.kind === 'pong') {
        lastPong = now()
        continue
      }
      if (frame.kind === 'ping') {
        writeControl(encodePongFrame(frame.payload))
        continue
      }
      if (frame.kind !== 'text') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(frame.text)
      } catch {
        error('invalid_frame', 'Frame must be JSON.')
        continue
      }
      const clientFrame = parseConversationClientFrame(parsed)
      if (!clientFrame) {
        const command =
          parsed && typeof parsed === 'object' && 'command' in parsed
            ? (parsed as { command?: { decision?: string; preset?: string } }).command
            : undefined
        error(
          command?.decision === 'always'
            ? 'unsafe_remote_decision'
            : command?.preset === 'bypass' || command?.preset === 'none'
              ? 'unsafe_remote_preset'
              : 'invalid_frame',
          'Unsupported conversation frame.',
        )
        continue
      }
      if (!admit(clientFrame)) continue
      const isCommand = clientFrame.type === 'command'
      if (isCommand) commandsInFlight++
      else readsInFlight++
      void handle(clientFrame)
        .catch(() => error('unavailable', 'Conversation operation failed.'))
        .finally(() => {
          if (isCommand) commandsInFlight--
          else readsInFlight--
        })
    }
  })
  socket.on('end', () => close(WEBSOCKET_CLOSE_GOING_AWAY, ''))
  socket.on('close', () => close(WEBSOCKET_CLOSE_GOING_AWAY, ''))
  socket.on('error', () => close(WEBSOCKET_CLOSE_GOING_AWAY, ''))
  return { deviceId: options.deviceId, close, isClosed: () => closed }
}

/**
 * A merge key for a text delta whose payload is only its text and turn, or
 * null. Two deltas with the same key are one message, and the stored log
 * merges exactly these runs too.
 */
function deltaKey(event: ConversationEvent): string | null {
  if (event.type !== 'content_delta' && event.type !== 'reasoning_delta') return null
  const payload = event.payload
  if (!payload || typeof payload.text !== 'string') return null
  for (const key of Object.keys(payload)) if (key !== 'text' && key !== 'turnId') return null
  return JSON.stringify([
    event.type,
    event.sessionId,
    event.workspaceId,
    event.agentId,
    event.providerId,
    event.modelId,
    payload.turnId ?? null,
  ])
}

/**
 * A snapshot as the frames that carry it. Its newest events are kept within
 * the snapshot budget — anything older is left to `loadEarlier`, with the
 * page's `beforeCursor` moved to match — and split into parts that each fit
 * one frame. A snapshot that fits one frame is sent whole, without `part`.
 */
function snapshotParts(frame: SnapshotFrame): {
  bytes: number
  frames(wire: (json: string) => Generator<string>): Generator<string>
} {
  const events = frame.page.events
  const sizes = events.map((event) => Buffer.byteLength(JSON.stringify(event)))
  let first = events.length
  let bytes = 0
  while (first > 0 && bytes + sizes[first - 1] <= MAX_SNAPSHOT_BYTES) bytes += sizes[--first]
  let page = frame.page
  if (first > 0) {
    const kept = events.slice(first)
    // Paging back returns what ends before the cursor. The oldest kept event's
    // own sequence is that boundary even for a merged run, which is numbered
    // with its last delta and so covers everything after the previous record.
    const boundary = kept[0]?.seq ?? (events.at(-1)?.seq ?? 0) + 1
    page = { events: kept, hasMore: true, beforeCursor: boundary }
  }
  const parts: ConversationEvent[][] = []
  let size = 0
  for (let index = first; index < events.length; index++) {
    if (!parts.length || (size + sizes[index] > SNAPSHOT_PART_BYTES && parts.at(-1)!.length)) {
      parts.push([])
      size = 0
    }
    parts.at(-1)!.push(events[index])
    size += sizes[index]
  }
  if (!parts.length) parts.push([])
  return {
    bytes,
    *frames(wire) {
      for (let index = 0; index < parts.length; index++) {
        yield* wire(
          JSON.stringify({
            ...frame,
            page: { ...page, events: parts[index] },
            ...(parts.length > 1 ? { part: { index, total: parts.length } } : {}),
          }),
        )
      }
    },
  }
}

function redactHomePaths<T>(value: T, home: string): T {
  if (typeof value === 'string') return value.replaceAll(home, '[home]') as T
  if (Array.isArray(value)) return value.map((entry) => redactHomePaths(entry, home)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactHomePaths(entry, home)])) as T
  }
  return value
}
