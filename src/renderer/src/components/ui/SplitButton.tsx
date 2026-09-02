// Split button — one bordered group carrying a default action and a menu of
// alternatives (design-system/components/split-button). The primary half runs
// the last-used target; the chevron half lists every target and re-points the
// primary.
//
// The group owns the border, the radius, and the height; the halves are
// borderless and separated by one internal hairline. That is what keeps it a
// single object rather than two buttons that happen to touch. Because the group
// clips its overflow (so each half's hover fill follows the rounded corners),
// the focus ring is drawn INSET — an outer ring would be cut off.
//
// The menu is the shared `Popover` on `role="menu"`, with `MenuItem` rows and
// `roveMenuFocus` for arrow-key nav, so this adds no menu idiom of its own.

import React from 'react'
import { Popover } from './Popover'
import { MenuItem, roveMenuFocus } from './ContextMenu'
import { MENU_LIST_CLASS } from './menuClasses'
import { FOCUS_RING_INSET_CLASS } from './tokens'

export type SplitButtonItem = {
  id: string
  label: string
  /** Leading mark, normally the same glyph the primary half shows for it. */
  icon?: React.ReactNode
  /** Right-aligned keyboard hint. Display only — bind the key elsewhere. */
  shortcut?: string
  /** True on the row the primary half currently runs; renders the check. */
  checked?: boolean
  onSelect: () => void
}

export type SplitButtonProps = {
  /** Verb on the primary half, e.g. "Open". */
  label: string
  /** Accessible name for the primary half, naming its resolved target. */
  primaryAriaLabel: string
  /** Accessible name for the menu half and its surface, e.g. "Open in…". */
  menuAriaLabel: string
  /** Leading mark on the primary half: what says which target will run. */
  glyph?: React.ReactNode
  items: SplitButtonItem[]
  onPrimary: () => void
  /** Menu open/close, e.g. to re-probe which targets still resolve. */
  onMenuOpenChange?: (open: boolean) => void
  /** Forwarded to the primary half — for anchoring feedback to the control. */
  primaryRef?: React.Ref<HTMLButtonElement>
  disabled?: boolean
  className?: string
}

const HALF =
  'interactive inline-flex items-center bg-transparent text-[color:var(--text-default)] ' +
  'text-meta font-medium transition-colors hover:bg-[color:var(--bg-hover)] ' +
  'hover:text-[color:var(--text-strong)] disabled:cursor-not-allowed disabled:opacity-45 ' +
  // Inset: the group clips its overflow, so an outward gap would be cut off
  // on the joined edge between the halves.
  FOCUS_RING_INSET_CLASS

// Trailing check on the row the primary half runs. Trailing, not leading: the
// leading slot carries the target's own glyph, which is what makes the row
// identifiable at a glance.
function CheckGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-icon-xs shrink-0">
      <path
        d="M3.5 8.5L6.5 11.5L12.5 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ChevronGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-icon-xs">
      <path
        d="M4.5 6.5L8 10L11.5 6.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function SplitButton({
  label,
  primaryAriaLabel,
  menuAriaLabel,
  glyph,
  items,
  onPrimary,
  onMenuOpenChange,
  primaryRef,
  disabled = false,
  className,
}: SplitButtonProps) {
  const [open, setOpen] = React.useState(false)
  const surfaceRef = React.useRef<HTMLElement | null>(null)

  const setOpenState = React.useCallback(
    (next: boolean) => {
      setOpen(next)
      onMenuOpenChange?.(next)
    },
    [onMenuOpenChange],
  )

  // Focus the first row on the next frame, not in this one: Popover keeps its
  // surface `visibility: hidden` until it has measured itself, and a
  // visibility-hidden element cannot take focus — focusing synchronously here
  // silently leaves focus on the trigger, which makes the arrow keys inert
  // (verified in the built app, item 1990).
  const focusFirstItem = React.useCallback((surface: HTMLElement) => {
    surfaceRef.current = surface
    requestAnimationFrame(() => {
      surface.querySelector<HTMLButtonElement>('[data-menu-item="true"]:not([disabled])')?.focus()
    })
  }, [])

  // ArrowDown/ArrowUp on the menu half open it and land on a row, the standard
  // menu-button contract. Once a row holds focus its own handler roves.
  const onChevronKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      if (!open) {
        setOpenState(true)
        return
      }
      roveMenuFocus(event, surfaceRef.current)
    },
    [open, setOpenState],
  )

  return (
    <Popover
      open={open}
      onOpenChange={setOpenState}
      ariaLabel={menuAriaLabel}
      popupRole="menu"
      placement="bottom-end"
      // The shared list layer. This surface carried `p-1` — horizontal padding,
      // which insets the rows and is exactly what makes a full-bleed `MenuItem`
      // look like a card inside a card. Vertical only, like every other menu.
      surfaceClassName={`min-w-[200px] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={focusFirstItem}
      className={className}
      renderTrigger={({ ref, togglePopover, triggerProps }) => (
        <span
          className={[
            'inline-flex h-control-sm items-stretch overflow-hidden rounded-sm',
            'border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)]',
            // The GROUP carries the elevation, not the halves: it already owns
            // the border and the radius, and two sunken halves inside one
            // outline would read as two controls. `:active` matches an
            // ancestor of the pressed element, so pressing either half sinks
            // the whole group — which is what a split button is.
            //
            // Conditional because the group is a <span>: `.control-edge:disabled`
            // cannot match it the way it matches the kit's <button>s, so a
            // disabled split button would otherwise keep standing off the page.
            disabled ? '' : 'control-edge',
          ].join(' ')}
        >
          <button
            ref={primaryRef}
            type="button"
            onClick={onPrimary}
            disabled={disabled}
            aria-label={primaryAriaLabel}
            className={`${HALF} gap-1.5 px-2.5`}
          >
            {glyph}
            {label}
          </button>
          <button
            ref={ref}
            type="button"
            onClick={togglePopover}
            onKeyDown={onChevronKeyDown}
            disabled={disabled}
            aria-label={menuAriaLabel}
            aria-haspopup="menu"
            aria-expanded={triggerProps['aria-expanded']}
            aria-controls={triggerProps['aria-controls']}
            className={[
              HALF,
              'border-l border-[color:var(--border-subtle)] px-1 text-[color:var(--text-muted)]',
              open ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]' : '',
            ].join(' ')}
          >
            <ChevronGlyph />
          </button>
        </span>
      )}
    >
      {items.map((item) => (
        <MenuItem
          key={item.id}
          icon={item.icon}
          shortcut={item.shortcut}
          checked={item.checked ?? false}
          // Exactly one target is the primary, and choosing another moves the
          // check rather than adding one — a one-of set, not a row of toggles.
          selection="one-of"
          trailing={
            item.checked ? (
              <span className="text-[color:var(--accent-primary)]">
                <CheckGlyph />
              </span>
            ) : null
          }
          onClick={() => {
            item.onSelect()
            setOpenState(false)
          }}
          onKeyDown={(event) => roveMenuFocus(event, surfaceRef.current)}
        >
          {item.label}
        </MenuItem>
      ))}
    </Popover>
  )
}
