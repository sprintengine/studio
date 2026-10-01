import {
  CONVERSATION_MAX_FRAME_BYTES,
  type ConversationServerFrame,
} from '../../packages/conversation-protocol/src/public'
import type { ConversationEvent, ConversationPage } from './conversation-runtime'

// How a conversation's frames are cut to size for a socket, shared by every
// transport that streams one: the tailnet lane's WebSocket and the Studio
// RPC's owner socket. Pure, so the two cannot disagree about where a snapshot
// splits or which deltas are one message.

// A snapshot keeps its newest events within this; older ones stay reachable
// through `loadEarlier`, so a huge page pages instead of looping on a resync.
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
// The target size of one snapshot part, leaving room for its envelope.
const SNAPSHOT_PART_BYTES = CONVERSATION_MAX_FRAME_BYTES - 32 * 1024

/**
 * The text one `chunk` frame carries. A chunk's text is re-escaped inside its
 * envelope; at 3 bytes per UTF-16 unit at worst this stays well under the
 * frame cap.
 */
export const CONVERSATION_CHUNK_CHARS = 48_000

export type ConversationSnapshotFrame = Extract<ConversationServerFrame, { type: 'snapshot' }> & {
  page: ConversationPage
}

/**
 * A merge key for a text delta whose payload is only its text and turn, or
 * null. Two deltas with the same key are one message, and the stored log
 * merges exactly these runs too.
 */
export function conversationDeltaKey(event: ConversationEvent): string | null {
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
export function conversationSnapshotParts(
  frame: ConversationSnapshotFrame,
  redact: (part: ConversationSnapshotFrame) => ConversationSnapshotFrame,
): {
  bytes: number
  frames(wire: (json: string) => Generator<string>, current: () => boolean): Generator<string>
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
    *frames(wire, current) {
      for (let index = 0; index < parts.length; index++) {
        if (!current()) return
        yield* wire(
          JSON.stringify(
            redact({
              ...frame,
              page: { ...page, events: parts[index] },
              ...(parts.length > 1 ? { part: { index, total: parts.length } } : {}),
            }),
          ),
        )
      }
    },
  }
}
