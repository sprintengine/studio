import React, { memo } from 'react'

import { CloseIconButton, IconButton, Input, LinkButton } from '../../ui'
import { ChevronIcon } from '../../terminal/TerminalFindBar'
import { CONVERSATION_FIND_ATTRIBUTE } from './conversationFind'

/**
 * Find in this chat (`chat.find`): the terminal's find bar, over a transcript.
 *
 * Floated over the top-right of the transcript for the reason the terminal's
 * is: it has to be on screen with the rows it is marking. Enter walks forward
 * and Shift+Enter back, Escape closes, as in every find bar in the app. The
 * count is of the rows the chat has loaded; with earlier history still on the
 * server it says so and offers to load it, rather than claim a count it has
 * not seen.
 */
export type ConversationFind = {
  open: boolean
  query: string
  /** The match the find is on (0-based) and how many there are; -1 with none. */
  index: number
  count: number
  setQuery: (query: string) => void
  findNext: () => void
  findPrevious: () => void
  close: () => void
  inputRef: React.RefObject<HTMLInputElement | null>
  /** Earlier history not loaded yet, which the count does not include. */
  hasMore: boolean
  loadingEarlier: boolean
  loadEarlier: () => void
}

// Memoised on the find: the chat body redraws with every keystroke in the
// composer and every streamed token, and the bar changes only when the find does.
export const ConversationFindBar = memo(function ConversationFindBar({ find }: { find: ConversationFind }) {
  if (!find.open) return null
  const status = find.query.trim()
    ? find.count === 0
      ? 'No results'
      : `${find.index < 0 ? 0 : find.index + 1} of ${find.count}`
    : ''
  return (
    <div
      // In-canvas floating chrome over the transcript, which is what
      // `--z-float` names; it clears the drop overlay the chat draws.
      className="absolute right-3 top-3 z-[var(--z-float)] flex items-center gap-1 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-1.5 py-1 shadow-[var(--shadow-popover)]"
      role="search"
      aria-label="Find in chat"
      {...{ [CONVERSATION_FIND_ATTRIBUTE]: '' }}
    >
      <Input
        ref={find.inputRef}
        size="xs"
        variant="quiet"
        fullWidth={false}
        aria-label="Find in chat"
        placeholder="Find"
        spellCheck={false}
        autoComplete="off"
        className="w-[11rem]"
        value={find.query}
        onChange={(event) => find.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            find.close()
            return
          }
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
          event.preventDefault()
          if (event.shiftKey) find.findPrevious()
          else find.findNext()
        }}
      />
      <span
        aria-live="polite"
        className="min-w-[4rem] shrink-0 text-center text-meta tabular-nums text-[color:var(--text-muted)]"
      >
        {status}
      </span>
      {find.hasMore && find.query.trim() ? (
        <LinkButton ink="quiet" disabled={find.loadingEarlier} onClick={find.loadEarlier}>
          {find.loadingEarlier ? 'Loading…' : 'Search earlier'}
        </LinkButton>
      ) : null}
      <IconButton aria-label="Previous match" size="xs" disabled={find.count === 0} onClick={find.findPrevious}>
        <ChevronIcon direction="up" />
      </IconButton>
      <IconButton aria-label="Next match" size="xs" disabled={find.count === 0} onClick={find.findNext}>
        <ChevronIcon direction="down" />
      </IconButton>
      <CloseIconButton aria-label="Close find" size="xs" onClick={find.close} />
    </div>
  )
})
