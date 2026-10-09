import React from 'react'

import { TERMINAL_CHROME_ATTRIBUTE } from '../../utils/keyboard'
import { FindBar } from '../find/FindBar'
import type { TerminalFind } from '../../hooks/useTerminalFind'

/**
 * Find in this pane.
 *
 * A strip floated over the top-right of a terminal, not a panel in a tab: it
 * has to be on screen at the same time as the buffer it is highlighting, and a
 * search elsewhere would take that buffer off screen to show itself. "Search
 * in Files" (the search palette's Text tab, ⌘⇧F) is the overlay one, because a
 * ripgrep sweep of the workspace folder produces rows you navigate AWAY to.
 */
export function TerminalFindBar({ find }: { find: TerminalFind }) {
  if (!find.open) return null

  const status = find.query
    ? find.results.count === 0
      ? 'No results'
      : `${find.results.index + 1} of ${find.results.count}`
    : ''

  return (
    <FindBar
      label="Find in terminal"
      query={find.query}
      onQueryChange={find.setQuery}
      status={status}
      hasMatches={find.results.count > 0}
      onNext={find.findNext}
      onPrevious={find.findPrevious}
      onClose={find.close}
      // The addon's own guidance: drop the ACTIVE match decoration when the
      // field loses focus, so the selection underneath becomes visible.
      onBlur={find.clearActive}
      inputRef={find.inputRef}
      // The pane's container carries NATIVE mousedown/mouseup/click/keydown/
      // copy/paste/contextmenu listeners that focus the terminal and route the
      // clipboard. A React `stopPropagation()` cannot stop them — React
      // dispatches at the tree root, by which point they have already run — so
      // the bar marks itself instead and those handlers step aside. Without
      // this, clicking into the field hands the keyboard straight back to
      // xterm on the very next mouseup.
      rootAttributes={{ [TERMINAL_CHROME_ATTRIBUTE]: '' }}
    />
  )
}
