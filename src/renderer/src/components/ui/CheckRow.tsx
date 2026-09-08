// Check row — the pick-AND-mark row at the 24px hit-target floor.
//
// Spec: design-system/components/check-row/component.md.
//
// The row a person both chooses and ticks: the Git changes list, where the
// tick IS the index (checked = staged, mixed = partly staged), and the File
// Explorer's tree, which is the same row with a chevron and an indent. Two
// questions on one 24px line, and the whole primitive is about keeping them
// apart — the tick is a value the row carries, the fill and the edge are where
// the person is. A row can be checked-and-unselected, selected-and-unchecked,
// or both, and none of those four may be mistaken for another.
//
// Neither existing row could be it. `InboxRow` / list-row caps at four visual
// elements and its row IS the <button>, which a checkbox may not sit inside;
// `RowButton` owns no height, and the floor is the point here — four hundred
// files step at one pitch or the list reads as noise.
//
// THE BOX IS A SIBLING, NEVER A DESCENDANT. That constraint is what shaped
// list-row's `-host` wrapper. This row solves it upstream: the row is a <div>
// carrying an ARIA role, so the box is simply one of its children.
//
// And the box is DECORATIVE (`CheckboxBox`, the drawing from ui/Checkbox with
// no input under it): the list is one tab stop walking with
// `aria-activedescendant`, so a real input per row would be the four hundredth
// tab stop. The state is announced by the row's own `aria-checked`, which is
// what an `option` and a `treeitem` are specified to carry.

import React from 'react'

import { CheckboxBox } from './Checkbox'
import { FOCUS_RING_INSET_CLASS, LIST_CURSOR_MARK_CLASS } from './tokens'

export type CheckRowCheckedState = boolean | 'mixed'

export type CheckRowProps = {
  /** `true`, `false`, or `'mixed'` for a partly-marked item (a file with both
   *  staged and unstaged hunks). Rendered as the row's `aria-checked`. */
  checked: CheckRowCheckedState
  /** Toggling the box. Absent means the row is a read-only mark. */
  onCheckedChange?: (next: boolean) => void
  /** The name — the thing being scanned for. Never truncates first. */
  name: React.ReactNode
  /** The supporting path, in muted ink. Takes the remaining width and
   *  truncates from the end. */
  directory?: React.ReactNode
  /** The reserved 16px leading slot. The slot exists whether or not this does:
   *  an unreserved slot is what makes sibling rows' names start at three
   *  different x-offsets. */
  glyph?: React.ReactNode
  /** Display only — a status letter, a size, a count. Never a control. */
  trailing?: React.ReactNode
  /** `option` in a flat listbox, `treeitem` in a tree. */
  role?: 'option' | 'treeitem'
  /** The selected row of the pane the person is driving: neutral fill plus the
   *  2px inset accent edge. */
  selected?: boolean
  /** The selected row of a pane that does not have focus: the quieter fill and
   *  NO edge, so exactly one edge is on screen. */
  resting?: boolean
  /** The row the keyboard cursor rests on, in a list that walks with
   *  `aria-activedescendant`. A third channel: it composes over both fills. */
  cursor?: boolean
  /** `aria-disabled`, never the attribute: the row stays in the walk so a
   *  person can reach it and be told why it cannot be ticked. */
  disabled?: boolean
  /** Tree only. Depth is a level, not a pixel value. */
  depth?: number
  /** Tree only: `undefined` on a leaf, which keeps the chevron's slot and
   *  drops its mark. */
  expanded?: boolean
  /** Tree only — `aria-level`, 1-based. */
  level?: number
  onToggleExpanded?: () => void
  /** Picking the row (which is not ticking it). */
  onSelect?: () => void
  className?: string
} & Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'role' | 'onSelect' | 'children' | 'aria-checked' | 'aria-selected'
>

/**
 * The row forwards its ref and every remaining DOM attribute — `id`,
 * `tabIndex`, `data-*`, `onContextMenu`. A list drives roving focus by querying
 * for its own hook and decides for itself where the tab stop is; a row
 * primitive that swallowed those is why forty of these stayed raw elements
 * (RowButton's ruling, 2026-09-08).
 */
export const CheckRow = React.forwardRef<HTMLDivElement, CheckRowProps>(function CheckRow(
  {
    checked,
    onCheckedChange,
    name,
    directory,
    glyph,
    trailing,
    role = 'option',
    selected = false,
    resting = false,
    cursor = false,
    disabled = false,
    depth,
    expanded,
    level,
    onToggleExpanded,
    onSelect,
    className,
    ...rest
  },
  ref,
) {
  const tree = role === 'treeitem'
  const mixed = checked === 'mixed'
  const isChecked = checked === true

  function toggle(event: React.SyntheticEvent): void {
    if (disabled || !onCheckedChange) return
    // The box is inside the row, and picking a row is not ticking it.
    event.stopPropagation()
    event.preventDefault()
    onCheckedChange(!isChecked)
  }

  return (
    <div
      {...rest}
      ref={ref}
      role={role}
      aria-checked={mixed ? 'mixed' : isChecked}
      aria-selected={selected || resting}
      aria-level={tree ? level : undefined}
      aria-expanded={tree ? expanded : undefined}
      aria-disabled={disabled || undefined}
      onClick={(event) => {
        rest.onClick?.(event)
        if (!disabled) onSelect?.()
      }}
      onKeyDown={(event) => {
        rest.onKeyDown?.(event)
        // Only for a row that is its own tab stop. A list walking with
        // `aria-activedescendant` keeps focus on the list, handles Space
        // itself, and never reaches this.
        if (event.defaultPrevented || disabled) return
        if (event.key === ' ' && event.currentTarget === event.target) toggle(event)
      }}
      // The indent, said out loud rather than left as arithmetic (principles.md:
      // an indent that aligns to a reserved glyph slot is structure, not rhythm,
      // and keeps its computed value off the space scale with a line saying what
      // it lines up with). 8px is the row's own `px-2` inset, so depth 0 starts
      // level with a flat row; each level adds one 12px `space.lg` step, which
      // is the chevron slot's own width.
      style={depth ? { paddingLeft: `${8 + depth * 12}px`, ...rest.style } : rest.style}
      className={[
        // `overflow-hidden`: a name wider than the row is clipped by the row
        // rather than pushing the directory out of it.
        'relative flex w-full min-h-[var(--hit-target-min)] items-center gap-1.5',
        'overflow-hidden px-2 py-0.5 text-meta leading-tight transition-colors',
        FOCUS_RING_INSET_CLASS,
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-default',
        selected
          ? // Neutral fill plus the 2px inset accent EDGE, read through
            // `--selection-edge` so a theme that neutralises the edge moves this
            // row with every other one (InboxRow's ruling, 2026-09-05).
            'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)] ring-2 ring-inset ring-[color:var(--selection-edge)]'
          : resting
          ? 'bg-[color:var(--bg-selected-resting)] text-[color:var(--text-default)]'
          : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]',
        className ?? '',
      ].join(' ')}
    >
      {cursor ? <span aria-hidden="true" className={LIST_CURSOR_MARK_CLASS} /> : null}
      {tree ? (
        <span
          aria-hidden="true"
          onClick={(event) => {
            if (!onToggleExpanded) return
            event.stopPropagation()
            onToggleExpanded()
          }}
          // The slot is kept on a leaf and the mark dropped: without the
          // reservation every leaf's glyph sits one chevron left of its parent's.
          className={[
            'grid size-icon-xs shrink-0 place-items-center text-[color:var(--text-subtle)] transition-transform',
            expanded === undefined ? 'invisible' : '',
            expanded ? 'rotate-90' : '',
          ].join(' ')}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" className="size-icon-xs">
            <path d="M6.2 3.8 10.4 8l-4.2 4.2" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      ) : null}
      <span
        // A click target, not a control: the announced state is the row's
        // `aria-checked` above, and the drawn box must not be met twice.
        className="inline-flex size-icon-sm shrink-0 items-center justify-center"
        onClick={toggle}
      >
        <CheckboxBox checked={isChecked} indeterminate={mixed} disabled={disabled} />
      </span>
      <span aria-hidden="true" className="grid size-icon-sm shrink-0 place-items-center">
        {glyph}
      </span>
      {/* `shrink-0`: the name is what the person is scanning for, so it is never
          the part that gets cut. */}
      <span className="shrink-0 whitespace-nowrap">{name}</span>
      {directory ? (
        // One step of lift on a chosen row and no further. The mockup lifted it
        // to `--text-strong` alongside the name; at that point the row's two
        // halves weigh the same and the filename stops being the thing you find.
        <span
          className={[
            'min-w-0 flex-1 truncate',
            selected || resting
              ? 'text-[color:var(--text-default)]'
              : 'text-[color:var(--text-muted)]',
          ].join(' ')}
        >
          {directory}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {trailing ? (
        <span className="shrink-0 font-mono text-micro tabular-nums text-[color:var(--text-muted)]">
          {trailing}
        </span>
      ) : null}
    </div>
  )
})
