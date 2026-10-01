// What a client and a Studio say about themselves before anything else.
//
// The rule is the conversation lane's, one level up: features are asked about
// by capability, and the version integer exists only to refuse a peer outright
// when a change could not be additive, naming both numbers when it does. The
// conversation contract's own version and capabilities travel inside the
// welcome unchanged, so a client that speaks only conversations reads exactly
// what it reads from the tailnet lane.

/** The envelope, handshake and method table this package describes. */
export const STUDIO_PROTOCOL_VERSION = 1
/** The oldest version a Studio built from this package still serves. */
export const STUDIO_PROTOCOL_MIN_SUPPORTED = 1

/** Follow, list and drive conversations: the `conversation.*` reads, commands and the session stream. */
export const STUDIO_CONVERSATIONS_CAPABILITY = 'conversations' as const
/** Start a conversation with `conversation.create`. */
export const STUDIO_CONVERSATION_CREATE_CAPABILITY = 'conversation-create' as const
/** A `hello` may carry a one-time pairing code instead of a token, and is answered with the token. */
export const STUDIO_LOCAL_PAIRING_CAPABILITY = 'local-pairing' as const

/**
 * Every Studio capability this version of the package knows, in the order
 * they shipped. A Studio advertises the ones it serves; a client reads a name
 * it does not know as a feature it does not use.
 */
export const STUDIO_CAPABILITIES = [
  STUDIO_CONVERSATIONS_CAPABILITY,
  STUDIO_CONVERSATION_CREATE_CAPABILITY,
  STUDIO_LOCAL_PAIRING_CAPABILITY,
] as const

export type StudioCapability = (typeof STUDIO_CAPABILITIES)[number]

/** Whether a peer serves a capability. A peer that listed none serves none. */
export function studioPeerSupports(
  capabilities: readonly string[] | null | undefined,
  capability: StudioCapability,
): boolean {
  return Array.isArray(capabilities) && capabilities.includes(capability)
}

/**
 * Whether two ends can talk: each must serve the other's version. Both then
 * speak the lower of the two current versions. The refusal names both numbers
 * and which side to update.
 */
export function checkStudioProtocolVersion(
  peerVersion: number,
  peerMinVersion: number = peerVersion,
): { ok: true; version: number } | { ok: false; message: string } {
  if (peerVersion < STUDIO_PROTOCOL_MIN_SUPPORTED)
    return {
      ok: false,
      message: `The other end speaks Studio protocol ${peerVersion}, and this one needs ${STUDIO_PROTOCOL_MIN_SUPPORTED} or newer. Update the other end.`,
    }
  if (peerMinVersion > STUDIO_PROTOCOL_VERSION)
    return {
      ok: false,
      message: `The other end needs Studio protocol ${peerMinVersion} or newer, and this one speaks ${STUDIO_PROTOCOL_VERSION}. Update this end.`,
    }
  return { ok: true, version: Math.min(peerVersion, STUDIO_PROTOCOL_VERSION) }
}
