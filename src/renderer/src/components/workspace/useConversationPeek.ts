import { useCallback, useEffect, useRef, useState } from 'react'

// Hover intent behind the conversation peek. Split from the card so the two
// anchors (a sidebar row, an agent tab) share one set of timings, and so
// neither shell reimplements the dwell.
//
// There is no read any more (2026-10-04): everything the card says rides the
// identity its anchor already holds, so opening it costs no round trip.

/**
 * The dwell before the card opens. Long enough that the card is something you
 * ASK for by resting on a row (owner, 2026-10-04): at the old 220ms, moving the
 * pointer across the sidebar on the way somewhere else kept flashing cards up,
 * and a sweep down forty chats fired one per pause. Focus skips it — a keyboard
 * user asked for this row explicitly and should not be made to wait.
 */
const PEEK_DWELL_MS = 600

/**
 * Grace after the pointer leaves the anchor or the card. This is a POPOVER, not
 * a tooltip: it holds a control (the pull request mark), so the pointer has to
 * be able to cross the gap into it. Without this the gap closes
 * the card before it can be reached, which makes those controls unpressable.
 */
const PEEK_CLOSE_GRACE_MS = 140

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
}

/**
 * Hover intent for one AGENT's peek.
 *
 * `sessionId` is the terminal the card is about. Null means there is nothing to
 * ask about (a chat that never started a session, a row mid-rename) and the
 * hook stays shut; the caller can wire the handlers unconditionally.
 *
 * It may CHANGE while the card is open, and that is ordinary rather than
 * exceptional: a sidebar row lists a chat's agents as sub-lines, and moving the
 * pointer from one to the next moves the card to that agent (one card per
 * agent, 2026-09-09). The card simply re-renders on the new identity.
 */
export function useConversationPeek(sessionId: string | null): ConversationPeekHover {
  const [open, setOpen] = useState(false)
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

  const reveal = useCallback(() => {
    if (openPeek && openPeek !== selfClose.current) openPeek()
    openPeek = selfClose.current
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

  // An anchor that goes away (a row settled, a tab closed) takes its timers and
  // its hold on the latch with it: a dwell left running would open a card for
  // nothing, and close whichever card is open now on the way.
  useEffect(
    () => () => {
      clearOpenTimer()
      clearCloseTimer()
      if (openPeek === selfClose.current) openPeek = null
    },
    [clearCloseTimer, clearOpenTimer],
  )

  return {
    open: open && sessionId !== null,
    openSoon,
    openNow,
    closeSoon,
    closeNow,
    keepOpen,
  }
}
