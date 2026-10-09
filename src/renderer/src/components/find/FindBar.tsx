import React from 'react'

import { clientPlatform } from '../../clientCapabilities'
import { keydownMatchesKeybindings } from '../../commands/commandDispatcher'
import type { KeybindingPlatform } from '../../commands/keybindings'
import { CloseIconButton, IconButton, Input } from '../ui'

/**
 * The find strip a surface floats over its own top-right corner: a terminal's
 * scrollback, a chat's transcript.
 *
 * One bar for both, because "find in what I am looking at" is one idiom however
 * the matches are found — the xterm search addon for a pane, the transcript's
 * own rows for a chat — and two copies would drift apart on the keys first.
 * What differs is the surface's to supply: what it searches, what the count
 * says, and where the keyboard goes when the bar closes.
 *
 * Composed entirely from kit primitives — `Input` for the field, `IconButton`
 * for the two steps, `CloseIconButton` for the dismiss — so the field, the
 * control height and the focus ring are the ones the rest of the app uses
 * rather than a third set decided here.
 */
export type FindBarProps = {
  /** Names the search region and its field ("Find in terminal"). */
  label: string
  query: string
  onQueryChange: (query: string) => void
  /** What the count reads: "3 of 12", "No results", or nothing before a query. */
  status: string
  /** Whether there is anything to step to; the two step buttons follow it. */
  hasMatches: boolean
  onNext: () => void
  onPrevious: () => void
  onClose: () => void
  onBlur?: () => void
  inputRef: React.RefObject<HTMLInputElement | null>
  /**
   * Markers the host needs on the bar's root — a terminal pane's chrome
   * attribute, which its native listeners step aside for.
   */
  rootAttributes?: Readonly<Record<`data-${string}`, string>>
}

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

function keybindingPlatform(): KeybindingPlatform {
  const platform = clientPlatform()
  return platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : 'linux'
}

export function FindBar({
  label,
  query,
  onQueryChange,
  status,
  hasMatches,
  onNext,
  onPrevious,
  onClose,
  onBlur,
  inputRef,
  rootAttributes,
}: FindBarProps) {
  return (
    <div
      // In-canvas floating chrome over a surface, which is what `--z-float`
      // names. It also clears the drag-target overlay (`z-10`) the panes draw,
      // so the bar stays reachable while a file is being dragged over one.
      className="absolute right-3 top-3 z-[var(--z-float)] flex items-center gap-1 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-1.5 py-1 shadow-[var(--shadow-popover)]"
      role="search"
      aria-label={label}
      {...rootAttributes}
    >
      <Input
        ref={inputRef}
        size="xs"
        variant="quiet"
        fullWidth={false}
        aria-label={label}
        placeholder="Find"
        spellCheck={false}
        autoComplete="off"
        className="w-[11rem]"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
            return
          }
          // Primary+G is the next match in most finds a person has used. Its
          // partner, Primary+Shift+G, is not claimed here: it toggles the Git
          // panel and carries that View menu item's accelerator, so Shift+Enter
          // is the way back.
          if (keydownMatchesKeybindings(event, ['Primary+G'], keybindingPlatform())) {
            event.preventDefault()
            onNext()
            return
          }
          if (event.key !== 'Enter') return
          event.preventDefault()
          // Enter walks forward, Shift+Enter back — the find idiom everywhere
          // else, and the reason the two buttons are a convenience rather than
          // the only way through the matches.
          if (event.shiftKey) onPrevious()
          else onNext()
        }}
        onBlur={onBlur}
      />
      <span
        aria-live="polite"
        className="min-w-[4rem] shrink-0 text-center text-meta tabular-nums text-[color:var(--text-muted)]"
      >
        {status}
      </span>
      <IconButton aria-label="Previous match" size="xs" disabled={!hasMatches} onClick={onPrevious}>
        <ChevronIcon direction="up" />
      </IconButton>
      <IconButton aria-label="Next match" size="xs" disabled={!hasMatches} onClick={onNext}>
        <ChevronIcon direction="down" />
      </IconButton>
      <CloseIconButton aria-label="Close find" size="xs" onClick={onClose} />
    </div>
  )
}
