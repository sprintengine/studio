// Toolbar — a band of icon controls that acts on the region directly beneath
// it, and belongs to that region rather than to the pane around it.
//
// Spec: design-system/components/toolbar/component.md, which carries the
// amendment to the five-controls ceiling that lets the Git panel's band hold
// nine (principles.md → "Quantified restraint", 2026-09-09). Read it before
// adding a tenth item.
//
// It composes rather than restyles: every item is the button family's icon
// species — a 26px square, borderless, a 16px glyph, the shared focus ring, an
// accessible name. What this file owns is the BAND: its height, its rhythm, its
// one hairline, the divider that groups the items, and the roving focus that
// `role="toolbar"` promises.
//
// ONE TAB STOP. That promise is the whole reason the role is here: nine
// separate tab stops between the pane's tabs and the first file is the cost the
// role exists to remove. Arrow keys walk the band, Home/End jump to its ends,
// and Tab leaves it.

import React from 'react'

import { FOCUS_RING_CLASS } from './tokens'

const ITEM_ATTR = 'data-toolbar-item'

export function Toolbar({
  /** Names the REGION the band acts on ("Changed files"), never "Toolbar" — a
   *  window with three toolbars must not present three identical landmarks. */
  ariaLabel,
  /** For a band already sitting under a hairline (a tab strip, a PanelHeader).
   *  Two rules 30px apart is a ladder, not a structure. */
  borderless = false,
  children,
  className,
}: {
  ariaLabel: string
  borderless?: boolean
  children: React.ReactNode
  className?: string
}): JSX.Element {
  const ref = React.useRef<HTMLDivElement | null>(null)

  const walkable = React.useCallback((): HTMLElement[] => {
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>(`[${ITEM_ATTR}]`) ?? [])
    // A disabled item keeps its PLACE in the band (which actions exist is
    // information) but not its place in the walk.
    return all.filter(
      (item) => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true',
    )
  }, [])

  // Exactly one item in the tab order, and it is the one focus last rested on —
  // recomputed after every render because the band's contents change with the
  // region's state (an item appears, another disables).
  React.useEffect(() => {
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>(`[${ITEM_ATTR}]`) ?? [])
    const enabled = walkable()
    const active = enabled.find((item) => item === document.activeElement) ?? enabled[0]
    for (const item of all) item.tabIndex = item === active ? 0 : -1
  })

  function move(from: HTMLElement | null, delta: number | 'first' | 'last'): void {
    const items = walkable()
    if (items.length === 0) return
    const index = from ? items.indexOf(from) : -1
    const next =
      delta === 'first'
        ? items[0]
        : delta === 'last'
        ? items[items.length - 1]
        : items[(Math.max(index, 0) + delta + items.length) % items.length]
    next?.focus()
  }

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={ariaLabel}
      onKeyDown={(event) => {
        // The event usually bubbles from the focused item; fall back to what
        // actually has focus, so a key pressed while focus sits on the band
        // itself still walks from where the person is rather than from item one.
        const target =
          (event.target as HTMLElement).closest<HTMLElement>(`[${ITEM_ATTR}]`) ??
          (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(`[${ITEM_ATTR}]`) ??
          null
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          move(target, 1)
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault()
          move(target, -1)
        } else if (event.key === 'Home') {
          event.preventDefault()
          move(target, 'first')
        } else if (event.key === 'End') {
          event.preventDefault()
          move(target, 'last')
        }
      }}
      onFocus={(event) => {
        // Focus landing on an item makes it the band's tab stop, so leaving and
        // returning comes back to where the person was.
        const item = (event.target as HTMLElement).closest<HTMLElement>(`[${ITEM_ATTR}]`)
        if (!item) return
        for (const other of walkable()) other.tabIndex = other === item ? 0 : -1
      }}
      className={[
        'flex h-control-sm items-center gap-0.5 px-1.5',
        // One hairline, at the bottom, and it is the band's whole separation:
        // no fill, no shadow, no second rule above.
        borderless ? '' : 'border-b border-[color:var(--border-subtle)]',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </div>
  )
}

export type ToolbarButtonProps = {
  /** Required. An icon-only control with no name is a blank button — the one
   *  thing this shape can get wrong. */
  ariaLabel: string
  /** The item opens a menu rather than acting: `aria-haspopup` says so, and a
   *  small filled corner draws it the way IDEs do. Not a chevron beside
   *  the glyph — that is a second mark on a 26px square, and it pushes the
   *  glyph off centre. */
  menu?: boolean
  expanded?: boolean
  disabled?: boolean
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
  className?: string
}

export const ToolbarButton = React.forwardRef<HTMLButtonElement, ToolbarButtonProps>(
  function ToolbarButton({ ariaLabel, menu = false, expanded, disabled = false, onClick, children, className }, ref) {
    return (
      <button
        {...{ [ITEM_ATTR]: '' }}
        ref={ref}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup={menu ? 'menu' : undefined}
        aria-expanded={menu ? expanded ?? false : undefined}
        disabled={disabled}
        onClick={onClick}
        // The band owns the tab order; the effect in Toolbar sets this. -1 is
        // the safe default for an item rendered outside a Toolbar.
        tabIndex={-1}
        className={[
          'relative grid size-control-xs shrink-0 place-items-center rounded-xs',
          'text-[color:var(--text-muted)] transition-colors',
          'hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
          'disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent',
          FOCUS_RING_CLASS,
          // The corner mark: two borders of a zero-size box, which is the one
          // spelling of a triangle that needs no asset and no path.
          menu
            ? 'after:pointer-events-none after:absolute after:right-0.5 after:bottom-0.5 after:border-2 after:border-transparent after:border-r-current after:border-b-current after:content-[""]'
            : '',
          className ?? '',
        ].join(' ')}
      >
        {children}
      </button>
    )
  },
)

/**
 * The system's first VERTICAL divider. It earns being one: a band of identical
 * 26px squares has no other way to say "these six are about the files, these
 * three are about the view" — a gap cannot, because the items are already
 * separated by one and doubling it reads as a rendering accident.
 *
 * 16px rather than the band's 30px (a full-height rule meets the hairline below
 * and draws a corner, which is a table cell), `--border-default` rather than
 * subtle (it is the one thing in the band that has to be SEEN), and decorative:
 * to a screen reader the band is one flat toolbar walked in order, and
 * announcing a separator between item six and item seven describes a picture.
 *
 * Not a general-purpose vertical rule. Everywhere else in the system,
 * separation is space or a horizontal hairline.
 */
export function ToolbarDivider(): JSX.Element {
  return <span aria-hidden="true" className="h-icon-sm w-px shrink-0 bg-[color:var(--border-default)]" />
}

/** Pushes what follows to the trailing end — for a band with a leading and a
 *  trailing cluster. `justify-between` would spread three clusters when there
 *  are three. */
export function ToolbarSpacer(): JSX.Element {
  return <span aria-hidden="true" className="min-w-0 flex-1" />
}
