// Group header — the collapsible band above a run of rows, with a tri-state
// checkbox that governs the whole group.
//
// Spec: design-system/components/group-header/component.md.
//
// The Git panel's changelists are what it was drawn for: "Changes · 26 files",
// a chevron that folds them away, a box that stages all of them at once and
// shows a dash when only some are staged, and a chip on the one list new
// changes land in.
//
// `Section` could not be it: structure with no states — no hover, no collapse,
// no focus — a ceiling of one trailing control, and no checkbox anywhere.
//
// 26px, not the 24px floor its rows use, and that is a decision: this band
// carries the only genuinely focusable checkbox in the list, and the shared
// focus ring is 2px of outline at a 2px offset. On a 24px band with a 16px box
// centred the ring lands exactly on the band's own edge. The floor belongs to
// the row that repeats four hundred times; a header appears once per group.

import React, { type JSX } from 'react'

import { Checkbox } from './Checkbox'
import { FOCUS_RING_CLASS, FOCUS_RING_INSET_CLASS } from './tokens'

export type GroupHeaderProps = {
  /** The group's name — the one thing on the band at emphasis weight. */
  title: string
  /** A fact about the group, in muted ink at REGULAR weight: "26 files". A
   *  bolded count reads as a second name, and a band with two names has no
   *  title. Kept when the group is collapsed — folding a group away must not
   *  also hide how much was folded. */
  count?: React.ReactNode
  expanded: boolean
  onExpandedChange: (next: boolean) => void
  /** The `id` of the region this band folds, for `aria-controls`. The region
   *  must stay in the DOM (hidden, not unmounted) for the reference to
   *  resolve. */
  controls: string
  /** Tri-state, and `'mixed'` is the RESTING state of a partly-staged group,
   *  not an edge case. Omit the pair to draw a band with no box. */
  checked?: boolean | 'mixed'
  onCheckedChange?: (next: boolean) => void
  /** Names what the box governs ("Stage every file in Changes"). The visible
   *  title is the group's name, not the box's. */
  checkLabel?: string
  /** One `MicroChip`, and only for a fact that was true before the person
   *  arrived ("active"). Not a status, not a tone. */
  chip?: React.ReactNode
  /** ONE control, revealed on hover and on focus. A band that revealed three
   *  glyphs would be a second toolbar under the first one. */
  action?: React.ReactNode
  className?: string
}

export function GroupHeader({
  title,
  count,
  expanded,
  onExpandedChange,
  controls,
  checked,
  onCheckedChange,
  checkLabel,
  chip,
  action,
  className,
}: GroupHeaderProps): JSX.Element {
  const mixed = checked === 'mixed'
  return (
    <div
      className={[
        // `group`: the trailing control reveals on the band's hover AND focus,
        // never hover alone — a control that only exists under a pointer is
        // unreachable by keyboard and by touch.
        'group relative flex w-full min-h-control-xs items-center gap-1.5 px-2 py-0.5',
        'text-meta leading-tight text-[color:var(--text-strong)] transition-colors',
        'hover:bg-[color:var(--bg-hover)]',
        className ?? '',
      ].join(' ')}
    >
      {/* The chevron is the WHOLE disclosure control: `aria-expanded` and
          `aria-controls` sit on the button that performs the collapse, so a
          pointer user and a screen-reader user operate one element. The title
          is deliberately not a second trigger. */}
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={controls}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${title}`}
        onClick={() => onExpandedChange(!expanded)}
        // Pads out to the hit-target floor with a transparent target rather
        // than growing the mark (the glyph rule) — which is what lets a 13px
        // chevron sit in a 26px band and still be comfortably clickable.
        className={`-ml-1 grid size-[var(--hit-target-min)] shrink-0 place-items-center rounded-xs text-[color:var(--text-subtle)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
          className={`size-icon-xs transition-transform ${expanded ? 'rotate-90' : ''}`}
        >
          <path d="M6.2 3.8 10.4 8l-4.2 4.2" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {checked !== undefined ? (
        // The kit checkbox WHOLE — input and all. One per group rather than one
        // per file, so it costs a handful of tab stops and buys the keyboard a
        // real control. (check-row's box is decorative for the opposite reason.)
        <Checkbox
          checked={checked === true}
          indeterminate={mixed}
          onChange={onCheckedChange}
          readOnly={onCheckedChange === undefined}
          ariaLabel={checkLabel ?? `Select every item in ${title}`}
          className="shrink-0"
        />
      ) : null}

      <span className="min-w-0 flex-none truncate font-semibold text-[color:var(--text-strong)]">{title}</span>
      {count !== undefined ? (
        <span className="shrink-0 font-normal tabular-nums text-[color:var(--text-muted)]">{count}</span>
      ) : null}
      {chip ? <span className="shrink-0">{chip}</span> : null}

      {/* The spacer, so the title and count sit together at the head of the
          band rather than being spread across it. */}
      <span className="min-w-0 flex-1" />

      {action ? (
        <span
          className={[
            'flex shrink-0 items-center opacity-0 transition-opacity',
            'group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100',
          ].join(' ')}
        >
          {action}
        </span>
      ) : null}
    </div>
  )
}

/**
 * The overflow control the trailing slot is shaped for: one glyph button at the
 * hit-target floor. Exported beside the band so a caller does not hand-roll the
 * geometry the spec fixes — the CONTENTS are the caller's (a kebab, a menu
 * trigger), the box is not.
 */
export function GroupHeaderAction({
  ariaLabel,
  menu = false,
  expanded,
  onClick,
  children,
}: {
  ariaLabel: string
  /** The control opens a menu rather than acting. `aria-haspopup` is what tells
   *  a screen-reader user that pressing it will move them into a menu instead
   *  of doing something to the group — the band's spec asks for an overflow
   *  MENU in this slot, so this is the normal case rather than the exception. */
  menu?: boolean
  /** Whether that menu is open right now. Paired with `menu`, and required by
   *  it: `aria-haspopup` without `aria-expanded` announces a menu and then
   *  never says whether it is showing. */
  expanded?: boolean
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-haspopup={menu ? 'menu' : undefined}
      aria-expanded={menu ? (expanded ?? false) : undefined}
      onClick={onClick}
      className={`grid size-[var(--hit-target-min)] place-items-center rounded-xs text-[color:var(--text-subtle)] hover:bg-[color:var(--bg-active)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_INSET_CLASS}`}
    >
      {children}
    </button>
  )
}
