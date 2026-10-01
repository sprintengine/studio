/**
 * The conversation peek: what a hover over a chat row or an agent tab shows.
 *
 * The surface answers "what is this chat" for a chat you are NOT looking at —
 * the message that started it, the messages sent since, and the identity
 * (model, session) behind it. Design in
 * `backlog/mockups/2026-09-07-conversation-peek.html`.
 *
 * This module is the seam between the two halves and holds nothing else: main
 * answers with a `ConversationPeek` built from the prompts the app captured
 * from the CLI's `UserPromptSubmit` hook; the renderer renders exactly that and
 * asks for nothing more.
 *
 * Main never reads a CLI's own transcript for this (owner ruling 2026-09-24):
 * re-parsing a live, many-megabyte JSONL on every hover was the whole cost of
 * the card. So the card carries text only — no pasted images, no attached
 * files — and a chat whose prompts the app never saw shows none.
 *
 * There is deliberately NO message count. The card shows the messages it can
 * show and says nothing about how many it could not — a running total is a
 * number nobody acts on, and a field that exists only to be ignored is one the
 * next reader has to work out is dead.
 *
 * Pure: no I/O, no Electron, no DOM.
 */

/** Longest thread message text main sends. Past this the tooltip lies about how much it is showing. */
export const MAX_PEEK_MESSAGE_CHARS = 400

/** Longest first-message text main sends — the card quotes it, clamped to a few lines. */
export const MAX_PEEK_FIRST_CHARS = 1_200

/** Most recent messages carried in `since`. A 200-message chat scrolls the tail, not the whole run. */
export const MAX_PEEK_MESSAGES = 50

export type ConversationPeekMessage = {
  id: string
  /**
   * The person's text, with the bulk already collapsed: fenced blocks, pasted
   * blobs and injected wrappers are dropped and dropped paths shortened to
   * their names, so what is left is the sentence they typed. Capped by the
   * constants above.
   */
  text: string
  /** Epoch ms the message was sent. Rendered as "2h", never as a clock. */
  at: number
  /** Characters cut from `text` by the cap; 0 when nothing was. */
  truncatedChars: number
}

/**
 * Where the answer came from, because the card must say which shape it is in
 * rather than look broken:
 * - `live` — prompts this app captured for the chat. They persist per agent
 *   across restarts, but they begin when the app first saw the chat: a chat
 *   started elsewhere and resumed here has nothing from before that.
 * - `none` — the runtime reports no prompts at all (OpenCode, Muse, a plain
 *   shell). The card still carries the model and the session id.
 * - `unknown` — main holds no state for this session id at all. This is NOT
 *   `none`, and the distinction is the whole reason it exists — `none` is a
 *   statement about the RUNTIME, and saying it here tells someone their Claude
 *   Code chat cannot report messages, which is both false and
 *   unfixable-looking. `unknown` is a statement about our own records, which is
 *   the honest one.
 */
export type ConversationPeekSource = 'live' | 'none' | 'unknown'

export type ConversationPeek = {
  sessionId: string
  source: ConversationPeekSource
  /**
   * The message that started the chat, or null when none is known — including
   * for a runtime that CAN report and simply has nothing yet, which is why this
   * being null does not imply `source: 'none'`.
   */
  first: ConversationPeekMessage | null
  /** Everything after `first`, oldest first, at most {@link MAX_PEEK_MESSAGES}. */
  since: ConversationPeekMessage[]
}

/**
 * The empty answer for a runtime that cannot report at all — a plain shell,
 * OpenCode, Muse. A runtime that reports but has nothing yet answers `live`
 * with an empty `first`/`since` instead, so the card never says "this runtime
 * doesn't report its messages" about Claude Code.
 */
export function emptyConversationPeek(sessionId: string): ConversationPeek {
  return { sessionId, source: 'none', first: null, since: [] }
}
