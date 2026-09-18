import React from 'react'

import { MENU_OPTION_CLASS, MENU_OPTION_STACKED_CLASS, MENU_ROW_HOVER_CLASS } from './menuClasses'

// The menu row's OTHER species: the one that shows a CHOICE rather than an
// action (design-system/components/menu-option).
//
// `MenuItem` (ui/ContextMenu) is the action row — "Rename", "Delete", a
// shortcut hint on the right — and it is complete for that job. What the
// product kept hand-rolling beside it is the row that says "this is the value
// in force": a machine in a checkout popover, a model in a picker, a filter
// axis, an attach-path suggestion. Twenty-odd of them, every one a raw
// `<button>` wearing `MENU_ITEM_CLASS`, because the class is a class: it
// reproduces the chrome and carries no selection state, so each host restated
// "selected takes --bg-selected, and hover is suppressed while it does" for
// itself, and four of them got the second half wrong.
//
// Three things separate it from `MenuItem`, and each is why the class was not
// enough:
//
//   1. **The role is the caller's.** A row inside a `listbox` is `option`; the
//      same row inside a `radiogroup` is `radio`; inside a `menu` that picks one
//      of a set it is `menuitemradio`; a standing toggle is `menuitemcheckbox`.
//      `MenuItem` hard-codes the menu family, which is right for an action and
//      wrong for a value.
//   2. **`selected` is a rendered state, not just an attribute.** It paints the
//      neutral selection fill and suppresses hover while it does, and it emits
//      the aria attribute the ROLE actually takes — `aria-selected` for an
//      option, `aria-checked` for the three checkable roles. Emitting the wrong
//      one is silent: a screen reader reads the row as having no state.
//   3. **The tab stop is the caller's.** A radiogroup or a listbox is ONE tab
//      stop, and the row carrying the current value is where it lands.
//      `MenuItem` hard-codes `tabIndex={-1}`, which is right inside a menu with
//      roving focus and wrong for a group the page tabs into.
//
// Everything visual is `menuClasses` — the same inset, gap, hover, disabled step
// and inset focus ring as every other menu row — so a picker and the right-click
// menu beside it stay made of the same material.

/**
 * The roles a value row can honestly take. Each maps to the aria attribute that
 * role uses for its state; there is no fifth, and `menuitem` is deliberately
 * absent — an action row is `MenuItem`.
 */
export type MenuOptionRole = 'option' | 'radio' | 'menuitemradio' | 'menuitemcheckbox'

const CHECKED_ROLES = new Set<MenuOptionRole>(['radio', 'menuitemradio', 'menuitemcheckbox'])

// The neutral selection fill, and the suppressed hover that has to come with it.
// `--bg-hover` sits BELOW `--bg-selected` on the surface ramp, so a selected row
// that also took the hover step dimmed under the pointer — which reads as the
// row letting go of the choice. Stated as two whole branches rather than a fill
// plus an override: `hover:bg-…` and a plain `bg-…` meet at unequal specificity
// and the hover wins, which is the bug every hand-roll of this row shipped.
const SELECTED_FILL = 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
const RESTING_INK = 'text-[color:var(--text-default)] hover:text-[color:var(--text-strong)]'

export type MenuOptionProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'role' | 'aria-selected' | 'aria-checked'
> & {
  role: MenuOptionRole
  /** This row carries the value in force. */
  selected?: boolean
  /**
   * Two lines instead of one — a name over a supporting line. The one sanctioned
   * second row shape (`design-system/components/menu` → The stacked item): it
   * aligns the leading glyph and the trailing mark to the FIRST line, because a
   * two-line row that centres its icon puts the glyph against the gap between
   * them.
   *
   * A prop rather than a class the caller joins, because cross-axis alignment is
   * the single thing the two shapes disagree about and two `items-*` utilities
   * on one element are resolved by stylesheet order.
   */
  stacked?: boolean
  /** Leading glyph. Size and colour stay with the caller's node. */
  icon?: React.ReactNode
  /**
   * Trailing node — the check mark, a value, a chevron. Render it `invisible`
   * rather than omitting it when the rows must not reflow as the choice moves.
   */
  trailing?: React.ReactNode
  /**
   * The row opens a sub-surface rather than committing the value: a drill-in.
   * Emits `aria-expanded`, which is what tells a screen reader the row is a
   * door rather than a choice.
   */
  expanded?: boolean
}

export const MenuOption = React.forwardRef<HTMLButtonElement, MenuOptionProps>(function MenuOption(
  { className, role, selected, stacked, icon, trailing, expanded, children, type, ...rest },
  ref,
) {
  const checkable = CHECKED_ROLES.has(role)
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      role={role}
      // The state attribute the role actually takes. A `listbox` option reads
      // `aria-selected`; the three checkable roles read `aria-checked`. Both are
      // emitted as `false` rather than omitted when the row is not the chosen
      // one — a group whose unchosen rows carry no state attribute announces as
      // a list of plain buttons, which is the thing the role was added for.
      aria-selected={checkable ? undefined : selected === true}
      aria-checked={checkable ? selected === true : undefined}
      aria-expanded={expanded}
      // Before the spread on purpose: `tabIndex`, `data-*` hooks, `onClick`
      // (which receives the event — a picker often positions something from the
      // clicked row's rect), `onKeyDown` for a host's roving focus, and
      // `disabled` are all the caller's, and a value row that swallowed them is
      // why twenty of these stayed raw elements.
      {...rest}
      className={[
        stacked === true ? MENU_OPTION_STACKED_CLASS : MENU_OPTION_CLASS,
        // One `hover:bg-…` on the element or none: the highlight arrives with
        // the resting branch and is absent from the selected one, rather than
        // being written twice and settled by stylesheet order.
        selected === true ? SELECTED_FILL : `${MENU_ROW_HOVER_CLASS} ${RESTING_INK}`,
        className ?? '',
      ].join(' ')}
    >
      {icon ?? null}
      {stacked === true ? (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{children}</span>
      )}
      {trailing}
    </button>
  )
})
