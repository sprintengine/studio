/**
 * The conversation peek: what a hover over a chat row or an agent tab shows.
 *
 * The surface answers "what is this chat" for a chat you are NOT looking at —
 * the message that started it, every message sent since, and the identity
 * (model, session) behind it. Design in
 * `backlog/mockups/2026-09-07-conversation-peek.html`.
 *
 * This module is the seam between the two halves and holds nothing else: main
 * reads the CLI's own transcript (or, where a runtime has none, the prompts it
 * has seen since launch) and answers with a `ConversationPeek`; the renderer
 * renders exactly that and asks for nothing more.
 *
 * There is deliberately NO message count. The card shows the messages it can
 * show and says nothing about how many it could not — a running total is a
 * number nobody acts on, and a field that exists only to be ignored is one the
 * next reader has to work out is dead.
 *
 * WE PERSIST NOTHING. There is no copy of a prompt in the workspace registry
 * and no file of our own: the transcript belongs to the CLI, and the live
 * fallback lives in memory for as long as the session does. A chat whose
 * runtime reports neither degrades to identity alone, which is why `source`
 * is part of the answer rather than an implementation detail.
 *
 * Pure: no I/O, no Electron, no DOM.
 */

/** Longest thread message text main sends. Past this the tooltip lies about how much it is showing. */
export const MAX_PEEK_MESSAGE_CHARS = 400

/** Longest first-message text main sends — the card quotes it, clamped to a few lines. */
export const MAX_PEEK_FIRST_CHARS = 1_200

/** Most recent messages carried in `since`. A 200-message chat scrolls the tail, not the whole run. */
export const MAX_PEEK_MESSAGES = 50

/**
 * Attachments listed per message, and — separately — images listed for the
 * whole conversation. Beyond either the card counts the remainder.
 */
export const MAX_PEEK_ATTACHMENTS = 8

/**
 * Something the person attached to a message. An image opens in a viewer; a
 * file opens the file. Both are actions, which is why they live on the card and
 * never in the message tooltip — a tooltip may not be interactive.
 */
export type ConversationPeekAttachment =
  | {
      kind: 'image'
      /** Stable within one peek, for React keys and for asking main to open it. */
      id: string
      /** What to say when there is no thumbnail yet, and the accessible name. */
      label: string
      /** A small cached PNG data URL, absent while it is still being made. */
      thumbnailDataUrl?: string
    }
  | {
      kind: 'file'
      id: string
      /** Basename, shown on the chip. */
      label: string
      /** Absolute path to open, or null when the transcript named no readable one. */
      path: string | null
    }

/** The image half of {@link ConversationPeekAttachment}, named so the strip can hold it. */
export type ConversationPeekImage = Extract<ConversationPeekAttachment, { kind: 'image' }>

export type ConversationPeekMessage = {
  id: string
  /**
   * The person's text, with the bulk already collapsed: fenced blocks, pasted
   * blobs and dropped paths become attachments or are dropped, so what is left
   * is the sentence they typed. Capped by the constants above.
   */
  text: string
  /** Epoch ms the message was sent. Rendered as "2h", never as a clock. */
  at: number
  attachments: ConversationPeekAttachment[]
  /** Characters cut from `text` by the cap; 0 when nothing was. */
  truncatedChars: number
}

/**
 * Where the answer came from, because the card must say which shape it is in
 * rather than look broken:
 * - `transcript` — the CLI's own file: the whole history, images and files.
 * - `live` — prompts seen since this app launched, for a runtime that reports
 *   `UserPromptSubmit` but hands us no transcript. Text only, no attachments.
 * - `none` — the runtime reports neither (OpenCode, Muse, a plain shell). The
 *   card still carries the model and the session id.
 * - `unknown` — main holds no state for this session id at all: the app was
 *   killed rather than quit, so no sidecar was written, or the chat was parked
 *   past the sidecar's TTL. This is NOT `none`, and the distinction is the
 *   whole reason it exists — `none` is a statement about the RUNTIME, and
 *   saying it here tells someone their Claude Code chat cannot report messages,
 *   which is both false and unfixable-looking. `unknown` is a statement about
 *   our own records, which is the honest one.
 */
export type ConversationPeekSource = 'transcript' | 'live' | 'none' | 'unknown'

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
  /**
   * The conversation's images as ONE strip, oldest first, at most
   * {@link MAX_PEEK_ATTACHMENTS} (mockup 2026-09-09, frame 4). A flat
   * re-listing, not a second source: each entry is the same attachment — same
   * id, same thumbnail — that also sits on the message that carried it, so the
   * thread rows keep their per-row counts and a click here opens exactly what a
   * click there would.
   *
   * Only images there is SOMETHING TO OPEN reach this list. Main cannot keep
   * every payload in a chat that pasted forty screenshots, and a thumbnail with
   * no bytes behind it is a live-looking button that does nothing — so an image
   * whose payload was not retained stays counted on its own thread row and is
   * absent here. Which is also why the card's "+N" counts the remainder OF THIS
   * LIST and never claims a total for the chat.
   *
   * Empty for a `live` peek, whose prompt frames carry no attachments at all.
   */
  images: ConversationPeekImage[]
}

/**
 * The empty answer for a runtime that cannot report at all — a plain shell,
 * OpenCode, Muse. A runtime that reports but has nothing yet answers with its
 * own `source` and an empty `first`/`since` instead, so the card never says
 * "this runtime doesn't report its messages" about Claude Code.
 */
export function emptyConversationPeek(sessionId: string): ConversationPeek {
  return { sessionId, source: 'none', first: null, since: [], images: [] }
}
