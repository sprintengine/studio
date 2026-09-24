import type { SessionPrompt } from '../../shared/electron-api'
import type { ConversationPeek, ConversationPeekMessage } from '../../shared/conversation-peek'
import {
  emptyConversationPeek,
  MAX_PEEK_FIRST_CHARS,
  MAX_PEEK_MESSAGE_CHARS,
  MAX_PEEK_MESSAGES,
} from '../../shared/conversation-peek'
import { capPeekText, collapsePeekText } from './text'

/**
 * Answer "what has been said in this chat" for a session the person is
 * hovering.
 *
 * ONE source: the prompts this app captured from the CLI's `UserPromptSubmit`
 * hook (owner ruling 2026-09-24). The peek never opens a CLI's own transcript.
 * A long session's transcript is tens of megabytes of JSONL, and a live one
 * changes size between any two hovers, so no cache could stop every hover from
 * re-parsing all of it on the main thread. The trade was made knowingly: the
 * card shows text only, no pasted images or attached files, and a chat whose
 * prompts this app never saw — one begun before it was watching — shows none.
 *
 * The captured prompts are durable per agent (`agent-prompt-store.ts`), so an
 * app restart or the 30-day sidecar sweep does not empty the card of a chat
 * that is still in the sidebar.
 *
 * Electron-free and I/O-free: the session state arrives as a dependency, so the
 * assembly rules are testable without a runtime.
 */

/**
 * Prompts retained per session: the message that started the chat, plus enough
 * recent ones to fill the thread the card can draw. Anything between the two
 * is dropped as it arrives rather than at render time, so a session that has
 * run for a week costs a fixed handful of strings.
 */
export const MAX_LIVE_PEEK_PROMPTS = MAX_PEEK_MESSAGES + 1

/**
 * `prompts` with `text` appended, trimmed to {@link MAX_LIVE_PEEK_PROMPTS}.
 *
 * The FIRST entry is never dropped. It is the one the card quotes in full, and
 * a card whose "First message" was actually the fiftieth would be worse than
 * one with no first message at all — so the trim eats the second-oldest and
 * leaves the head alone.
 */
export function appendLivePeekPrompt(prompts: SessionPrompt[] | undefined, text: string, at: number): SessionPrompt[] {
  const next = [...(prompts ?? []), { text, at }]
  if (next.length <= MAX_LIVE_PEEK_PROMPTS) return next
  const [first] = next
  return [first, ...next.slice(next.length - (MAX_LIVE_PEEK_PROMPTS - 1))]
}

/** What the terminal runtime knows about a session, and all this module asks of it. */
export type ConversationPeekSessionState = {
  /**
   * True when this runtime reports the person's messages at all — its manifest
   * declares the hook event that carries a prompt. This is what separates
   * "nothing said yet" from "cannot say": a Claude Code chat hovered before its
   * first prompt has nothing to show and must NOT be reported as `none`, or the
   * card tells the reader that Claude Code does not report its messages. False
   * for OpenCode, Muse and a plain shell, which is the only thing `none` is for.
   */
  reportsMessages?: boolean
  /** Prompts captured for this chat, oldest first. */
  prompts: SessionPrompt[]
}

export type ConversationPeekDependencies = {
  /** The session's peek inputs, or null when nothing at all is known about that id. */
  readSessionState(sessionId: string): Promise<ConversationPeekSessionState | null>
}

export type ConversationPeekService = {
  readConversationPeek(sessionId: string): Promise<ConversationPeek>
}

export function createConversationPeekService(deps: ConversationPeekDependencies): ConversationPeekService {
  return {
    async readConversationPeek(sessionId: string): Promise<ConversationPeek> {
      // An unusable id is a caller bug, not a runtime that cannot report — the
      // same reason the missing-state case below is `unknown`.
      if (typeof sessionId !== 'string' || !sessionId) {
        return { sessionId: '', source: 'unknown', first: null, since: [] }
      }
      const state = await deps.readSessionState(sessionId)
      // No state for this id — no live session, no sidecar and no stored
      // prompts. `unknown`, never `none`: we know nothing about this chat's
      // messages, which is not the same as knowing its runtime cannot report
      // them.
      if (!state) return { sessionId, source: 'unknown', first: null, since: [] }

      const captured = capturedPeek(sessionId, state.prompts)
      if (captured) return captured

      // Nothing to show. WHICH nothing matters: a runtime that can report and
      // has not yet keeps the `live` source and an empty body, so the card says
      // "no messages yet" rather than "this runtime doesn't report its
      // messages" about Claude Code. Only a runtime that genuinely cannot
      // report — OpenCode, Muse, a plain shell — is `none`.
      if (state.reportsMessages) return { sessionId, source: 'live', first: null, since: [] }
      return emptyConversationPeek(sessionId)
    },
  }
}

/** The peek built from captured prompts, or null when there are none. */
function capturedPeek(sessionId: string, prompts: SessionPrompt[]): ConversationPeek | null {
  const messages = prompts
    .map((prompt, index) => capturedPeekMessage(prompt, index, index === 0))
    .filter((message): message is ConversationPeekMessage => message !== null)
  if (messages.length === 0) return null
  const [first, ...rest] = messages
  return { sessionId, source: 'live', first, since: rest.slice(-MAX_PEEK_MESSAGES) }
}

function capturedPeekMessage(prompt: SessionPrompt, index: number, isFirst: boolean): ConversationPeekMessage | null {
  if (!prompt || typeof prompt.text !== 'string') return null
  const collapsed = collapsePeekText(prompt.text)
  if (!collapsed.text.trim()) return null
  const capped = capPeekText(collapsed.text, isFirst ? MAX_PEEK_FIRST_CHARS : MAX_PEEK_MESSAGE_CHARS)
  return {
    // Positional. Once the list is at its cap the middle is trimmed and these
    // shift, which is tolerable because nothing resolves an id: it is a React
    // key and nothing more.
    id: `live:${index}`,
    text: capped.text,
    // 0 is the agreed "time unknown" sentinel, not an epoch to subtract from.
    at: typeof prompt.at === 'number' && Number.isFinite(prompt.at) ? prompt.at : 0,
    truncatedChars: capped.truncatedChars + collapsed.overflowChars,
  }
}
