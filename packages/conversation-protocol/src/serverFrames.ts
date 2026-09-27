import type {
  ConversationServerFrame,
  ConversationWireErrorCode,
  ConversationWireKey,
  ConversationWirePhase,
  ConversationWireThread,
} from './index.js'

// The client half of the frame contract: what a desktop or phone following a
// conversation accepts from the desktop it follows. `parseConversationClientFrame`
// guards the server against a client; this guards a client against a server
// that is older, newer, or broken. A frame of a known type that does not have
// its documented shape is refused here rather than half-applied, so a client
// never advances its cursor past an event it could not read.

/** The event envelope every `event` frame and snapshot page carries. Payloads stay opaque. */
export type ConversationWireEvent = {
  id: string
  seq?: number
  sessionId: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  type: string
  createdAt: number
  payload?: Record<string, unknown>
}

export type ConversationWirePage = { events: ConversationWireEvent[]; hasMore: boolean; beforeCursor: number | null }

/** A server frame after validation: events and pages are typed, everything else as the protocol declares it. */
export type ConversationParsedServerFrame =
  | Exclude<ConversationServerFrame, { type: 'event' } | { type: 'snapshot' }>
  | { type: 'event'; event: ConversationWireEvent }
  | {
      type: 'snapshot'
      page: ConversationWirePage
      reset?: true
      generation?: string
      part?: { index: number; total: number }
      key?: ConversationWireKey
    }

const SERVER_FRAME_TYPES = new Set([
  'sessions',
  'event',
  'chunk',
  'snapshot',
  'synchronized',
  'subscribeFailed',
  'result',
  'commandResult',
  'error',
])
const PHASES = new Set<ConversationWirePhase>([
  'idle',
  'starting',
  'running',
  'waiting_for_approval',
  'waiting_for_input',
  'failed',
  'completed',
])
// A logical frame is at most 32 MB and a chunk carries 48k characters, so a
// few thousand chunks is the most a well-formed frame can need.
const MAX_CHUNKS = 4096

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function text(value: unknown, max = 20_000): value is string {
  return typeof value === 'string' && value.length <= max
}
function optional<T>(value: unknown, check: (value: unknown) => value is T): boolean {
  return value === undefined || check(value)
}
/** An error code as a string. Codes this build has never heard of pass: a newer desktop may add one. */
function code(value: unknown): value is ConversationWireErrorCode {
  return typeof value === 'string' && /^[a-z_]{1,64}$/.test(value)
}

/**
 * Whether a frame's `type` is one this protocol version defines. A client
 * ignores a frame of any other type — a newer desktop may send one — but a
 * frame of a known type that `parseConversationServerFrame` refuses is a
 * broken frame.
 */
export function isKnownConversationServerFrameType(value: unknown): boolean {
  return record(value) && typeof value.type === 'string' && SERVER_FRAME_TYPES.has(value.type)
}

/** One event envelope, or null. Unknown event types pass; a client skips what it cannot show. */
export function parseConversationWireEvent(value: unknown): ConversationWireEvent | null {
  if (!record(value)) return null
  if (
    !id(value.id) ||
    !optional(value.seq, integer) ||
    !text(value.sessionId, 200) ||
    !text(value.workspaceId, 200) ||
    !text(value.agentId, 200) ||
    !text(value.providerId, 200) ||
    !text(value.modelId, 400) ||
    typeof value.type !== 'string' ||
    !/^[a-z_]{1,64}$/.test(value.type) ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    !optional(value.payload, record)
  )
    return null
  return {
    id: value.id,
    ...(value.seq === undefined ? {} : { seq: value.seq as number }),
    sessionId: value.sessionId,
    workspaceId: value.workspaceId,
    agentId: value.agentId,
    providerId: value.providerId,
    modelId: value.modelId,
    type: value.type,
    createdAt: value.createdAt,
    ...(value.payload === undefined ? {} : { payload: value.payload as Record<string, unknown> }),
  }
}

function page(value: unknown): ConversationWirePage | null {
  if (!record(value) || !Array.isArray(value.events) || typeof value.hasMore !== 'boolean') return null
  if (value.beforeCursor !== null && !integer(value.beforeCursor)) return null
  const events: ConversationWireEvent[] = []
  for (const entry of value.events) {
    const event = parseConversationWireEvent(entry)
    if (!event) return null
    events.push(event)
  }
  return { events, hasMore: value.hasMore, beforeCursor: value.beforeCursor as number | null }
}

function key(value: unknown): ConversationWireKey | null {
  return record(value) && id(value.workspaceId) && id(value.agentId)
    ? { workspaceId: value.workspaceId, agentId: value.agentId }
    : null
}

/** One listed conversation, or null. Capabilities absent or malformed read as unknown, not as refused. */
function thread(value: unknown): ConversationWireThread | null {
  if (!record(value)) return null
  const listed = key(value)
  if (
    !listed ||
    !text(value.title, 2_000) ||
    !PHASES.has(value.phase as ConversationWirePhase) ||
    typeof value.updatedAt !== 'number' ||
    typeof value.createdAt !== 'number' ||
    !text(value.providerId, 200) ||
    !text(value.modelId, 400) ||
    !integer(value.turnCount) ||
    !integer(value.lastSeq) ||
    !optional(value.sessionId, id)
  )
    return null
  const flags = record(value.capabilities) ? value.capabilities : null
  const flag = (name: string) => flags?.[name] === true
  return {
    ...listed,
    title: value.title,
    phase: value.phase as ConversationWirePhase,
    updatedAt: value.updatedAt,
    createdAt: value.createdAt,
    providerId: value.providerId,
    modelId: value.modelId,
    turnCount: value.turnCount,
    lastSeq: value.lastSeq,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId as string }),
    // A preset this client does not know is left out rather than guessed at.
    ...(value.permissionPreset === 'none' || value.permissionPreset === 'bypass'
      ? { permissionPreset: value.permissionPreset }
      : {}),
    ...(flags
      ? {
          capabilities: {
            images: flag('images'),
            approvals: flag('approvals'),
            questions: flag('questions'),
            planMode: flag('planMode'),
            interrupt: flag('interrupt'),
            checkpoints: flag('checkpoints'),
          },
        }
      : {}),
  }
}

function retry(value: Record<string, unknown>): { retryAfterMs?: number } {
  return integer(value.retryAfterMs) ? { retryAfterMs: value.retryAfterMs } : {}
}

/**
 * Validate one frame from the desktop a client follows, keeping only the
 * members the protocol defines. Null for a frame of an unknown type or of a
 * known type in the wrong shape; `isKnownConversationServerFrameType` tells
 * the two apart.
 */
export function parseConversationServerFrame(value: unknown): ConversationParsedServerFrame | null {
  if (!isKnownConversationServerFrameType(value)) return null
  const frame = value as Record<string, unknown>
  switch (frame.type) {
    case 'sessions': {
      if (!id(frame.requestId) || !Array.isArray(frame.sessions)) return null
      const sessions: ConversationWireThread[] = []
      for (const entry of frame.sessions) {
        const listed = thread(entry)
        // One unreadable row does not hide the rest of the list.
        if (listed) sessions.push(listed)
      }
      return { type: 'sessions', requestId: frame.requestId, sessions }
    }
    case 'event': {
      const event = parseConversationWireEvent(frame.event)
      return event ? { type: 'event', event } : null
    }
    case 'chunk':
      return id(frame.frameId) &&
        integer(frame.total) &&
        frame.total > 0 &&
        frame.total <= MAX_CHUNKS &&
        integer(frame.index) &&
        frame.index < frame.total &&
        typeof frame.json === 'string'
        ? { type: 'chunk', frameId: frame.frameId, index: frame.index, total: frame.total, json: frame.json }
        : null
    case 'snapshot': {
      const snapshot = page(frame.page)
      if (!snapshot) return null
      if (frame.reset !== undefined && frame.reset !== true) return null
      if (!optional(frame.generation, id)) return null
      const snapshotKey = frame.key === undefined ? undefined : key(frame.key)
      if (snapshotKey === null) return null
      const part = frame.part
      if (
        part !== undefined &&
        !(record(part) && integer(part.total) && part.total > 0 && integer(part.index) && part.index < part.total)
      )
        return null
      return {
        type: 'snapshot',
        page: snapshot,
        ...(frame.reset === true ? { reset: true as const } : {}),
        ...(frame.generation === undefined ? {} : { generation: frame.generation as string }),
        ...(part === undefined
          ? {}
          : { part: { index: (part as { index: number }).index, total: (part as { total: number }).total } }),
        ...(snapshotKey ? { key: snapshotKey } : {}),
      }
    }
    case 'synchronized': {
      const fenceKey = frame.key === undefined ? undefined : key(frame.key)
      return integer(frame.seq) && optional(frame.generation, id) && fenceKey !== null
        ? {
            type: 'synchronized',
            seq: frame.seq,
            ...(frame.generation === undefined ? {} : { generation: frame.generation as string }),
            ...(fenceKey ? { key: fenceKey } : {}),
          }
        : null
    }
    case 'subscribeFailed': {
      const failed = key(frame.key)
      return failed && code(frame.code) && text(frame.message) && typeof frame.retryable === 'boolean'
        ? {
            type: 'subscribeFailed',
            key: failed,
            code: frame.code,
            message: frame.message,
            retryable: frame.retryable,
            ...retry(frame),
          }
        : null
    }
    case 'result':
      return id(frame.requestId) &&
        typeof frame.ok === 'boolean' &&
        optional(frame.code, code) &&
        optional(frame.message, text)
        ? {
            type: 'result',
            requestId: frame.requestId,
            ok: frame.ok,
            ...(frame.data === undefined ? {} : { data: frame.data }),
            ...(frame.code === undefined ? {} : { code: frame.code as ConversationWireErrorCode }),
            ...(frame.message === undefined ? {} : { message: frame.message as string }),
            ...retry(frame),
          }
        : null
    case 'commandResult':
      return id(frame.commandId) &&
        typeof frame.ok === 'boolean' &&
        optional(frame.code, code) &&
        optional(frame.message, text)
        ? {
            type: 'commandResult',
            commandId: frame.commandId,
            ok: frame.ok,
            ...(frame.code === undefined ? {} : { code: frame.code as ConversationWireErrorCode }),
            ...(frame.message === undefined ? {} : { message: frame.message as string }),
            ...retry(frame),
          }
        : null
    case 'error':
      return code(frame.code) && text(frame.message)
        ? { type: 'error', code: frame.code, message: frame.message, ...retry(frame) }
        : null
    default:
      return null
  }
}
