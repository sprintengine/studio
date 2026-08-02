import React from 'react'

import { FOCUS_RING_CLASS, FOCUS_RING_WITHIN_INPUT_CLASS } from './tokens'

// InboxSearchInput — the 28 px search input used at the top of inbox-style
// list panes. Owns the 5 px radius, hairline border, magnifier glyph, and
// the trailing clear affordance. Callers own value/onChange and the
// accessible label so the same chrome can serve any "search this list" use.

type InboxSearchInputProps = {
  value: string
  onChange: (next: string) => void
  ariaLabel: string
  placeholder?: string
  clearAriaLabel?: string
  autoFocus?: boolean
}

export function InboxSearchInput({
  value,
  onChange,
  ariaLabel,
  placeholder,
  clearAriaLabel = 'Clear search',
  autoFocus = false,
}: InboxSearchInputProps) {
  return (
    <div
      className={[
        'flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[5px] border border-[color:var(--border-default)]',
        // `--bg-field`, not the raised tone directly: identical on an opaque
        // window, translucent under glass so a field sitting in the chrome is made
        // of the same material as the bar around it (assets/index.css).
        'bg-[color:var(--bg-field)] px-2 text-meta',
        // The field is a composite: the input is the tab stop, but the border
        // box a user sees is this wrapper, so the wrapper draws the indicator.
        // Same treatment as every other control, different trigger — the
        // rationale for keying it to the input's own focus rather than
        // `focus-within` is on the constant.
        FOCUS_RING_WITHIN_INPUT_CLASS,
      ].join(' ')}
    >
      <SearchGlyph />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
        placeholder={placeholder}
        autoFocus={autoFocus}
        // Escape with text clears it and consumes the event, so an ancestor
        // keyed off defaultPrevented (a hosting dialog) never also closes on
        // the same press. Chromium's native search-clear does the clearing but
        // leaves the event unconsumed — this makes both halves deterministic.
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || value === '') return
          event.preventDefault()
          onChange('')
        }}
        data-menu-autofocus={autoFocus ? 'true' : undefined}
        // Suppress Chromium's native search clear button so it doesn't double
        // up with the styled clear affordance below (two X's in the field).
        className="min-w-0 flex-1 bg-transparent text-[color:var(--text-default)] outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={clearAriaLabel}
          // 24px hit target with the 10px glyph unchanged: the padding is
          // transparent and pulled back into the field's own right padding so
          // the drawn cross stays where it was.
          className={`-mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-[color:var(--text-muted)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
        >
          <CrossGlyph />
        </button>
      ) : null}
    </div>
  )
}

function SearchGlyph() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 11 11"
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-[color:var(--text-muted)]"
    >
      <circle cx="4.5" cy="4.5" r="3" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M7 7l2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function CrossGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
