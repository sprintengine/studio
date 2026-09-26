import type { Duplex } from 'stream'
import { homedir } from 'node:os'

import {
  CONVERSATION_MAX_FRAME_BYTES,
  parseConversationClientFrame,
  type ConversationClientFrame,
  type ConversationServerFrame,
  type ConversationWireErrorCode,
} from '../../../../packages/conversation-protocol/src'
import { tailnetScopeGrantsAccess, type TailnetScope } from '../../../shared/tailnet'
import type { ConversationKey } from '../../../shared/conversation-runtime'
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

const MAX_QUEUED_FRAMES = 64
const MAX_QUEUED_BYTES = 2 * 1024 * 1024
// A single fetched detail can expand when JSON escapes its text. It is paced
// separately from the live-event queue; at most one such response may wait.
const MAX_LOGICAL_FRAME_BYTES = 32 * 1024 * 1024
const RESYNC_CLOSE_CODE = 4409
const PING_MS = 25_000
const PONG_TIMEOUT_MS = 60_000

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
  audit(command: string, workspaceId: string, agentId: string): void
  now?: () => number
}

/** A single scoped socket: replay, a synchronization fence, then live events. */
export function createTailnetConversationStream(options: TailnetConversationStreamOptions): TailnetConversationStream {
  const { socket, host } = options
  const grants = new Set(options.scopes)
  const mayRead = tailnetScopeGrantsAccess(grants, 'conversation:read')
  const mayOperate = tailnetScopeGrantsAccess(grants, 'conversation:operate')
  const now = options.now ?? Date.now
  let closed = false
  const pending: { json: string; bytes: number; large: boolean }[] = []
  let pendingBytes = 0
  let queuedLargeFrame = false
  let writing = false
  let lastPong = now()
  let currentKey: ConversationKey | null = null
  let subscription: { dispose(): void } | null = null
  let frameSequence = 0
  let subscriptionGeneration = 0
  let inFlight = 0

  const close = (code: number, reason: string): void => {
    if (closed) return
    closed = true
    subscriptionGeneration++
    pending.length = 0
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
  const writeText = (json: string): Promise<void> =>
    new Promise((resolve) => {
      if (closed || socket.destroyed) {
        resolve()
        return
      }
      const frame = encodeTextFrame(json)
      if (frame.length > CONVERSATION_MAX_FRAME_BYTES || socket.writableLength + frame.length > MAX_QUEUED_BYTES) {
        close(RESYNC_CLOSE_CODE, 'resync_required')
        resolve()
        return
      }
      socket.write(frame, () => resolve())
    })
  const writeControl = (frame: Buffer): void => {
    if (closed || socket.destroyed) return
    if (socket.writableLength + frame.length > MAX_QUEUED_BYTES) {
      close(RESYNC_CLOSE_CODE, 'resync_required')
      return
    }
    socket.write(frame)
  }
  const drain = async (): Promise<void> => {
    if (writing) return
    writing = true
    try {
      while (!closed && pending.length) {
        const { json, bytes, large } = pending.shift()!
        if (large) queuedLargeFrame = false
        else pendingBytes -= bytes
        if (Buffer.byteLength(json) <= CONVERSATION_MAX_FRAME_BYTES) {
          await writeText(json)
          continue
        }
        // One logical frame is the active producer. Its chunks are paced by
        // socket write completion, so a 5 MB detail does not fill its own queue.
        const frameId = `${options.deviceId}:${++frameSequence}`
        const chunkSize = 48_000
        const total = Math.ceil(json.length / chunkSize)
        for (let index = 0; index < total && !closed; index++) {
          await writeText(
            JSON.stringify({
              type: 'chunk',
              frameId,
              index,
              total,
              json: json.slice(index * chunkSize, (index + 1) * chunkSize),
            }),
          )
        }
      }
    } finally {
      writing = false
    }
  }
  const send = (frame: ConversationServerFrame): void => {
    if (closed) return
    const json = JSON.stringify(redactHomePaths(redactConversationValue(frame), homedir()))
    const bytes = Buffer.byteLength(json)
    const large = bytes > CONVERSATION_MAX_FRAME_BYTES
    if (
      bytes > MAX_LOGICAL_FRAME_BYTES ||
      pending.length >= MAX_QUEUED_FRAMES ||
      (large ? queuedLargeFrame : pendingBytes + bytes > MAX_QUEUED_BYTES)
    ) {
      close(RESYNC_CLOSE_CODE, 'resync_required')
      return
    }
    pending.push({ json, bytes, large })
    if (large) queuedLargeFrame = true
    else pendingBytes += bytes
    void drain()
  }
  const error = (code: ConversationWireErrorCode, message: string): void => send({ type: 'error', code, message })
  const result = (requestId: string, value: unknown): void => {
    if (value && typeof value === 'object' && 'ok' in value && (value as { ok: boolean }).ok) {
      send({ type: 'result', requestId, ok: true, data: value })
    } else {
      send({ type: 'result', requestId, ok: false, code: 'unavailable' })
    }
  }
  const requireKey = (requestId: string): ConversationKey | null => {
    if (currentKey) return currentKey
    send({ type: 'result', requestId, ok: false, code: 'not_found' })
    return null
  }
  const handle = async (frame: ConversationClientFrame): Promise<void> => {
    if (!mayRead) {
      error('conversation_scope_required', 'This device has no conversation read grant.')
      return
    }
    if (frame.type === 'list') {
      send({ type: 'sessions', requestId: frame.requestId, sessions: await host.list() })
      return
    }
    if (frame.type === 'subscribe') {
      const key = host.resolveKey(frame.key.workspaceId, frame.key.agentId)
      if (!key) {
        error('not_found', 'Conversation is unavailable.')
        return
      }
      subscription?.dispose()
      const generation = ++subscriptionGeneration
      currentKey = key
      const joined = host.subscribe(key, frame.afterSeq, frame.turnLimit, (event) => {
        if (closed || generation !== subscriptionGeneration) return
        if (event.type === 'error') error('unavailable', event.message)
        else send(event)
      })
      subscription = joined
      await joined.ready
      return
    }
    if (frame.type === 'loadEarlier') {
      const key = requireKey(frame.requestId)
      if (key) result(frame.requestId, await host.loadEarlier(key, frame.beforeCursor, frame.turnLimit))
      return
    }
    if (frame.type === 'getToolDetail') {
      const key = requireKey(frame.requestId)
      if (key) result(frame.requestId, await host.getToolDetail(key, frame.toolUseId))
      return
    }
    if (frame.type === 'getTurnDiff') {
      const key = requireKey(frame.requestId)
      if (key) result(frame.requestId, await host.getTurnDiff(key, frame.turnSeq, frame.path))
      return
    }
    if (frame.type === 'command') {
      if (!mayOperate) {
        send({ type: 'commandResult', commandId: frame.commandId, ok: false, code: 'conversation_operate_required' })
        return
      }
      if (!currentKey) {
        send({ type: 'commandResult', commandId: frame.commandId, ok: false, code: 'not_found' })
        return
      }
      options.audit(frame.command.kind, currentKey.workspaceId, currentKey.agentId)
      const commandResult = await host.command(currentKey, options.deviceId, frame.commandId, frame.command)
      send({
        type: 'commandResult',
        commandId: frame.commandId,
        ok: commandResult.ok,
        ...(commandResult.ok ? {} : { code: 'unavailable', message: commandResult.message }),
      })
    }
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
      if (inFlight >= MAX_QUEUED_FRAMES) {
        close(RESYNC_CLOSE_CODE, 'resync_required')
        return
      }
      inFlight++
      void handle(clientFrame)
        .catch(() => error('unavailable', 'Conversation operation failed.'))
        .finally(() => {
          inFlight--
        })
    }
  })
  socket.on('end', () => close(WEBSOCKET_CLOSE_GOING_AWAY, ''))
  socket.on('close', () => close(WEBSOCKET_CLOSE_GOING_AWAY, ''))
  socket.on('error', () => close(WEBSOCKET_CLOSE_GOING_AWAY, ''))
  return { deviceId: options.deviceId, close, isClosed: () => closed }
}

function redactHomePaths<T>(value: T, home: string): T {
  if (typeof value === 'string') return value.replaceAll(home, '[home]') as T
  if (Array.isArray(value)) return value.map((entry) => redactHomePaths(entry, home)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactHomePaths(entry, home)])) as T
  }
  return value
}
