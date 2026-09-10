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
import {
  FOCUS_RING_INSET_CLASS,
  FOCUS_RING_WITHIN_CHECKBOX_CLASS,
  LIST_CURSOR_MARK_CLASS,
} from './tokens'

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
      // An `option` always says whether it is selected — that is what a listbox
      // is. A `treeitem` says so only when it IS: a tree emitting
      // `aria-selected="false"` on every node announces itself as selectable
      // even when nothing in it can be picked.
      aria-selected={selected || resting ? true : tree ? undefined : false}
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

// ── The described row ──────────────────────────────────────────────────────
//
// Spec: design-system/components/check-row/component.md → `--described`.
//
// The SAME row with the name allowed a second line: a title, an optional mono
// scope name beside it, and one supporting sentence under both, inside a list
// surface whose rows are divided by hairlines. It is a variant and not a new
// component because nothing structural changes — box beside name, box as a
// sibling, name leading — and the base row already conceded the height:
// `min-height` was always a FLOOR, not a height.
//
// It takes the STANDALONE box spelling the spec names, which is why this is a
// separate component rather than a prop on `CheckRow`: these rows come in
// eights inside a dialog, not four hundreds inside a listbox, so the kit
// checkbox goes in WHOLE — input and all — the row is the `<label>` that names
// it, and there is no `aria-checked` because the input is the state. Space
// toggles natively for the same reason. Merging the two spellings into one
// component would have meant a prop that silently swaps a real input for a
// drawing, which is the one difference a caller must not be able to make by
// accident.

export type DescribedCheckRowProps = {
  /** Stable id for the input, so the label and any `aria-describedby` resolve. */
  id: string
  /** The name, in the reader's language. */
  title: React.ReactNode
  /** The same fact in the system's vocabulary — `terminal:control`. Optional:
   *  a described row whose subject has no identifier simply has no mono name. */
  code?: string
  /** ONE supporting line. Two would be a card. */
  description: React.ReactNode
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  className?: string
}

/**
 * The list surface the described rows sit in: `border.subtle`, `radius.shell`,
 * `bg.surface-raised`, with the hairline between rows.
 *
 * It ships with the row rather than being left to the caller because the
 * divider's inset and the row's padding are one decision — a host drawing its
 * own rule would put it at its own inset and the boxes would stop lining up
 * with it. A plain `<ul>`, never a `listbox`: every row here is its own tab
 * stop, so there is nothing to rove.
 */
export function DescribedCheckRowList({
  ariaLabel,
  className,
  children,
}: {
  ariaLabel?: string
  className?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <ul
      aria-label={ariaLabel}
      className={[
        // `overflow-hidden`: the rows are square-cornered and full-bleed, and
        // the surface's radius is what clips the first and last row's hover
        // fill. A rounded fill inset in a padded surface is a card in a card.
        'list-none overflow-hidden rounded-lg border border-[color:var(--border-subtle)]',
        'bg-[color:var(--bg-surface-raised)] p-0',
        // The divider goes BETWEEN rows and never around them, so the
        // surface's own border is never doubled.
        '[&>li+li]:border-t [&>li+li]:border-[color:var(--border-subtle)]',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </ul>
  )
}

/**
 * One described row. Render it inside `DescribedCheckRowList`; the `<li>` is
 * the row's own, so the list's hairline rule finds it.
 */
export function DescribedCheckRow({
  id,
  title,
  code,
  description,
  checked,
  onChange,
  disabled = false,
  className,
}: DescribedCheckRowProps): JSX.Element {
  const descriptionId = `${id}-description`
  return (
    <li>
      <label
        htmlFor={id}
        className={[
          // `items-start`: the box sits on the TITLE's line. Centred against a
          // two-line stack it floats between them and stops reading as
          // belonging to the title it marks.
          'flex w-full items-start gap-2.5 px-3 py-2.5 text-meta transition-colors',
          // The ring is the ROW's, on the INPUT's focus-visible: the input is
          // the tab stop but the label is the hit target, so ringing the 16px
          // box inside a 44px row would mark the smallest part of what the
          // person is operating. Inward, because the row is full-bleed against
          // a surface that clips an outset ring.
          FOCUS_RING_WITHIN_CHECKBOX_CLASS,
          disabled
            ? 'cursor-not-allowed opacity-50'
            : 'cursor-pointer hover:bg-[color:var(--bg-hover)]',
          className ?? '',
        ].join(' ')}
      >
        {/* The kit checkbox WHOLE — input and all. `mt-0.5` is the difference
            between the 16px box and the meta line box it aligns to. */}
        <span className="relative mt-0.5 inline-flex size-icon-sm shrink-0 items-center justify-center">
          <input
            id={id}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            aria-describedby={descriptionId}
            onChange={(event) => onChange(event.target.checked)}
            className="peer absolute inset-0 h-full w-full cursor-[inherit] opacity-0 disabled:cursor-not-allowed"
          />
          <CheckboxBox checked={checked} disabled={disabled} peerFocus />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          {/* `items-baseline`: the mono name sits on the words' line even
              though it is a type step smaller. */}
          <span className="flex flex-wrap items-baseline gap-2 font-medium text-[color:var(--text-strong)]">
            {title}
            {code ? (
              // The same fact in the system's vocabulary — a step quieter and a
              // step smaller, because a mono name that shouted would make the
              // title decorative.
              <span className="font-mono text-micro font-normal text-[color:var(--text-subtle)]">{code}</span>
            ) : null}
          </span>
          <span id={descriptionId} className="text-meta text-[color:var(--text-muted)]">
            {description}
          </span>
        </span>
      </label>
    </li>
  )
}
