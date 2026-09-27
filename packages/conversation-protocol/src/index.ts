export * from './tool-types.js'
export * from './presentation.js'
export * from './toolKind.js'
export * from './commandLabel.js'

/** A separate, additive tailnet feature; not the hosted mobile-control wire. */
export const CONVERSATION_CAPABILITY = 'conversations' as const
export const CONVERSATION_SOCKET_PATH = '/tailnet/v1/conversation'
export const CONVERSATION_MAX_FRAME_BYTES = 256 * 1024
export const CONVERSATION_MAX_IMAGES = 16

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
  | { type: 'snapshot'; page: unknown; reset?: true; generation?: string }
  | { type: 'synchronized'; seq: number; generation?: string }
  | {
      type: 'result'
      requestId: string
      ok: boolean
      data?: unknown
      code?: ConversationWireErrorCode
      chunk?: { index: number; total: number }
    }
  | { type: 'commandResult'; commandId: string; ok: boolean; code?: ConversationWireErrorCode; message?: string }
  | { type: 'error'; code: ConversationWireErrorCode; message: string }

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
  return (
    record(value) &&
    Object.entries(value).every(
      ([key, answer]) => key.length <= 200 && typeof answer === 'string' && answer.length <= 20_000,
    )
  )
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
            command.message.length <= 200_000 &&
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
