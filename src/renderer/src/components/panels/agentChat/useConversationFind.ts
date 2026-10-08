import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'

import type { ConversationTimelineRow } from './conversationTimeline'
import type { ConversationFind } from './ConversationFindBar'
import {
  chatFindHits,
  clearChatFindHighlights,
  paintChatFindHighlights,
  stepChatFindIndex,
  type ChatFindHit,
} from './conversationFind'
import { setConversationDisclosures } from './conversationViewState'

// How long after going to a match the view keeps trying to bring its words on
// screen: the list scrolls to the row first, and the row may be drawn a frame
// or two later. Past this a repaint (a token streaming in) never moves the view.
const REVEAL_WINDOW_MS = 1_000

// The least time between two searches of a transcript that is changing under
// the find (a reply streaming in): often enough to keep the count and the
// marks current, rarely enough that a long chat does not search per token.
const REPAINT_INTERVAL_MS = 250

/** Exported for its test. `value` while `open`, refreshed at most every REPAINT_INTERVAL_MS, the last change always taken. */
export function useThrottledWhileOpen<T>(value: T, open: boolean): T {
  const [held, setHeld] = useState(value)
  const takenAt = useRef(0)
  useEffect(() => {
    if (!open || held === value) return
    const wait = takenAt.current + REPAINT_INTERVAL_MS - Date.now()
    const take = () => {
      takenAt.current = Date.now()
      setHeld(value)
    }
    if (wait <= 0) {
      take()
      return
    }
    const timer = window.setTimeout(take, wait)
    return () => window.clearTimeout(timer)
  }, [value, open, held])
  return open ? held : value
}

/**
 * The chat's find: its query, its matches in the loaded rows, the one it is on,
 * and the marks on screen (agentChat/conversationFind.ts).
 */
export function useConversationFind(input: {
  /** The chat's `${workspaceId}:${agentId}`: its folds, and its marks, are kept under it. */
  conversationKey: string
  rows: readonly ConversationTimelineRow[]
  transcriptRef: RefObject<HTMLElement | null>
  /** Go to a row as the turn shortcuts do: scroll it to the top, and flash it. */
  jumpToRow: (index: number, id: string) => void
  /** Scroll a row to the top without the flash, for the first match while typing. */
  scrollToRow: (index: number) => void
  hasMore: boolean
  loadingEarlier: boolean
  loadEarlier: () => Promise<void>
  /** Where the keyboard goes when the bar closes. */
  returnFocus: () => void
}): ConversationFind & { openFind: () => void } {
  const [open, setOpen] = useState(false)
  const [query, setQueryState] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const revealUntilRef = useRef(0)
  const latest = useRef(input)
  latest.current = input

  // The rows searched: the chat's own while it is still, and while a reply
  // streams at most one fresh copy every REPAINT_INTERVAL_MS, since every
  // token is a new list and a search walks all of it.
  const searchedRows = useThrottledWhileOpen(input.rows, open)
  const hits = useMemo(() => (open ? chatFindHits(searchedRows, query) : []), [open, searchedRows, query])
  // Rows streaming in can take matches away; the find stays on the last one.
  const index = hits.length === 0 ? -1 : Math.min(Math.max(activeIndex, 0), hits.length - 1)
  const activeHit: ChatFindHit | null = index >= 0 ? (hits[index] ?? null) : null
  const activeRowId = activeHit?.rowId ?? null
  const activeOccurrence = activeHit?.occurrence ?? 0

  const goTo = useCallback((hit: ChatFindHit, quietly: boolean) => {
    const { conversationKey, jumpToRow, scrollToRow } = latest.current
    // Behind its turn's fold, or a group of steps in it: opened first, so the
    // words are there to mark.
    if (hit.opens.length) setConversationDisclosures(conversationKey, hit.opens, true)
    if (quietly) scrollToRow(hit.rowIndex)
    else jumpToRow(hit.rowIndex, hit.rowId)
    revealUntilRef.current = Date.now() + REVEAL_WINDOW_MS
  }, [])

  const setQuery = useCallback(
    (next: string) => {
      setQueryState(next)
      // As in a browser's find, the first match is gone to as the words are typed.
      const first = chatFindHits(latest.current.rows, next)[0]
      setActiveIndex(first ? 0 : -1)
      if (first) goTo(first, true)
    },
    [goTo],
  )

  const step = useCallback(
    (direction: 1 | -1) => {
      const nextIndex = stepChatFindIndex(index, hits.length, direction)
      const hit = hits[nextIndex]
      if (!hit) return
      setActiveIndex(nextIndex)
      goTo(hit, false)
    },
    [index, hits, goTo],
  )

  // Each open, a press of ⌘F with the bar already up included, puts the
  // keyboard in the field. The query is kept between opens and selected, so
  // typing replaces it and Enter goes on through it.
  const [opened, setOpened] = useState(0)
  const openFind = useCallback(() => {
    setOpen(true)
    setOpened((count) => count + 1)
  }, [])
  useEffect(() => {
    if (!opened) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [opened])

  const close = useCallback(() => {
    setOpen(false)
    latest.current.returnFocus()
  }, [])

  // Mark the words drawn now, and again whenever the list draws other rows (a
  // scroll, a row growing as a reply streams): the marks are ranges over text
  // nodes, and a row the list recycles takes its nodes with it.
  const { conversationKey, transcriptRef } = input
  useEffect(() => {
    const root = transcriptRef.current
    if (!open || !root) {
      clearChatFindHighlights(conversationKey)
      return
    }
    let frame = 0
    let timer = 0
    let paintedAt = 0
    const paint = () => {
      frame = 0
      paintedAt = Date.now()
      const current = paintChatFindHighlights(
        conversationKey,
        root,
        query,
        activeRowId === null ? null : { rowId: activeRowId, occurrence: activeOccurrence },
      )
      if (!current || Date.now() > revealUntilRef.current) return
      // The row is at the top of the view; a match far down a long reply is
      // not, and is brought into the middle of it once.
      const box = current.getBoundingClientRect()
      const view = root.getBoundingClientRect()
      if (box.top < view.top || box.bottom > view.bottom)
        current.startContainer.parentElement?.scrollIntoView({ block: 'center' })
      revealUntilRef.current = 0
    }
    const paintNextFrame = () => {
      if (!frame) frame = window.requestAnimationFrame(paint)
    }
    // A reply streaming in changes the transcript's text on every token, and
    // each repaint walks every text node drawn: at most one every
    // REPAINT_INTERVAL_MS, the last change always included.
    const schedule = () => {
      if (timer || frame) return
      const wait = paintedAt + REPAINT_INTERVAL_MS - Date.now()
      if (wait <= 0) paintNextFrame()
      else
        timer = window.setTimeout(() => {
          timer = 0
          paintNextFrame()
        }, wait)
    }
    paintNextFrame()
    const observer = new MutationObserver(schedule)
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
      if (timer) window.clearTimeout(timer)
    }
  }, [open, query, activeRowId, activeOccurrence, conversationKey, transcriptRef])
  useEffect(() => () => clearChatFindHighlights(conversationKey), [conversationKey])

  const findNext = useCallback(() => step(1), [step])
  const findPrevious = useCallback(() => step(-1), [step])
  const loadEarlier = useCallback(() => void latest.current.loadEarlier().catch(() => undefined), [])
  // One object while nothing in it changes: the chat body redraws on every
  // keystroke in the composer, and the bar has nothing to say to one.
  const { hasMore, loadingEarlier } = input
  const count = hits.length
  return useMemo(
    () => ({
      open,
      query,
      index,
      count,
      setQuery,
      findNext,
      findPrevious,
      close,
      inputRef,
      hasMore,
      loadingEarlier,
      loadEarlier,
      openFind,
    }),
    [
      open,
      query,
      index,
      count,
      setQuery,
      findNext,
      findPrevious,
      close,
      hasMore,
      loadingEarlier,
      loadEarlier,
      openFind,
    ],
  )
}
