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
//
// TWO KINDS OF UNAVAILABLE. `disabled` is the hard one: the control is out of
// the walk because the DOM will not focus it. `ariaDisabled` is the soft one —
// the item cannot act, but it stays walkable, focusable and hoverable, which is
// the only way a glyph-only control can ever say WHY. In a band where every
// word rides the tooltip, a hard-disabled item is a mute square: the tooltip
// cannot open on a control that receives no events, so the one explanation the
// design gives the person is unreachable exactly when they need it.

import React from 'react'

import { IconButton } from './Buttons'

const ITEM_ATTR = 'data-toolbar-item'

/** The attribute the band's roving walk looks for. Exported so a COMPOSITE
 *  child of the band — the segmented control, the inline pager — can hang its
 *  own focusables off the same hook rather than standing up a second tab stop
 *  inside a band whose whole promise is that there is one. */
export const TOOLBAR_ITEM_ATTR = ITEM_ATTR

// Children that own their own arrow keys. A radiogroup moves its selection, a
// menu walks its options, a text field moves the caret; the band walks BETWEEN
// items. When both answer, the band wins by accident — its `move(null, 1)`
// fallback teleports focus to item one from wherever the person was.
const NESTED_COMPOSITE = '[role="radiogroup"], [role="menu"], input, textarea, select'

// Is this subtree inside a Toolbar band? Composite children read it and join
// the band's walk instead of keeping a tab stop of their own. A context rather
// than a prop, because the caller that composes a band should not have to
// remember to tell each child it is in one.
const ToolbarBandContext = React.createContext(false)

export function useInToolbarBand(): boolean {
  return React.useContext(ToolbarBandContext)
}

/**
 * What a composite child spreads onto each of its own focusable elements to be
 * walked by the band. Empty outside a band, so a pager under a list and a
 * segmented control in a form are untouched.
 *
 * The child must also pin `tabIndex` to -1 while in a band: the Toolbar's
 * effect is what hands the single 0 out, and a child that renders its own 0
 * would put it back on the next render.
 */
export function toolbarItemProps(inBand: boolean): Record<string, string> {
  return inBand ? { [ITEM_ATTR]: '' } : {}
}

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
    // A HARD-disabled item keeps its PLACE in the band (which actions exist is
    // information) but not its place in the walk: the DOM will not focus it, so
    // a walk that stepped onto it would strand the person.
    //
    // A SOFT-disabled one — `aria-disabled="true"`, no `disabled` attribute —
    // stays in the walk on purpose. It is reachable, focusable and hoverable,
    // which is the only way the tooltip that says WHY it is unavailable can
    // ever open. This filter used to drop those too, which made
    // `aria-disabled` a strictly worse `disabled` and left the band with no
    // way to explain itself.
    return all.filter((item) => !item.hasAttribute('disabled'))
  }, [])

  // The remembered tab stop. A REF, not a re-derivation: `document.activeElement`
  // answers "who has focus now", and once focus has left the band the answer is
  // nobody — so recomputing it on every render walked the person back to item
  // one every time the region's state moved while they were elsewhere. The ref
  // remembers where they were; it is honoured while that item is still in the
  // band and still enabled, and falls through to the first item when it is not.
  const rovedRef = React.useRef<HTMLElement | null>(null)

  // Exactly one item in the tab order, reasserted after every render because
  // the band's contents change with the region's state (an item appears,
  // another disables).
  React.useEffect(() => {
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>(`[${ITEM_ATTR}]`) ?? [])
    const enabled = walkable()
    const focused = enabled.find((item) => item === document.activeElement) ?? null
    const roved = rovedRef.current
    const remembered = roved && enabled.includes(roved) ? roved : null
    const active = focused ?? remembered ?? enabled[0] ?? null
    rovedRef.current = active
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
        const isStep = event.key === 'ArrowRight' || event.key === 'ArrowLeft'
        const isEnd = event.key === 'Home' || event.key === 'End'
        if (!isStep && !isEnd) return
        // A child that owns its own arrow keys keeps them. Everything in the
        // band bubbles to here, so without this the segmented control's
        // selection walk and the inline pager's chevrons each ALSO stepped the
        // band — and because their focused element is not a toolbar item, the
        // step started from `null` and landed on item one.
        const source = event.target as HTMLElement | null
        const nested = source?.closest?.<HTMLElement>(NESTED_COMPOSITE) ?? null
        const ownsKeys = nested !== null && !nested.hasAttribute(ITEM_ATTR)
        // Home/End are given up only where they mean something else: they move
        // the caret in a text field, but a radiogroup and a menu claim neither,
        // so the ends of the band stay reachable from inside one.
        const caretHost = nested !== null && /^(?:INPUT|TEXTAREA|SELECT)$/.test(nested.tagName)
        if (ownsKeys && (isStep || caretHost)) return
        // The event usually bubbles from the focused item; fall back to what
        // actually has focus, so a key pressed while focus sits on the band
        // itself still walks from where the person is rather than from item one.
        const target =
          source?.closest<HTMLElement>(`[${ITEM_ATTR}]`) ??
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
        rovedRef.current = item
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
      <ToolbarBandContext.Provider value={true}>{children}</ToolbarBandContext.Provider>
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
  /** HARD-disabled: out of the walk, out of the tab order, and unable to
   *  receive a pointer event — so nothing it is wrapped in can explain it.
   *  Right for an item that is momentarily busy, wrong for one that is
   *  unavailable for a REASON. */
  disabled?: boolean
  /** SOFT-disabled: the item does nothing when pressed, but stays in the band's
   *  walk, takes focus, and receives hover — so its Tooltip opens and the
   *  reason is reachable by pointer and by keyboard. */
  ariaDisabled?: boolean
  /** Why it is unavailable, in words, folded into the accessible name. A
   *  tooltip is a visual affordance; a screen-reader user meets the name. */
  disabledReason?: string
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
  className?: string
}

export const ToolbarButton = React.forwardRef<HTMLButtonElement, ToolbarButtonProps>(
  function ToolbarButton(
    { ariaLabel, menu = false, expanded, disabled = false, ariaDisabled = false, disabledReason, onClick, children, className },
    ref,
  ) {
    // `disabled` wins if a caller passes both: the attribute is the stronger
    // claim, and an element that is both would be soft-disabled in ARIA and
    // hard-disabled in the DOM — two answers to one question.
    const soft = ariaDisabled && !disabled
    return (
      // The item IS `button --icon` — `IconButton` at `sm`, which is the 26px
      // square, the ghost tone and the shared ring. The band composes rather
      // than restyles: a toolbar item that hovered differently from a button
      // would be a second button.
      <IconButton
        {...{ [ITEM_ATTR]: '' }}
        ref={ref}
        size="sm"
        aria-label={soft && disabledReason ? `${ariaLabel} — ${disabledReason}` : ariaLabel}
        aria-haspopup={menu ? 'menu' : undefined}
        aria-expanded={menu ? expanded ?? false : undefined}
        aria-disabled={soft || undefined}
        disabled={disabled}
        // A soft-disabled item is a real, pressable button as far as the DOM is
        // concerned, so refusing the press is this component's job.
        onClick={soft ? undefined : onClick}
        // The band owns the tab order; the effect in Toolbar sets this. -1 is
        // the safe default for an item rendered outside a Toolbar.
        tabIndex={-1}
        className={[
          // The corner mark: two borders of a zero-size box, which is the one
          // spelling of a triangle that needs no asset and no path.
          // `relative` is the mark's positioning context: IconButton's `sm`
          // step draws no hit-target pseudo-element, so it does not bring one.
          menu
            ? 'relative after:pointer-events-none after:absolute after:right-0.5 after:bottom-0.5 after:border-2 after:border-transparent after:border-r-current after:border-b-current after:content-[""]'
            : '',
          // The dim is `IconButton`'s own `aria-disabled:opacity-45`; only the
          // cursor has to be said here.
          soft ? 'cursor-not-allowed' : '',
          className ?? '',
        ].join(' ')}
      >
        {children}
      </IconButton>
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
