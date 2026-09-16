import React, { useState } from 'react'
import { StatusDot } from './StatusDot'
import { FOCUS_RING_CLASS, type Tone } from './tokens'

/**
 * TaskCard — the canonical primitive for board-card and inbox-row task surfaces.
 *
 * Two documented variants for the same anatomy. Both consume identical tokens
 * (StatusDot size, identifier font and color, title font weight) so the four
 * panels read as one family even when their layouts differ:
 *
 * - `variant="row"` — single line; identifier and title share a baseline; title
 *   truncates to one line; no glyph slot. Used by backlog rows.
 * - `variant="card"` — identifier sits above the title; title clamps to two
 *   lines by default (pass `clampTitle={false}` to wrap fully); optional
 *   trailing glyph slot. Used by kanban cards where identity
 *   information is load-bearing and architect-generated titles are often
 *   descriptive sentences. A board opts out of the clamp so
 *   titles wrap in its thin equal-width lanes instead of truncating.
 *
 * The variance is deliberate: detail-pane vs scan-without-selecting workflows
 * have different content shapes. The shared primitive keeps the anatomy locked.
 *
 * Family-resemblance contract:
 *   - StatusDot leading at 6 px.
 *   - Identifier: `font-mono tabular-nums text-meta text-[color:var(--text-subtle)]`.
 *   - Title: `text-body font-medium`.
 *   - Selected state: neutral `--bg-selected` fill + title ink at
 *     `--text-strong`. No left bar, no border box, no accent.
 *   - Hover: `--bg-hover` only — no shadow, no scale, no glow.
 */
type TaskCardVariant = 'row' | 'card'

export type TaskCardProps = {
  tone: Tone
  /** Streaming pulse on the dot — use only for live-running indicators. */
  pulse?: boolean
  /** Leading status mark. `undefined` keeps the default 6px StatusDot (tone +
   *  pulse). Pass a node (e.g. a LifecycleGlyph) to replace it, or `null` to
   *  render no leading mark — used on kanban cards where the column already
   *  states the status. */
  leading?: React.ReactNode
  identifier: React.ReactNode
  title: React.ReactNode
  supporting?: React.ReactNode
  /** Trailing slot (priority icon, role glyph). Display-only — must not host
   *  interactive elements; the card itself is the interactive surface. */
  trailing?: React.ReactNode
  selected?: boolean
  /** Variant of the card layout. Defaults to `row`. */
  variant?: TaskCardVariant
  /** `card` variant only: clamp the title to two lines. Defaults to `true`.
   *  Pass `false` to let the title wrap to as many lines as it needs — used by
   *  a board whose thin equal-width lanes would otherwise
   *  truncate descriptive titles. */
  clampTitle?: boolean
  onSelect?: () => void
  onContextMenu?: (event: React.MouseEvent<HTMLLIElement>) => void
  /** Drag-and-drop opt-in. When provided, the card becomes a drag source. */
  draggable?: boolean
  onDragStart?: (event: React.DragEvent<HTMLLIElement>) => void
  onDragEnd?: (event: React.DragEvent<HTMLLIElement>) => void
  /** FLIP reorder key for `useFlipReorder`. */
  flipKey?: string
  /** Apply the just-moved highlight keyframe. Pass the desired class:
   *  A list board uses `card-just-moved`; a gate-driven board uses
   *  `card-just-moved-gold`. */
  justMovedClassName?: string
  ariaLabel?: string
}

export function TaskCard({
  tone,
  pulse,
  leading,
  identifier,
  title,
  supporting,
  trailing,
  selected = false,
  variant = 'row',
  clampTitle = true,
  onSelect,
  onContextMenu,
  draggable = false,
  onDragStart,
  onDragEnd,
  flipKey,
  justMovedClassName,
  ariaLabel,
}: TaskCardProps) {
  const [dragging, setDragging] = useState(false)
  const isCard = variant === 'card'

  const handleKeyDown = (event: React.KeyboardEvent<HTMLLIElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect?.()
    }
  }

  // `--task-card-bg` / `--task-card-shadow` let a containing surface re-home the
  // card one elevation step up (e.g. BoardLane `surface` lifts cards to
  // --bg-surface-raised and adds an inset hairline). Both fall back to the
  // default flat-on-canvas card, so callers that don't set them are unaffected.
  const className = [
    'group relative flex items-start gap-2 rounded-sm px-2.5 py-1.5 text-left shadow-[var(--task-card-shadow,none)] transition-colors',
    isCard ? 'w-full' : '',
    FOCUS_RING_CLASS,
    draggable ? (dragging ? 'cursor-grabbing opacity-60' : 'cursor-grab') : 'cursor-pointer',
    justMovedClassName ?? '',
    // Selection is the neutral fill plus the ink lift — no left bar, no accent
    // (`design-system/components/task-card/component.md`). aria-pressed below
    // carries the state for assistive technology.
    selected
      ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
      : `${isCard ? 'bg-[color:var(--task-card-bg,var(--bg-surface))]' : ''} text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]`,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li
      data-task-card={variant}
      data-flip-key={flipKey}
      draggable={draggable}
      tabIndex={onSelect ? 0 : undefined}
      role={onSelect ? 'button' : undefined}
      aria-pressed={onSelect ? selected : undefined}
      aria-label={ariaLabel}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onKeyDown={onSelect ? handleKeyDown : undefined}
      onDragStart={
        draggable
          ? (event) => {
              setDragging(true)
              onDragStart?.(event)
            }
          : undefined
      }
      onDragEnd={
        draggable
          ? (event) => {
              setDragging(false)
              onDragEnd?.(event)
            }
          : undefined
      }
      className={className}
    >
      {leading === undefined ? (
        <StatusDot tone={tone} pulse={pulse} className={isCard ? 'mt-1' : 'mt-1.5'} />
      ) : leading ? (
        <span className={`shrink-0 ${isCard ? 'mt-0.5' : 'mt-[2px]'}`}>{leading}</span>
      ) : null}
      <div className="min-w-0 flex-1">
        {isCard ? (
          <>
            {/* `meta` in `text.subtle`, per design-system/components/task-card
                (MC-2118). The identifier shipped at `micro` and — only on this
                variant — in `text.muted`, so the same identifier read at a
                different weight of ink depending on which variant showed it. */}
            <div className="font-mono tabular-nums text-meta text-[color:var(--text-subtle)]">
              {identifier}
            </div>
            <div
              className={`mt-0.5 text-body font-medium leading-[1.35] text-[color:var(--text-strong)] ${
                clampTitle ? 'line-clamp-2' : 'break-words [overflow-wrap:anywhere]'
              }`}
            >
              {title}
            </div>
            {supporting ? (
              <div className="mt-1 line-clamp-2 text-micro leading-4 text-[color:var(--text-muted)]">
                {supporting}
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex items-baseline gap-2">
            <span className="font-mono tabular-nums text-meta text-[color:var(--text-subtle)]">
              {identifier}
            </span>
            <span className="min-w-0 flex-1 truncate text-body font-medium leading-[1.4]">
              {title}
            </span>
          </div>
        )}
        {!isCard && supporting ? (
          <div className="mt-0.5 truncate text-micro leading-4 text-[color:var(--text-muted)]">
            {supporting}
          </div>
        ) : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </li>
  )
}
