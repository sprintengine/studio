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
  /** Visual selection. Backed by --accent-primary-soft. */
  selected?: boolean
  /** Row is interactive (renders as button). Default true when onSelect is set. */
  onSelect?: () => void
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
        <div className="truncate text-[12px] font-medium text-[color:var(--text-strong)]">
          {title}
        </div>
        {supporting ? (
          <div className="truncate text-[12px] text-[color:var(--text-muted)]">{supporting}</div>
        ) : null}
      </div>
      {trailing ? (
        <div className="shrink-0 tabular-nums text-[11px] text-[color:var(--text-muted)]">{trailing}</div>
      ) : null}
    </>
  )

  const className = [
    'group flex w-full items-start gap-2 px-3 py-2 text-left transition-colors',
    'border-l-2',
    selected
      ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)]'
      : 'border-transparent',
    interactive ? 'cursor-pointer hover:bg-[color:var(--bg-hover)]' : '',
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
