import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { StudioTerminal } from '../utils/createStudioTerminal'
import { registerMountedTerminalFind } from '../utils/terminalFind'
import type { TerminalSearchHandle, TerminalSearchResults } from '../utils/terminalSearch'

/**
 * Find in this pane, for any of the three terminal panes.
 *
 * One hook rather than three copies: the panes differ in where their bytes come
 * from, not in what searching their scrollback means, and a find bar that
 * behaved differently in an agent pane than in a shell would be the same kind
 * of silent divergence `createStudioTerminal` was built to end.
 *
 * The pane supplies a ref to its `StudioTerminal` (set in the effect that
 * builds it, cleared in that effect's teardown) rather than the terminal
 * itself, because the terminal is created asynchronously relative to render and
 * is replaced whenever that effect re-runs. The search addon is loaded on the
 * first find, never at mount.
 */
export type TerminalFind = {
  open: boolean
  query: string
  results: TerminalSearchResults
  setQuery: (query: string) => void
  findNext: () => void
  findPrevious: () => void
  clearActive: () => void
  close: () => void
  inputRef: React.RefObject<HTMLInputElement>
}

export type UseTerminalFindInput = {
  /** Null for a pane that belongs to no workspace — see `MountedTerminalFind`. */
  workspaceId: string | null
  /** The pane's outer element, used to decide whether this pane holds the keyboard. */
  containerRef: React.RefObject<HTMLElement | null>
  /** The pane's live terminal, or null before it exists / after teardown. */
  terminalRef: React.RefObject<StudioTerminal | null>
}

const NO_RESULTS: TerminalSearchResults = { index: -1, count: 0 }

export function useTerminalFind({
  workspaceId,
  containerRef,
  terminalRef,
}: UseTerminalFindInput): TerminalFind {
  const [open, setOpen] = useState(false)
  const [query, setQueryState] = useState('')
  const [results, setResults] = useState<TerminalSearchResults>(NO_RESULTS)
  const inputRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<TerminalSearchHandle | null>(null)
  // Which terminal the cached handle belongs to. The pane's mount effect
  // re-runs on plenty of ordinary changes (a workspace folder resolving, a
  // session reattaching) and builds a NEW terminal each time; a handle cached
  // by presence alone would go on addressing the disposed one, and the find bar
  // would silently search a terminal that is no longer on screen.
  const searchOwnerRef = useRef<StudioTerminal | null>(null)
  const queryRef = useRef('')

  // The handle is resolved on demand and cached per terminal instance. Holding
  // it in state instead would re-render the pane the first time anyone typed.
  const search = useCallback((): TerminalSearchHandle | null => {
    const studioTerminal = terminalRef.current
    if (!studioTerminal) {
      searchRef.current = null
      searchOwnerRef.current = null
      return null
    }
    if (!searchRef.current || searchOwnerRef.current !== studioTerminal) {
      searchRef.current = studioTerminal.loadSearch()
      searchOwnerRef.current = studioTerminal
    }
    return searchRef.current
  }, [terminalRef])

  const runFind = useCallback((direction: 'next' | 'previous') => {
    const handle = search()
    const term = queryRef.current
    if (!handle || !term) {
      setResults(NO_RESULTS)
      return
    }
    if (direction === 'next') handle.findNext(term)
    else handle.findPrevious(term)
  }, [search])

  const setQuery = useCallback((next: string) => {
    queryRef.current = next
    setQueryState(next)
    if (!next) {
      search()?.clear()
      setResults(NO_RESULTS)
      return
    }
    // Typing walks forward from where the caret is, the way every find field
    // does — a person types three characters and expects to be looking at the
    // first hit, not to have to press Enter to start.
    runFind('next')
  }, [runFind, search])

  const close = useCallback(() => {
    setOpen(false)
    // Highlights belong to the open find. Left behind, they would decorate a
    // pane whose find bar is gone and which offers no way to clear them.
    search()?.clear()
    setResults(NO_RESULTS)
    // The keyboard goes back where the user was working.
    terminalRef.current?.terminal.focus()
  }, [search, terminalRef])

  const openFind = useCallback(() => {
    setOpen(true)
    // After paint, and select-all: pressing the shortcut again with the bar
    // already open is how a person restarts a search, so the existing query is
    // kept but replaced by the next keystroke.
    window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [])

  // Results come from the addon, not from the call site: `findNext` reports
  // only whether it matched, while the "3 of 12" a person reads is the
  // decoration pass's own count, which arrives afterwards.
  useEffect(() => {
    if (!open) return
    const handle = search()
    if (!handle) return
    const subscription = handle.onResults(setResults)
    return () => subscription.dispose()
  }, [open, search])

  // Registered while mounted, not while open: the whole point is that the
  // command can OPEN a bar that is currently closed.
  useEffect(() => {
    return registerMountedTerminalFind({
      workspaceId,
      isFocused: () => {
        const container = containerRef.current
        const active = document.activeElement
        return Boolean(container && active && container.contains(active))
      },
      openFind,
    })
  }, [containerRef, openFind, workspaceId])

  return useMemo((): TerminalFind => ({
    open,
    query,
    results,
    setQuery,
    findNext: () => runFind('next'),
    findPrevious: () => runFind('previous'),
    clearActive: () => search()?.clearActive(),
    close,
    inputRef,
  }), [close, open, query, results, runFind, search, setQuery])
}
