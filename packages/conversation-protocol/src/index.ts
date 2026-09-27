export * from './tool-types.js'
export * from './presentation.js'
export * from './toolKind.js'
export * from './commandLabel.js'

/** An additive capability of the tailnet gateway, served only over the tailnet. */
export const CONVERSATION_CAPABILITY = 'conversations' as const
export const CONVERSATION_SOCKET_PATH = '/tailnet/v1/conversation'
/**
 * The largest frame the desktop sends. A logical frame bigger than this — a
 * large tool detail, a long merged reply — arrives as consecutive `chunk`
 * frames whose `json` strings concatenate, in `index` order, to the frame.
 */
export const CONVERSATION_MAX_FRAME_BYTES = 256 * 1024
export const CONVERSATION_MAX_IMAGES = 16
/** The longest message a `send` carries, and the most text a question's answers may hold together. */
export const CONVERSATION_MAX_MESSAGE_CHARS = 200_000
/**
 * The largest frame a client may send. A message at the character limit can
 * encode to six bytes per UTF-16 unit when every unit is escaped (`\u0001`),
 * so the cap is that worst case plus room for the envelope: a message the
 * validator accepts always fits. A larger frame is skipped and refused with a
 * typed `too_large` failure rather than closing the socket.
 */
export const CONVERSATION_MAX_CLIENT_FRAME_BYTES = CONVERSATION_MAX_MESSAGE_CHARS * 6 + 64 * 1024
const MAX_ANSWERS = 64
/**
 * The close code for a socket the desktop could not keep up to date: the
 * client fell too far behind live events. Reconnect with the last cursor after
 * the delay the close reason advises (`conversationCloseRetryAfterMs`).
 */
export const CONVERSATION_RESYNC_CLOSE_CODE = 4409
/** The close code for a device whose grant no longer includes `conversation:read`. Re-pairing is the fix. */
export const CONVERSATION_SCOPE_CLOSE_CODE = 4403

/** A close reason carrying a retry delay, e.g. `resync_required;retryAfterMs=2000`. */
export function conversationCloseReason(code: string, retryAfterMs: number): string {
  return `${code};retryAfterMs=${Math.max(0, Math.round(retryAfterMs))}`
}

/** The retry delay a close reason advises, or null when it names none. */
export function conversationCloseRetryAfterMs(reason: string): number | null {
  const match = /;retryAfterMs=(\d{1,7})$/.exec(reason)
  return match ? Number(match[1]) : null
}

export type ConversationWirePhase =
  'idle' | 'starting' | 'running' | 'waiting_for_approval' | 'waiting_for_input' | 'failed' | 'completed'
export type ConversationWireKey = { workspaceId: string; agentId: string }
export type ConversationWireThread = ConversationWireKey & {
  title: string
  phase: ConversationWirePhase
  updatedAt: number
  createdAt: number
  providerId: string
  modelId: string
  turnCount: number
  lastSeq: number
  sessionId?: string
  capabilities?: {
    images: boolean
    approvals: boolean
    questions: boolean
    planMode: boolean
    interrupt: boolean
    checkpoints: boolean
  }
}
export type ConversationWireErrorCode =
  | 'conversation_scope_required'
  | 'conversation_operate_required'
  | 'invalid_frame'
  | 'not_found'
  | 'unavailable'
  | 'resync_required'
  // Too many requests of this kind are already in flight on this socket.
  // Retryable: retry after `retryAfterMs`.
  | 'busy'
  // A request, command or response over its size limit. Not retryable as is.
  | 'too_large'
  | 'unsafe_remote_decision'
  | 'unsafe_remote_preset'
  | 'unsupported_command'
export type ConversationWireCommand =
  | { kind: 'send'; message: string; uploadIds?: string[] }
  | { kind: 'interrupt' }
  | { kind: 'resolveApproval'; requestId: string; decision: 'once' | 'conversation' | 'deny' }
  | { kind: 'answerQuestion'; requestId: string; answers: Record<string, string> }
  | { kind: 'setPermissionPreset'; preset: 'manual' | 'auto' }
/**
 * `afterSeq` with the `generation` of an earlier `snapshot` or `synchronized`
 * asks for only the events after that sequence: one `event` per missed event,
 * then `synchronized`, then live events, with no snapshot. A cursor the
 * desktop cannot vouch for — another generation, no generation, ahead of the
 * log, or too far behind — is answered with `snapshot` (`reset: true`) instead.
 */
export type ConversationClientFrame =
  | { type: 'subscribe'; key: ConversationWireKey; afterSeq?: number; generation?: string; turnLimit?: number }
  | { type: 'list'; requestId: string }
  | { type: 'loadEarlier'; requestId: string; beforeCursor: number; turnLimit?: number }
  | { type: 'getToolDetail'; requestId: string; toolUseId: string }
  | { type: 'getTurnDiff'; requestId: string; turnSeq: number; path?: string }
  | { type: 'command'; commandId: string; command: ConversationWireCommand }

export type ConversationServerFrame =
  | { type: 'sessions'; requestId: string; sessions: ConversationWireThread[] }
  | { type: 'event'; event: unknown }
  | { type: 'chunk'; frameId: string; index: number; total: number; json: string }
  // Sequence numbers only ever increase, but they are not contiguous: a run of
  // text deltas can arrive merged into one delta numbered with the run's last
  // sequence. A gap is normal and never a reason to resubscribe.
  //
  // A snapshot too big for one frame arrives as consecutive `snapshot` frames
  // with `part`: their `page.events` concatenate in `index` order, and every
  // other field is the same on each. Apply it once the last part arrives. A
  // snapshot without `part` is whole.
  | {
      type: 'snapshot'
      page: unknown
      reset?: true
      generation?: string
      part?: { index: number; total: number }
    }
  | { type: 'synchronized'; seq: number; generation?: string }
  // The subscription to `key` did not start. When `retryable`, subscribe again
  // after `retryAfterMs`; otherwise the conversation is not available to this
  // device.
  | {
      type: 'subscribeFailed'
      key: ConversationWireKey
      code: ConversationWireErrorCode
      message: string
      retryable: boolean
      retryAfterMs?: number
    }
  | {
      type: 'result'
      requestId: string
      ok: boolean
      data?: unknown
      code?: ConversationWireErrorCode
      message?: string
      retryAfterMs?: number
    }
  | {
      type: 'commandResult'
      commandId: string
      ok: boolean
      code?: ConversationWireErrorCode
      message?: string
      retryAfterMs?: number
    }
  | { type: 'error'; code: ConversationWireErrorCode; message: string; retryAfterMs?: number }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function answers(value: unknown): value is Record<string, string> {
  if (!record(value)) return false
  const entries = Object.entries(value)
  let chars = 0
  for (const [key, answer] of entries) {
    if (key.length > 200 || typeof answer !== 'string' || answer.length > 20_000) return false
    chars += key.length + answer.length
  }
  return entries.length <= MAX_ANSWERS && chars <= CONVERSATION_MAX_MESSAGE_CHARS
}

/** Why a client frame was refused, and the id to answer it under when it carries one. */
export type ConversationFrameRejection = {
  code: ConversationWireErrorCode
  message: string
  commandId?: string
  commandKind?: string
  requestId?: string
}

/**
 * The typed refusal for a frame `parseConversationClientFrame` rejected. A
 * command is answered under its `commandId` and a read under its `requestId`,
 * so a client can always settle what it sent.
 */
export function explainRejectedConversationFrame(value: unknown): ConversationFrameRejection {
  const frame = record(value) ? value : {}
  const command = frame.type === 'command' && record(frame.command) ? frame.command : null
  const ids = {
    ...(frame.type === 'command' && id(frame.commandId) ? { commandId: frame.commandId } : {}),
    ...(command && typeof command.kind === 'string' ? { commandKind: command.kind.slice(0, 64) } : {}),
    ...(frame.type !== 'command' && id(frame.requestId) ? { requestId: frame.requestId } : {}),
  }
  if (command?.decision === 'always')
    return { code: 'unsafe_remote_decision', message: 'A remote device cannot choose a permanent rule.', ...ids }
  if (command?.preset === 'bypass' || command?.preset === 'none')
    return { code: 'unsafe_remote_preset', message: 'A remote device cannot choose that permission preset.', ...ids }
  const tooLong =
    (typeof command?.message === 'string' && command.message.length > CONVERSATION_MAX_MESSAGE_CHARS) ||
    (record(command?.answers) &&
      (Object.keys(command.answers).length > MAX_ANSWERS ||
        Object.entries(command.answers).reduce(
          (sum, [key, answer]) => sum + key.length + (typeof answer === 'string' ? answer.length : 0),
          0,
        ) > CONVERSATION_MAX_MESSAGE_CHARS))
  if (tooLong)
    return {
      code: 'too_large',
      message: `A message may hold at most ${CONVERSATION_MAX_MESSAGE_CHARS} characters.`,
      ...ids,
    }
  if (
    command &&
    !['send', 'interrupt', 'resolveApproval', 'answerQuestion', 'setPermissionPreset'].includes(String(command.kind))
  )
    return { code: 'unsupported_command', message: 'This desktop does not support that command.', ...ids }
  return { code: 'invalid_frame', message: 'Unsupported conversation frame.', ...ids }
}

/** Validate supported fields and strip unknown members before handing a frame to main. */
export function parseConversationClientFrame(value: unknown): ConversationClientFrame | null {
  if (!record(value) || typeof value.type !== 'string') return null
  switch (value.type) {
    case 'subscribe': {
      const key = value.key
      if (!record(key) || !id(key.workspaceId) || !id(key.agentId)) return null
      if (value.afterSeq !== undefined && !integer(value.afterSeq)) return null
      if (value.generation !== undefined && !id(value.generation)) return null
      if (value.turnLimit !== undefined && (!integer(value.turnLimit) || value.turnLimit > 100)) return null
      return {
        type: 'subscribe',
        key: { workspaceId: key.workspaceId, agentId: key.agentId },
        ...(value.afterSeq === undefined ? {} : { afterSeq: value.afterSeq as number }),
        ...(value.generation === undefined ? {} : { generation: value.generation as string }),
        ...(value.turnLimit === undefined ? {} : { turnLimit: value.turnLimit as number }),
      }
    }
    case 'list':
      return id(value.requestId) ? { type: 'list', requestId: value.requestId } : null
    case 'loadEarlier':
      return id(value.requestId) &&
        integer(value.beforeCursor) &&
        (value.turnLimit === undefined || (integer(value.turnLimit) && value.turnLimit <= 100))
        ? {
            type: 'loadEarlier',
            requestId: value.requestId,
            beforeCursor: value.beforeCursor,
            ...(value.turnLimit === undefined ? {} : { turnLimit: value.turnLimit as number }),
          }
        : null
    case 'getToolDetail':
      return id(value.requestId) && id(value.toolUseId)
        ? { type: 'getToolDetail', requestId: value.requestId, toolUseId: value.toolUseId }
        : null
    case 'getTurnDiff':
      return id(value.requestId) &&
        integer(value.turnSeq) &&
        (value.path === undefined || (typeof value.path === 'string' && value.path.length <= 4096))
        ? {
            type: 'getTurnDiff',
            requestId: value.requestId,
            turnSeq: value.turnSeq,
            ...(value.path === undefined ? {} : { path: value.path as string }),
          }
        : null
    case 'command': {
      if (!id(value.commandId) || !record(value.command)) return null
      const command = value.command
      switch (command.kind) {
        case 'send':
          return typeof command.message === 'string' &&
            command.message.length <= CONVERSATION_MAX_MESSAGE_CHARS &&
            (command.uploadIds === undefined ||
              (Array.isArray(command.uploadIds) &&
                command.uploadIds.length <= CONVERSATION_MAX_IMAGES &&
                command.uploadIds.every(id)))
            ? {
                type: 'command',
                commandId: value.commandId,
                command: {
                  kind: 'send',
                  message: command.message,
                  ...(command.uploadIds === undefined ? {} : { uploadIds: command.uploadIds as string[] }),
                },
              }
            : null
        case 'interrupt':
          return { type: 'command', commandId: value.commandId, command: { kind: 'interrupt' } }
        case 'resolveApproval':
          return id(command.requestId) && ['once', 'conversation', 'deny'].includes(String(command.decision))
            ? {
                type: 'command',
                commandId: value.commandId,
                command: {
                  kind: 'resolveApproval',
                  requestId: command.requestId,
                  decision: command.decision as 'once' | 'conversation' | 'deny',
                },
              }
            : null
        case 'answerQuestion':
          return id(command.requestId) && answers(command.answers)
            ? {
                type: 'command',
                commandId: value.commandId,
                command: { kind: 'answerQuestion', requestId: command.requestId, answers: command.answers },
              }
            : null
        case 'setPermissionPreset':
          return ['manual', 'auto'].includes(String(command.preset))
            ? {
                type: 'command',
                commandId: value.commandId,
                command: { kind: 'setPermissionPreset', preset: command.preset as 'manual' | 'auto' },
              }
            : null
        default:
          return null
      }
    }
    default:
      return null
  }
}
