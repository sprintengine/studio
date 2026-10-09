import React from 'react'

import { TERMINAL_CHROME_ATTRIBUTE } from '../../utils/keyboard'
import { CloseIconButton, IconButton, Input } from '../ui'
import type { TerminalFind } from '../../hooks/useTerminalFind'

/**
 * Find in this pane.
 *
 * A strip floated over the top-right of a terminal, not a panel in a tab: it
 * has to be on screen at the same time as the buffer it is highlighting, and a
 * search elsewhere would take that buffer off screen to show itself. "Search
 * in Files" (the search palette's Text tab, ⌘⇧F) is the overlay one, because a
 * ripgrep sweep of the workspace folder produces rows you navigate AWAY to.
 *
 * Composed entirely from kit primitives — `Input` for the field, `IconButton`
 * for the two steps, `CloseIconButton` for the dismiss — so the field, the
 * control height and the focus ring are the ones the rest of the app uses
 * rather than a third set decided here.
 */

function ChevronIcon({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg className="icon-sm" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d={direction === 'up' ? 'M3.5 8.75L7 5.25L10.5 8.75' : 'M3.5 5.25L7 8.75L10.5 5.25'}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function TerminalFindBar({ find }: { find: TerminalFind }) {
  if (!find.open) return null

  const status = find.query
    ? find.results.count === 0
      ? 'No results'
      : `${find.results.index + 1} of ${find.results.count}`
    : ''

  return (
    <div
      // In-canvas floating chrome over a pane, which is what `--z-float` names.
      // It also clears the drag-target overlay (`z-10`) the panes draw, so the
      // bar stays reachable while a file is being dragged over the pane.
      className="absolute right-3 top-3 z-[var(--z-float)] flex items-center gap-1 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-1.5 py-1 shadow-[var(--shadow-popover)]"
      role="search"
      aria-label="Find in terminal"
      // The pane's container carries NATIVE mousedown/mouseup/click/keydown/
      // copy/paste/contextmenu listeners that focus the terminal and route the
      // clipboard. A React `stopPropagation()` cannot stop them — React
      // dispatches at the tree root, by which point they have already run — so
      // the bar marks itself instead and those handlers step aside. Without
      // this, clicking into the field hands the keyboard straight back to
      // xterm on the very next mouseup.
      {...{ [TERMINAL_CHROME_ATTRIBUTE]: '' }}
    >
      <Input
        ref={find.inputRef}
        size="xs"
        variant="quiet"
        fullWidth={false}
        aria-label="Find in terminal"
        placeholder="Find"
        spellCheck={false}
        autoComplete="off"
        className="w-[11rem]"
        value={find.query}
        onChange={(event) => find.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            find.close()
            return
          }
          if (event.key !== 'Enter') return
          event.preventDefault()
          // Enter walks forward, Shift+Enter back — the terminal-find idiom
          // everywhere else, and the reason the two buttons are a convenience
          // rather than the only way through the matches.
          if (event.shiftKey) find.findPrevious()
          else find.findNext()
        }}
        // The addon's own guidance: drop the ACTIVE match decoration when the
        // field loses focus, so the selection underneath becomes visible.
        onBlur={() => find.clearActive()}
      />
      <span
        aria-live="polite"
        className="min-w-[4rem] shrink-0 text-center text-meta tabular-nums text-[color:var(--text-muted)]"
      >
        {status}
      </span>
      <IconButton
        aria-label="Previous match"
        size="xs"
        disabled={find.results.count === 0}
        onClick={() => find.findPrevious()}
      >
        <ChevronIcon direction="up" />
      </IconButton>
      <IconButton aria-label="Next match" size="xs" disabled={find.results.count === 0} onClick={() => find.findNext()}>
        <ChevronIcon direction="down" />
      </IconButton>
      <CloseIconButton aria-label="Close find" size="xs" onClick={() => find.close()} />
    </div>
  )
}
