import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { LegendListRef } from '@legendapp/list/react'

import { revealMatch } from '../../../utils/revealMatch'
import {
  NO_CHAT_FIND_RESULTS,
  chatFindQuery,
  chatFindStatus,
  findInChat,
  firstMatchFrom,
  occurrences,
  reconcileMatch,
  stepMatch,
  type ChatFindMatch,
  type ChatFindResults,
} from './chatFind'
import { clearChatFind, paintChatFind, renderedSegments, segmentRanges } from './chatFindHighlight'
import type { ConversationTimelineRow } from './conversationTimeline'

/**
 * Find in chat (`chat.find`, ⌘F from the transcript or the composer): the
 * state behind the chat's find bar, and the work of taking the reader to a
 * match. What is searched, and what is not, is chatFind.ts's to say.
 */
export type ChatFind = {
  open: boolean
  query: string
  status: string
  hasMatches: boolean
  setQuery: (query: string) => void
  findNext: () => void
  findPrevious: () => void
  openFind: () => void
  close: () => void
  inputRef: RefObject<HTMLInputElement | null>
}

export type UseChatFindInput = {
  rows: readonly ConversationTimelineRow[]
  listRef: RefObject<LegendListRef | null>
  /** The transcript, whose drawn rows are painted. */
  transcriptRef: RefObject<HTMLElement | null>
  /** The whole chat; focus inside it when the bar opens is where Esc returns it. */
  shellRef: RefObject<HTMLElement | null>
  /** Scroll a row that is not drawn yet into view (the turn minimap's landing). */
  jumpToRow: (index: number, id: string) => void
  /** Stop following the stream, so a landing is not scrolled away from by the next token. */
  pauseFollowing: () => void
  /** Where the keyboard goes on close when the element it came from is gone. */
  focusFallback: () => void
}

// A keystroke's worth of quiet before a search runs: typing a word should
// search for the word, not for each of its prefixes in turn.
const QUERY_DEBOUNCE_MS = 120
// A reply streams a token at a time, and every token is a new set of rows. The
// count keeps up at this pace rather than at the stream's.
const RECOUNT_THROTTLE_MS = 300

type Current = { match: ChatFindMatch | null; index: number; query: string }
const NO_CURRENT: Current = { match: null, index: -1, query: '' }

export function useChatFind(input: UseChatFindInput): ChatFind {
  const [open, setOpen] = useState(false)
  const [query, setQueryState] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchedRows, setSearchedRows] = useState(input.rows)
  const [index, setIndex] = useState(-1)
  // Bumped by each ⌘F; the field takes focus once the bar has rendered.
  const [focusRequest, setFocusRequest] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const latest = useRef(input)
  latest.current = input
  // The match the reader is on, by what it is: the index alone would point at
  // another match once a recount shifts the list.
  const currentRef = useRef<Current>(NO_CURRENT)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  // Set by a step, cleared once the landing has been drawn and scrolled to: a
  // repaint for any other reason (a token, a scroll) must not move the reader.
  const landingRef = useRef(false)
  const paintedCurrentRef = useRef<{ range: Range | null; element: Element | null }>({ range: null, element: null })
  const owner = useRef({}).current

  // The rows a find counts, at most once per throttle window, and only while
  // the bar is open: a closed find costs a streaming chat nothing.
  const lastRecountRef = useRef(0)
  useEffect(() => {
    if (!open) return
    const wait = lastRecountRef.current + RECOUNT_THROTTLE_MS - Date.now()
    const take = () => {
      lastRecountRef.current = Date.now()
      setSearchedRows(latest.current.rows)
    }
    if (wait <= 0) {
      take()
      return
    }
    const timer = setTimeout(take, wait)
    return () => clearTimeout(timer)
  }, [open, input.rows])

  useEffect(() => {
    const folded = chatFindQuery(query)
    // Emptying the field clears at once; only a search waits.
    if (!folded) {
      setSearchQuery('')
      return
    }
    const timer = setTimeout(() => setSearchQuery(folded), QUERY_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  const results = useMemo(
    (): ChatFindResults => (open && searchQuery ? findInChat(searchedRows, searchQuery) : NO_CHAT_FIND_RESULTS),
    [open, searchQuery, searchedRows],
  )
  // Read by the frame callbacks below, which run after the render that set them.
  const resultsRef = useRef(results)
  resultsRef.current = results
  const searchQueryRef = useRef(searchQuery)
  searchQueryRef.current = searchQuery

  // ── Painting ──────────────────────────────────────────────────────────────

  const bringIntoView = useCallback(() => {
    const list = latest.current.listRef.current
    const scroller = list?.getScrollableNode()
    const target = paintedCurrentRef.current.range ?? paintedCurrentRef.current.element
    if (!list || !scroller || !target) return
    const rect = target.getBoundingClientRect()
    const view = scroller.getBoundingClientRect()
    // A match already comfortably on screen stays where it is; one at the very
    // edge, or off it, is brought to the upper third, where the eye starts.
    const margin = Math.min(view.height / 6, 48)
    if (rect.top >= view.top + margin && rect.bottom <= view.bottom - margin) return
    const offset = scroller.scrollTop + rect.top - view.top - view.height / 3
    void list.scrollToOffset({ offset: Math.max(0, offset), animated: false })
  }, [])

  const paint = useCallback(() => {
    const root = latest.current.transcriptRef.current
    const folded = resultsRef.current.matches.length ? searchQueryRef.current : ''
    if (!root || !folded) {
      clearChatFind(owner)
      paintedCurrentRef.current = { range: null, element: null }
      return
    }
    const match = currentRef.current.match
    const all: Range[] = []
    let range: Range | null = null
    let element: Element | null = null
    for (const [key, elements] of renderedSegments(root)) {
      const ranges = segmentRanges(elements, folded)
      all.push(...ranges)
      if (!match || key !== match.segment) continue
      element = elements[0] ?? null
      // The index counted this segment from its text; the page drew it. When
      // the two agree the occurrence is the same one; when they do not (a path
      // drawn as a chip with only its name) the landing is the segment, and
      // no single match claims to be the current one.
      const counted = occurrences(resultsRef.current.segments.get(key) ?? '', folded).length
      if (ranges.length === counted) range = ranges[match.ordinal] ?? null
    }
    paintChatFind(owner, all, range)
    paintedCurrentRef.current = { range, element }
    if (!landingRef.current || !element) return
    landingRef.current = false
    // Open whatever folds the match away, then scroll once the fold has laid
    // out: the frame after next, when the opened height is real.
    if (range) revealMatch(range.startContainer)
    requestAnimationFrame(() => requestAnimationFrame(bringIntoView))
  }, [bringIntoView, owner])

  const frameRef = useRef(0)
  const schedulePaint = useCallback(() => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      paint()
    })
  }, [paint])

  // The rows on screen change under the find — a scroll draws new ones, the
  // list recycles a container for another row, a token lands — and each change
  // is a repaint, coalesced to a frame. Only while there is something to paint.
  const painting = open && results.matches.length > 0
  useEffect(() => {
    const root = input.transcriptRef.current
    if (!painting || !root || typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(schedulePaint)
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [painting, input.transcriptRef, schedulePaint])

  useEffect(() => {
    schedulePaint()
  }, [results, index, schedulePaint])

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      clearChatFind(owner)
    },
    [owner],
  )

  // ── Moving ────────────────────────────────────────────────────────────────

  const goTo = useCallback(
    (target: number) => {
      const match = resultsRef.current.matches[target] ?? null
      currentRef.current = { match, index: match ? target : -1, query: searchQueryRef.current }
      setIndex(match ? target : -1)
      if (!match) return
      landingRef.current = true
      const { transcriptRef, rows } = latest.current
      const drawn = transcriptRef.current ? renderedSegments(transcriptRef.current).has(match.segment) : false
      if (drawn) {
        latest.current.pauseFollowing()
      } else {
        // Not drawn: the list brings the row in first, and the repaint its
        // rows trigger finishes the landing on the match itself.
        const rowIndex = rows.findIndex((row) => row.id === match.rowId)
        if (rowIndex >= 0) latest.current.jumpToRow(rowIndex, match.rowId)
        // A row gone between the count and the step (a rewind) has nowhere to
        // land; a later repaint must not land for it.
        else landingRef.current = false
      }
      schedulePaint()
    },
    [schedulePaint],
  )

  // A new set of matches is either a new search — start at the first match at
  // or below what the reader is looking at — or a recount of the same one,
  // which keeps the reader on the match they were on and moves nothing.
  useEffect(() => {
    const previous = currentRef.current
    if (results.matches.length === 0) {
      currentRef.current = { ...NO_CURRENT, query: searchQuery }
      setIndex(-1)
      return
    }
    const start = latest.current.listRef.current?.getState().start
    const fromView = firstMatchFrom(results.matches, Number.isFinite(start) ? Math.max(0, start!) : 0)
    if (previous.query !== searchQuery) {
      goTo(fromView)
      return
    }
    // A query that had nothing until the stream wrote it: the first match from
    // the reader's place is current, but the reader is not moved to it.
    const kept = previous.match ? reconcileMatch(previous.match, previous.index, results.matches) : fromView
    currentRef.current = { match: results.matches[kept] ?? null, index: kept, query: searchQuery }
    setIndex(kept)
  }, [results, searchQuery, goTo])

  const step = useCallback(
    (direction: 1 | -1) => {
      // Enter inside the debounce searches now; the new search lands on its
      // first match, which is where a step from nothing would go anyway.
      const folded = chatFindQuery(inputRef.current?.value ?? '')
      if (folded !== searchQueryRef.current) {
        setSearchQuery(folded)
        return
      }
      const count = resultsRef.current.matches.length
      if (count) goTo(stepMatch(currentRef.current.index, count, direction))
    },
    [goTo],
  )

  // ── Opening and closing ───────────────────────────────────────────────────

  const openFind = useCallback(() => {
    const active = document.activeElement
    if (
      active instanceof HTMLElement &&
      active !== inputRef.current &&
      latest.current.shellRef.current?.contains(active)
    )
      returnFocusRef.current = active
    // Counted from the rows as they are now, not as they were when the bar
    // last closed.
    lastRecountRef.current = Date.now()
    setSearchedRows(latest.current.rows)
    setOpen(true)
    setFocusRequest((count) => count + 1)
  }, [])

  // Focus and select-all once the bar is committed: pressing the shortcut
  // again with the bar already open is how a person restarts a search, so the
  // existing query is kept but replaced by the next keystroke. An effect, not
  // a frame callback: the command arrives as a custom event, which React
  // renders at default priority, and the chat view is large enough that its
  // render can still be running when the next frame comes.
  useEffect(() => {
    if (!focusRequest) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusRequest])

  const close = useCallback(() => {
    setOpen(false)
    // Highlights belong to the open find; the query stays for the next ⌘F.
    clearChatFind(owner)
    currentRef.current = NO_CURRENT
    landingRef.current = false
    setIndex(-1)
    const back = returnFocusRef.current
    returnFocusRef.current = null
    if (back?.isConnected) back.focus()
    else latest.current.focusFallback()
  }, [owner])

  return useMemo(
    (): ChatFind => ({
      open,
      query,
      status: chatFindStatus(searchQuery, index, results),
      hasMatches: results.matches.length > 0,
      setQuery: setQueryState,
      findNext: () => step(1),
      findPrevious: () => step(-1),
      openFind,
      close,
      inputRef,
    }),
    [open, query, searchQuery, index, results, step, openFind, close],
  )
}
