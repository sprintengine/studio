// The embed's `postMessage` wire (phase 9 spec, 5.4; a row in
// docs/compatibility.md). The iframe and the page that frames it speak it;
// nothing else in Studio does.
//
// - The iframe posts only to the embed's registered origins, never `'*'`, and
//   only to its parent.
// - It accepts a message only when it comes from its parent and from one of
//   those origins, and only in a shape it knows: an unknown `type` is
//   ignored, an unknown `v` is answered `unsupported_version`, and anything
//   larger than a theme could be is dropped unread.
// - No message makes the iframe send, answer or navigate: the host can theme
//   it, scroll it, and hand it its token, and that is all.

export const EMBED_PROTOCOL_VERSION = 1
const MAX_MESSAGE_CHARS = 16 * 1024

export type EmbedToHost =
  | { v: 1; type: 'ready'; embedId: string }
  | { v: 1; type: 'resize'; height: number }
  | { v: 1; type: 'link'; href: string }
  | { v: 1; type: 'state'; turns: number; working: boolean }
  | { v: 1; type: 'error'; code: string }

export type HostToEmbed =
  | { v: 1; type: 'theme'; mode: 'light' | 'dark' | 'system' }
  | { v: 1; type: 'token'; token: string }
  | { v: 1; type: 'scrollTo'; turnId: string }

export type EmbedMessageVerdict =
  { kind: 'accept'; message: HostToEmbed } | { kind: 'ignore' } | { kind: 'refuse'; code: 'unsupported_version' }

/** Read one message event against the embed's rules. */
export function readHostMessage(
  event: { origin: string; source: unknown; data: unknown },
  allowedOrigins: readonly string[],
  parent: unknown,
): EmbedMessageVerdict {
  if (event.source !== parent || !allowedOrigins.includes(event.origin)) return { kind: 'ignore' }
  const data = event.data as Record<string, unknown> | null
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'ignore' }
  try {
    if (JSON.stringify(data).length > MAX_MESSAGE_CHARS) return { kind: 'ignore' }
  } catch {
    return { kind: 'ignore' }
  }
  if (data.v !== EMBED_PROTOCOL_VERSION) return { kind: 'refuse', code: 'unsupported_version' }
  switch (data.type) {
    case 'theme':
      return data.mode === 'light' || data.mode === 'dark' || data.mode === 'system'
        ? { kind: 'accept', message: { v: 1, type: 'theme', mode: data.mode } }
        : { kind: 'ignore' }
    case 'token':
      return typeof data.token === 'string' && /^mcemb_[\w-]{16,128}$/u.test(data.token)
        ? { kind: 'accept', message: { v: 1, type: 'token', token: data.token } }
        : { kind: 'ignore' }
    case 'scrollTo':
      return typeof data.turnId === 'string' && data.turnId.length <= 200
        ? { kind: 'accept', message: { v: 1, type: 'scrollTo', turnId: data.turnId } }
        : { kind: 'ignore' }
    default:
      return { kind: 'ignore' }
  }
}

/** Post to the framing page, on each registered origin; nothing when the page is not framed or none is registered. */
export function postToHost(
  message: EmbedToHost,
  allowedOrigins: readonly string[],
  target: { postMessage(message: unknown, origin: string): void } | null,
): void {
  if (!target) return
  for (const origin of allowedOrigins) {
    try {
      target.postMessage(message, origin)
    } catch {
      // A target origin the parent is not on: the browser does not deliver it.
    }
  }
}
