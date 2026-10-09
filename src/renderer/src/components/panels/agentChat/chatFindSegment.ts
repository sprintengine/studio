// How Find in chat (chatFind.ts) names the pieces of text it searches, shared
// with the rows that draw them so a match counted in the data can be found
// again on the page. A module of its own because both sides import it: the
// index reads the plan card's title rules, and the plan card marks its text.

/** The attribute a rendered row puts on each element whose text is one searched segment. */
export const CHAT_FIND_SEGMENT_ATTRIBUTE = 'data-chat-find-segment'

/** Segment keys, unique within a conversation: each names the entry its text came from. */
export const chatFindSegmentKey = {
  user: (entryId: string) => `user:${entryId}`,
  reply: (turnId: string) => `reply:${turnId}`,
  plan: (requestId: string) => `plan:${requestId}`,
}
