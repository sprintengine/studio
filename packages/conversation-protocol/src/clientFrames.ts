import {
  explainRejectedConversationFrame,
  parseConversationClientFrame,
  type ConversationClientFrame,
  type ConversationFrameRejection,
} from './index.js'
import { isConversationPermissionModeId, type ConversationCommand } from './commands.js'
import type { ConversationHelloRequest } from './handshake.js'

// The server half of the full contract: what a desktop accepts from a client.
// `parseConversationClientFrame` (index.ts) is the lane as it first shipped
// and stays byte-for-byte what the phone carries; this reads the same frames
// plus the extensions in commands.ts and handshake.ts, each of which a client
// sends only to a desktop that advertised it.

/** A client frame under the full contract. */
export type ConversationClientMessage =
  | Exclude<ConversationClientFrame, { type: 'command' }>
  | { type: 'command'; commandId: string; command: ConversationCommand }
  | ConversationHelloRequest

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/** Validate supported fields and strip unknown members, as `parseConversationClientFrame` does for the first version. */
export function parseConversationClientMessage(value: unknown): ConversationClientMessage | null {
  if (!record(value)) return null
  if (value.type === 'hello') {
    if (!id(value.requestId)) return null
    const version = value.protocolVersion
    if (version !== undefined && !(typeof version === 'number' && Number.isSafeInteger(version) && version >= 1))
      return null
    return {
      type: 'hello',
      requestId: value.requestId,
      ...(version === undefined ? {} : { protocolVersion: version as number }),
    }
  }
  if (value.type === 'command' && record(value.command)) {
    const command = value.command
    if (command.kind === 'resolvePlan') {
      return id(value.commandId) &&
        id(command.requestId) &&
        (command.decision === 'approve' || command.decision === 'reject')
        ? {
            type: 'command',
            commandId: value.commandId,
            command: { kind: 'resolvePlan', requestId: command.requestId, decision: command.decision },
          }
        : null
    }
    if (command.kind === 'setPermissionPreset' && command.permissionMode !== undefined) {
      if (!isConversationPermissionModeId(command.permissionMode)) return null
      const frame = parseConversationClientFrame(value)
      if (!frame || frame.type !== 'command' || frame.command.kind !== 'setPermissionPreset') return null
      return { ...frame, command: { ...frame.command, permissionMode: command.permissionMode } }
    }
  }
  return parseConversationClientFrame(value)
}

/**
 * The typed refusal for a frame `parseConversationClientMessage` rejected,
 * answered under the id it carries, as `explainRejectedConversationFrame`
 * answers the first version's frames.
 */
export function explainRejectedConversationMessage(value: unknown): ConversationFrameRejection {
  const rejection = explainRejectedConversationFrame(value)
  // A malformed command of a kind this contract added is a bad frame, not one
  // the desktop does not know.
  return rejection.code === 'unsupported_command' && rejection.commandKind === 'resolvePlan'
    ? { ...rejection, code: 'invalid_frame', message: 'Unsupported conversation frame.' }
    : rejection
}
