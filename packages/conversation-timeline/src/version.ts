import { CONVERSATION_PROTOCOL_MIN_SUPPORTED, CONVERSATION_PROTOCOL_VERSION } from './protocol.js'

// Which conversation protocol this package reads (phase 9 spec, 5.5): the
// window of the conversation contract it was built with. A Studio says which
// it speaks in its welcome (`welcome.conversation`); a view asks this before
// it follows anything, and draws the refusal instead of a conversation it
// might misread.

export const CONVERSATION_TIMELINE_PROTOCOL = {
  min: CONVERSATION_PROTOCOL_MIN_SUPPORTED,
  max: CONVERSATION_PROTOCOL_VERSION,
} as const

/** Whether a Studio's conversation protocol is one this package reads; the refusal names both. */
export function checkConversationTimelineProtocol(
  server: { protocolVersion: number; minProtocolVersion?: number } | null | undefined,
): { ok: true } | { ok: false; message: string } {
  const version = server?.protocolVersion
  const { min, max } = CONVERSATION_TIMELINE_PROTOCOL
  const range = min === max ? `${max}` : `${min}–${max}`
  if (typeof version !== 'number')
    return {
      ok: false,
      message: `This Studio server did not say which conversation protocol it speaks; this view speaks ${range}.`,
    }
  const serverMin = server?.minProtocolVersion ?? version
  if (version < min || serverMin > max)
    return {
      ok: false,
      message: `This Studio server speaks conversation protocol ${version}; this view speaks ${range}.`,
    }
  return { ok: true }
}
