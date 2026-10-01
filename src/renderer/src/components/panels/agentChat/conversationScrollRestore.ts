import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationScrollMemory } from './conversationViewState'

// How far back a remembered row is looked for. The first snapshot holds ten
// turns and each page ten more, so this is a few hundred turns of history —
// past it the row is far more likely gone (rewound, or an optimistic id that
// never persisted) than still waiting, and walking the rest of a long log to
// find that out is a stream of fetches behind a screen that is not moving.
export const MAX_RESTORE_PAGES = 30

// Keys that move a scroller. Pressed while a restore is still paging, they
// are the reader taking over, and the restore must not yank them back.
const NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
  )
}

/**
 * Puts a remounted conversation back where it was left. A remembered anchor
 * may be older than the initial ten-turn snapshot, so older pages are loaded
 * until its row exists; a row that is gone for good (the transcript changed
 * under it) falls back to the end, where a conversation opens anyway. A saved
 * `atEnd` needs nothing here: the list starts at the end and follows it.
 *
 * Any wheel, touch, press or scrolling key inside `scrollRoot` while the restore
 * is under way cancels it — the reader has started reading, and a position
 * applied after that would move the page out from under them.
 *
 * `isRestoring` is true until the position is applied or given up; the view
 * does not remember scroll positions while it is, since those are the
 * restore's own intermediate jumps rather than anywhere the reader chose.
 */
export function useConversationScrollRestore(input: {
  memory?: ConversationScrollMemory
  hydrated: boolean
  searching: boolean
  hasMore: boolean
  loadingEarlier: boolean
  rows: readonly { id: string }[]
  loadEarlier: () => Promise<void>
  restore: (index: number, offset: number) => void
  /** Where a restore that cannot find its row lands instead. */
  fallbackToEnd?: () => void
  /** The transcript's container, whose input cancels a restore in progress. Read once mounted. */
  scrollRoot?: () => HTMLElement | null
}): { isRestoring: () => boolean } {
  const done = useRef(!input.memory?.rowId || input.memory.atEnd)
  const pages = useRef(0)
  const [fetching, setFetching] = useState(false)
  const latest = useRef(input)
  latest.current = input
  const giveUp = useCallback((fallback: boolean) => {
    done.current = true
    if (fallback) latest.current.fallbackToEnd?.()
  }, [])

  useEffect(() => {
    const root = latest.current.scrollRoot?.()
    if (done.current || !root) return
    const cancel = (event: Event) => {
      if (event instanceof KeyboardEvent && (!NAVIGATION_KEYS.has(event.key) || isEditable(event.target))) return
      done.current = true
      detach()
    }
    const events = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const
    const detach = () => {
      for (const type of events) root.removeEventListener(type, cancel, true)
    }
    for (const type of events) root.addEventListener(type, cancel, { capture: true, passive: true })
    return detach
  }, [])

  useEffect(() => {
    const current = latest.current
    if (done.current || !current.hydrated) return
    if (current.searching) {
      // A search jump owns the scroll position now.
      done.current = true
      return
    }
    if (current.loadingEarlier || fetching) return
    const index = current.rows.findIndex((row) => row.id === current.memory!.rowId)
    if (index >= 0) {
      const frame = requestAnimationFrame(() => {
        if (done.current) return
        done.current = true
        latest.current.restore(index, current.memory!.offset)
      })
      return () => cancelAnimationFrame(frame)
    }
    if (!current.hasMore || pages.current >= MAX_RESTORE_PAGES) {
      const frame = requestAnimationFrame(() => {
        if (!done.current) giveUp(true)
      })
      return () => cancelAnimationFrame(frame)
    }
    pages.current += 1
    setFetching(true)
    void current
      .loadEarlier()
      .catch(() => giveUp(true))
      .finally(() => setFetching(false))
    return undefined
  }, [input.hydrated, input.searching, input.loadingEarlier, input.hasMore, input.rows, fetching, giveUp])

  return { isRestoring: useCallback(() => !done.current, []) }
}
