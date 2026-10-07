// Where the part of a chat nobody has read starts: the "New" divider drawn
// before the first reply the person has not seen, and the place the chat opens
// at when there is one.
//
// What was seen comes from the chat's visit clock (`lastVisitedAt`), which the
// sidebar moves forward while the chat is in front (`useVisitStamp`). Opening
// a chat moves it at once, so the clock as it stood just before is taken here
// first (`noteChatOpened`, said by the visit stamp before its first stamp) and
// held until the person leaves the chat. The divider is placed against that
// reading and the moment of opening, never against the live clock, so it
// stays where it was drawn while the agent keeps streaming and does not
// vanish the instant the visit lands.
//
// Window-local, like the sidebar's "finished while you were away" mark: each
// window has its own chat in front, and a mark set by hand is a thing said to
// this window's sidebar.

import { useCallback, useSyncExternalStore } from 'react'
import type { ConversationTimelineRow } from './conversationTimeline'

/** What the person had seen of a chat when it was opened. */
export type ChatUnreadSince =
  /** Everything an agent finished by the chat's visit clock. */
  | { kind: 'visit'; at: number }
  /** Marked unread by hand: everything before its latest reply. */
  | { kind: 'latestReply' }

/** A chat in front of this window, as it was when it came there. */
export type ChatOpening = {
  workspaceId: string
  openedAt: number
  /** Null for a chat with no visit clock: there is nothing to measure against. */
  since: ChatUnreadSince | null
}

let opening: ChatOpening | null = null
const markedUnreadAt = new Map<string, number>()
const listeners = new Set<() => void>()

function publish(next: ChatOpening | null): void {
  opening = next
  for (const listener of listeners) listener()
}

/**
 * Mark a chat unread in this window: the next time it is opened, the divider
 * goes above its latest reply. A visit made after `at` — on the phone, or in
 * another window — is the person having read it, and the mark no longer
 * applies.
 */
export function markChatUnread(workspaceId: string, at: number): void {
  markedUnreadAt.set(workspaceId, at)
}

/**
 * The chat came in front of this window. `visitedAt` is its visit clock as it
 * stands now, before this opening is stamped as a visit.
 */
export function noteChatOpened(workspaceId: string, visitedAt: number | null, now: number): void {
  const markedAt = markedUnreadAt.get(workspaceId)
  markedUnreadAt.delete(workspaceId)
  const since: ChatUnreadSince | null =
    markedAt !== undefined && (visitedAt ?? Number.NEGATIVE_INFINITY) < markedAt
      ? { kind: 'latestReply' }
      : visitedAt === null
        ? null
        : { kind: 'visit', at: visitedAt }
  publish({ workspaceId, openedAt: now, since })
}

/** The chat left the front of this window. A later opening reads the clock afresh. */
export function noteChatLeft(workspaceId: string): void {
  if (opening?.workspaceId === workspaceId) publish(null)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The opening of `workspaceId` while it is the chat in front; null otherwise, or for no chat. */
export function useChatOpening(workspaceId: string | null): ChatOpening | null {
  const read = useCallback(
    () => (workspaceId !== null && opening?.workspaceId === workspaceId ? opening : null),
    [workspaceId],
  )
  return useSyncExternalStore(subscribe, read, read)
}

type ReplyRow = Extract<ConversationTimelineRow, { kind: 'assistant' }>

// When a reply began, and when it finished; a reply still streaming has not.
// A reply replayed from a transcript that kept no clock has neither.
function replyBegan(row: ReplyRow): number | undefined {
  return row.entry.startedAt ?? row.entry.completedAt
}
function replyFinished(row: ReplyRow): number | undefined {
  return row.entry.status === 'streaming' ? undefined : (row.entry.completedAt ?? row.entry.startedAt)
}

/**
 * The row the "New" divider goes above, or null for none.
 *
 * Only an agent's reply can be new. The person's own messages are never the
 * start of what they have not read, and the compaction marker, decision
 * records and the live status line are the view's furniture. A reply is a
 * whole row — its steps folded under it — so the divider lands at a reply's
 * start, never inside its work.
 *
 * A reply is unseen when it finished after the visit clock, or, still
 * streaming when the chat was opened, began after it: one already under way
 * when the person last looked is one they watched begin, and a divider above
 * it after a glance elsewhere would send them back over what they just read. A reply that began
 * after the chat was opened is being watched as it arrives, so the divider
 * never moves on to it. With nothing seen from an agent above the first
 * unseen reply there is no divider at all: the whole chat is new — one started
 * and left before it answered, or never opened — and a "New" above all of it
 * says nothing.
 *
 * Marked unread by hand, the divider goes above the latest reply that was
 * there when the chat was opened, whatever the clock says.
 *
 * A context compaction that happened inside the unseen reply's turn sits just
 * above it, and the divider goes above that too, so the two seams read in the
 * order things happened.
 */
export function unreadDividerRowId(rows: readonly ConversationTimelineRow[], opened: ChatOpening): string | null {
  const since = opened.since
  if (!since) return null
  const arrivedBeforeOpening = (row: ReplyRow) => (replyBegan(row) ?? Number.NEGATIVE_INFINITY) <= opened.openedAt
  let index = -1
  if (since.kind === 'latestReply') {
    for (let cursor = rows.length - 1; cursor >= 0; cursor -= 1) {
      const row = rows[cursor]!
      if (row.kind === 'assistant' && arrivedBeforeOpening(row)) {
        index = cursor
        break
      }
    }
  } else {
    let seenReply = false
    for (let cursor = 0; cursor < rows.length; cursor += 1) {
      const row = rows[cursor]!
      if (row.kind !== 'assistant') continue
      if (!arrivedBeforeOpening(row)) break
      // A finish after the opening was watched, so the reply is read as it
      // stood then: still streaming. Without this the divider would jump onto
      // a reply the moment it finished in front of the reader.
      const finishedAt = replyFinished(row)
      const finished = finishedAt !== undefined && finishedAt <= opened.openedAt ? finishedAt : undefined
      const unseen =
        finished !== undefined ? finished > since.at : (replyBegan(row) ?? Number.NEGATIVE_INFINITY) > since.at
      if (!unseen) {
        seenReply = true
        continue
      }
      if (seenReply) index = cursor
      break
    }
  }
  const target = rows[index]
  if (!target || target.kind !== 'assistant') return null
  let start = index
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const row = rows[cursor]!
    if (row.kind !== 'compaction' || row.entry.turnId !== target.entry.turnId) break
    start = cursor
  }
  return rows[start]!.id
}
