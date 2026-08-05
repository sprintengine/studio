import React from 'react'
import { StatusDot } from './StatusDot'
import { FOCUS_RING_CLASS, type Tone } from './tokens'

type InboxRowProps = {
  /** Leading dot tone. Use `neutral` when the row has no live state. */
  tone?: Tone
  /** Hide the leading status dot — use when the row carries status another way
   *  (e.g. colour-coded title text), so it stays a single status idiom. */
  hideDot?: boolean
  /** Leading slot — overrides the status dot. Pass a `LifecycleGlyph` when the
   *  row's status is a worklist stage (todo / in review / done …) rather than
   *  live state, so it reads by shape and matches the board columns. */
  leading?: React.ReactNode
  /** Primary line — sentence case, no uppercase tracking. */
  title: React.ReactNode
  /** Single supporting line. Keep to ≤ ~80 chars; truncate beyond that. */
  supporting?: React.ReactNode
  /** Trailing slot (timestamp, count, status). Display-only — do not nest
   *  buttons, links, or other interactive elements here when `onSelect` is set,
   *  because the row itself renders as a `<button>` and nested interactives are
   *  invalid HTML. */
  trailing?: React.ReactNode
  /** Visual selection. A neutral --bg-selected fill plus an ink lift on the
   *  title — never the accent, and never a left bar
   *  (`design-system/patterns/selection.html`). On a multi-pane surface, mark
   *  each list with `data-selection-pane` and the row drops to the resting
   *  tier whenever its pane is not the one holding focus. */
  selected?: boolean
  /** Row is interactive (renders as button). Default true when onSelect is set.
   *  Receives the click event so callers can read modifier keys (shift/meta) for
   *  range- and multi-select. */
  onSelect?: (event: React.MouseEvent) => void
  /** Disable interaction without removing the row from layout. */
  disabled?: boolean
  /** Aria-label override; required when title is non-text. */
  ariaLabel?: string
  /** Optional id for aria-activedescendant patterns. */
  id?: string
}

export function InboxRow({
  tone = 'neutral',
  hideDot = false,
  leading,
  title,
  supporting,
  trailing,
  selected = false,
  onSelect,
  disabled = false,
  ariaLabel,
  id,
}: InboxRowProps) {
  const interactive = Boolean(onSelect) && !disabled
  const Element = interactive ? 'button' : 'div'

  const content = (
    <>
      {leading ? (
        <span className="mt-0.5 shrink-0">{leading}</span>
      ) : hideDot ? null : (
        <StatusDot tone={tone} className="mt-1" />
      )}
      <div className="min-w-0 flex-1">
        {/* The ink lift is the selection's second channel, so an unselected
            title has to sit below the lifted one: --text-default resting,
            --text-strong selected. In a pane that is not the one holding
            focus, the selection-tier rules in assets/index.css rebind
            --text-strong on this row and the lift drops back out. */}
        <div
          // `body` (13px), per design-system/components/inbox-row (MC-2118).
          // Title and supporting line both shipped at `meta`, which collapsed
          // the step between them — the row's primary content read at the same
          // size as the text explaining it.
          className={`truncate text-body font-medium ${
            selected ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'
          }`}
        >
          {title}
        </div>
        {supporting ? (
          <div className="truncate text-meta text-[color:var(--text-muted)]">{supporting}</div>
        ) : null}
      </div>
      {trailing ? (
        <div className="shrink-0 tabular-nums text-micro text-[color:var(--text-muted)]">{trailing}</div>
      ) : null}
    </>
  )

  const className = [
    'group flex w-full items-start gap-2 px-3 py-2 text-left transition-colors',
    // Selection is the neutral fill plus the title's ink lift, and nothing
    // else. The state is carried to AT by aria-current below — which is also
    // what the resting tier keys off.
    selected ? 'bg-[color:var(--bg-selected)]' : '',
    interactive ? 'cursor-pointer' : '',
    // Hover is skipped on the selected row: --bg-hover sits below --bg-selected,
    // so letting it win would dim the row the pointer is over.
    interactive && !selected ? 'hover:bg-[color:var(--bg-hover)]' : '',
    disabled ? 'cursor-not-allowed opacity-50' : '',
    interactive ? FOCUS_RING_CLASS : '',
  ].join(' ')

  if (Element === 'button') {
    return (
      <button
        type="button"
        id={id}
        aria-label={ariaLabel}
        aria-current={selected ? 'true' : undefined}
        disabled={disabled}
        onClick={onSelect}
        className={className}
      >
        {content}
      </button>
    )
  }

  return (
    <div id={id} aria-label={ariaLabel} aria-current={selected ? 'true' : undefined} className={className}>
      {content}
    </div>
  )
}
