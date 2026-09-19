import { useCallback, useEffect, useRef, useState } from 'react'

import type { ConversationPeek } from '../../../../shared/conversation-peek'

// Hover intent + the one IPC read behind the conversation peek. Split from the
// card so the two anchors (a sidebar row, an agent tab) share one set of
// timings and one answer, and so neither shell reimplements the dwell.
//
// The main-process half owns everything about WHAT the answer is — which
// runtimes have a transcript, what a `live` peek accumulated, how a message is
// capped. This side asks once per open and renders exactly what came back.

/**
 * The dwell before the card opens. 220ms is the mockup's own number and it is
 * doing real work: a sweep down a sidebar of forty chats crosses every row, and
 * without a dwell it would fire forty cards. Focus skips it — a keyboard user
 * asked for this row explicitly and should not be made to wait.
 */
const PEEK_DWELL_MS = 220

/**
 * Grace after the pointer leaves the anchor or the card. This is a POPOVER, not
 * a tooltip: it holds controls (a copy button, a thumbnail, a file chip), so the
 * pointer has to be able to cross the gap into it. Without this the gap closes
 * the card before it can be reached, which makes those controls unpressable.
 */
const PEEK_CLOSE_GRACE_MS = 140

/**
 * The two calls the preload exposes for this feature, typed here as optional.
 * They may be absent — an older main, a window that never got them — and every
 * consumer treats absence as "the card says it cannot read the conversation"
 * rather than as an error, exactly the way the clipboard bridge is guarded.
 */
type ConversationPeekApi = {
  readConversationPeek?: (sessionId: string) => Promise<ConversationPeek>
  openConversationPeekAttachment?: (sessionId: string, attachmentId: string) => Promise<void>
}

function peekApi(): ConversationPeekApi {
  return (window.api ?? {}) as typeof window.api & ConversationPeekApi
}

function hasReader(): boolean {
  return typeof peekApi().readConversationPeek === 'function'
}

/**
 * The one open peek, app-wide. Mockup frame 3: the tab and the row get the same
 * card and NEVER both at once — and they can each be triggered without the
 * pointer, so neither anchor can police this alone. Focusing a tab and then
 * hovering a sidebar row is exactly the sequence that put two cards on screen.
 *
 * A module-level latch rather than a context: this is a property of the window,
 * every consumer is in the same renderer, and a provider nobody could forget to
 * mount is the point.
 */
let openPeek: (() => void) | null = null

export type ConversationPeekHover = {
  /** Whether the card should be mounted. */
  open: boolean
  /** The answer FOR THIS SESSION, or null while it is in flight. */
  peek: ConversationPeek | null
  /** A read is outstanding. The card shows identity plus a skeleton, never a blank. */
  loading: boolean
  /** Pointer entered the anchor: open after the dwell. */
  openSoon: () => void
  /** Focus landed on the anchor: open now, no dwell. */
  openNow: () => void
  /** Pointer left the anchor or the card: close after the grace period. */
  closeSoon: () => void
  /** Escape, an outside press, or the anchor going away: close immediately. */
  closeNow: () => void
  /** Pointer is resting on the card: cancel the pending close. */
  keepOpen: () => void
  /** Open an attachment, or undefined when the preload has no opener. */
  openAttachment: ((attachmentId: string) => void) | undefined
}

/**
 * Hover intent and reads for one AGENT's peek.
 *
 * `sessionId` is the terminal the card is about. Null means there is nothing to
 * ask about (a chat that never started a session, a row mid-rename) and the
 * hook stays shut; the caller can wire the handlers unconditionally.
 *
 * It may CHANGE while the card is open, and that is ordinary rather than
 * exceptional: a sidebar row lists a chat's agents as sub-lines, and moving the
 * pointer from one to the next moves the card to that agent (one card per
 * agent, 2026-09-09). Which is why the answers below are keyed by session and
 * not cleared when it changes — sweeping back up the lines must not re-stream a
 * transcript that was read a moment ago.
 */
export function useConversationPeek(sessionId: string | null): ConversationPeekHover {
  const [open, setOpen] = useState(false)
  // Answers keyed by session, so switching back to an agent already viewed is
  // instant and never re-streams a transcript. A key present with a `null`
  // value is a read that finished with no answer — which is how `loading` can
  // be derived rather than raced (an effect runs after paint, so a card whose
  // loading flag waited for one painted its "not readable" arm for a frame).
  const [answers, setAnswers] = useState<Map<string, ConversationPeek | null>>(() => new Map())
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  // This instance's own closer, with a stable identity, so the latch above can
  // tell "someone else opened" from "I opened again".
  const selfClose = useRef<() => void>(() => {})

  const clearOpenTimer = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
  }, [])

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  // Opening drops every answer from the previous visit. A card that showed the
  // last visit's messages while quietly re-reading is telling you about a
  // conversation that has moved on since.
  const reveal = useCallback(() => {
    if (openPeek && openPeek !== selfClose.current) openPeek()
    openPeek = selfClose.current
    setAnswers(new Map())
    setOpen(true)
  }, [])

  const openNow = useCallback(() => {
    if (!sessionId) return
    clearOpenTimer()
    clearCloseTimer()
    reveal()
  }, [clearCloseTimer, clearOpenTimer, sessionId, reveal])

  const openSoon = useCallback(() => {
    if (!sessionId) return
    clearCloseTimer()
    if (openTimer.current !== null) return
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null
      reveal()
    }, PEEK_DWELL_MS)
  }, [clearCloseTimer, sessionId, reveal])

  const dismiss = useCallback(() => {
    if (openPeek === selfClose.current) openPeek = null
    setOpen(false)
  }, [])

  const closeNow = useCallback(() => {
    clearOpenTimer()
    clearCloseTimer()
    dismiss()
  }, [clearCloseTimer, clearOpenTimer, dismiss])

  const closeSoon = useCallback(() => {
    clearOpenTimer()
    if (closeTimer.current !== null) return
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      dismiss()
    }, PEEK_CLOSE_GRACE_MS)
  }, [clearOpenTimer, dismiss])

  // The latch holds a stable closer for this instance. Assigned through a ref
  // rather than captured, so `reveal` and `dismiss` stay dependency-free while
  // still closing over the current one.
  selfClose.current = closeNow

  const keepOpen = useCallback(() => {
    clearCloseTimer()
  }, [clearCloseTimer])

  const peek = sessionId ? (answers.get(sessionId) ?? null) : null
  // Derived, never raced: a session with no entry in `answers` is one nobody
  // has finished reading. The `has` check and not the value, so a read that
  // came back empty settles instead of spinning forever.
  const loading = open && sessionId !== null && !answers.has(sessionId) && hasReader()

  // One read per session per opening. Re-reading on a tick would make a card
  // the pointer is resting on flicker between answers; the conversation it
  // describes is not moving fast enough for that to buy anything.
  useEffect(() => {
    if (!open || !sessionId || answers.has(sessionId)) return
    const read = peekApi().readConversationPeek
    if (typeof read !== 'function') return
    let cancelled = false
    const settle = (answer: ConversationPeek | null): void => {
      if (cancelled) return
      setAnswers((previous) => {
        if (previous.has(sessionId)) return previous
        return new Map(previous).set(sessionId, answer)
      })
    }
    read(sessionId)
      .then(settle)
      // Main could not answer. The card keeps its identity half and says the
      // conversation is not readable — never a spinner that never resolves.
      .catch(() => settle(null))
    return () => {
      cancelled = true
    }
  }, [answers, open, sessionId])

  const opener = peekApi().openConversationPeekAttachment
  // Attachments belong to the message that carried them, so they are opened
  // against THIS session — main armed them under that id, and asking under a
  // sibling's would find nothing.
  const openAttachment = useCallback(
    (attachmentId: string) => {
      if (!sessionId || typeof opener !== 'function') return
      void opener(sessionId, attachmentId).catch(() => {
        // The file moved, or the viewer refused it. Nothing to say on a hover
        // surface that is about to close; the chip stays where it is.
      })
    },
    [opener, sessionId],
  )

  return {
    open: open && sessionId !== null,
    peek,
    loading,
    openSoon,
    openNow,
    closeSoon,
    closeNow,
    keepOpen,
    openAttachment: typeof opener === 'function' ? openAttachment : undefined,
  }
}

/** How long the copy button holds its "copied" tick before going back. */
const COPIED_FLASH_MS = 1_200

type ClipboardApi = { clipboardWriteText?: (text: string) => Promise<void> }

/**
 * The session id's copy button, shared by both anchors so the flash lasts the
 * same beat in each. A denied clipboard leaves `copied` false: the id is still
 * on screen and still selectable, and a silent success would be a lie.
 */
export function useCopyValue(value: string | null): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const copy = useCallback(() => {
    if (!value) return
    const write = (window.api as (typeof window.api & ClipboardApi) | undefined)?.clipboardWriteText
    if (typeof write !== 'function') return
    void write(value)
      .then(() => {
        setCopied(true)
        if (timer.current !== null) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), COPIED_FLASH_MS)
      })
      .catch(() => {
        // Clipboard denied. No flash, no toast — the id has not moved.
      })
  }, [value])

  return { copied, copy }
}
