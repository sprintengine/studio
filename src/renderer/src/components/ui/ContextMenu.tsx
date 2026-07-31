import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip } from './Tooltip'
import { FOCUS_RING_CLASS } from './tokens'
import { HIGHLIGHT_COLORS, getHighlightSwatch } from '../../utils/highlight'
import type { HighlightColor } from '../../types/workspace'

// Pointer-positioned context menu. Unlike Popover (anchored to a trigger
// element), this surface opens at viewport coordinates — a right-click point
// or a kebab button corner — and clamps itself inside the viewport. zIndex 60
// keeps it above the z-50 Popover/Tooltip layer.
//
// PORTALLED to document.body. It used to render in place with `position:
// fixed`, on the assumption that fixed always resolves against the viewport.
// It does not: any ancestor with `transform`, `filter`, `perspective`,
// `contain`, `backdrop-filter`, or `will-change` on those becomes the
// containing block for fixed descendants, and its `overflow` then clips the
// menu. That is not hypothetical here — `.drawer-panel` and
// `.settings-overlay-panel` carry `transform: translate3d(…)` AND
// `will-change: transform` permanently, including at rest
// (assets/index.css:2140-2148, :2185-2194), so a menu opened inside one was
// clipped at the panel edge (the horizon rail's kebab showed `Ma… Rev… Del…`).
// Positioning is unchanged — `useClampedMenuPosition` already measures against
// the viewport, which is exactly what the portal now makes true.
//
// Only the ROOT surface portals. `MenuFlyoutItem`'s nested surface must stay
// inside this menu's DOM (see its comment) so the outside-pointerdown check
// below treats flyout clicks as inside clicks — and because the root has left
// the clipping ancestor, the flyout inside it is out too.
//
// React events still bubble to the React parent through a portal, so callers
// that relied on propagation (or on stopPropagation) are unaffected.
//
// Contract: role="menu" surface with an accessible name, Escape closes and
// restores focus to the previously focused element, outside pointerdown
// closes without stealing focus, ArrowUp/ArrowDown/Home/End rove focus
// across enabled items, and checkable items render role="menuitemcheckbox"
// with aria-checked.

// design-tokens-allow: popover-elevation reuses the OverflowMenu shadow shape (no glow CTA pattern)
const MENU_SURFACE_CLASS =
  'rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-1 text-body text-[color:var(--text-default)] shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]'

const MENU_Z_INDEX = 60

type ClampOptions = {
  /**
   * When the menu would overflow the right viewport edge, re-anchor its right
   * edge to this x instead of sliding along the bottom — used by flyout
   * submenus to open leftward of their parent item rather than covering it.
   */
  flipXTo?: number
}

// Keeps a coordinate-positioned menu fully inside the viewport. If the menu
// would overflow the bottom, flip it above the anchor point so the user can
// read it.
export function useClampedMenuPosition(
  x: number,
  y: number,
  ref: React.RefObject<HTMLElement | null>,
  options?: ClampOptions,
) {
  const flipXTo = options?.flipXTo
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 6
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = x
    let top = y
    if (x + rect.width + margin > vw) {
      left =
        typeof flipXTo === 'number'
          ? Math.max(margin, flipXTo - rect.width)
          : Math.max(margin, vw - rect.width - margin)
    }
    if (y + rect.height + margin > vh) {
      const flipped = y - rect.height
      top = flipped >= margin ? flipped : Math.max(margin, vh - rect.height - margin)
    }
    setPos({ left, top })
  }, [x, y, ref, flipXTo])
  return pos
}

// Enabled items belonging directly to `surface` — items inside an open nested
// flyout have a nearer role="menu" ancestor and are excluded, so each surface
// roves only its own level.
function menuItemsOf(surface: HTMLElement): HTMLElement[] {
  return Array.from(
    surface.querySelectorAll<HTMLElement>('[data-menu-item="true"]:not([disabled])'),
  ).filter((el) => el.closest('[role="menu"]') === surface)
}

// Exported so a menu hosted in a Popover (SplitButton) reuses this nav rather
// than growing a second copy. `surface` is the element carrying role="menu".
export function roveMenuFocus(event: React.KeyboardEvent, surface: HTMLElement | null): void {
  if (!surface) return
  if (
    event.key !== 'ArrowDown' &&
    event.key !== 'ArrowUp' &&
    event.key !== 'Home' &&
    event.key !== 'End'
  ) {
    return
  }
  const items = menuItemsOf(surface)
  if (items.length === 0) return
  event.preventDefault()
  event.stopPropagation()
  const active = document.activeElement as HTMLElement | null
  const index = active ? items.indexOf(active) : -1
  let next: HTMLElement | undefined
  if (event.key === 'Home') next = items[0]
  else if (event.key === 'End') next = items[items.length - 1]
  else if (event.key === 'ArrowDown') next = index < 0 ? items[0] : items[(index + 1) % items.length]
  else if (event.key === 'ArrowUp')
    next = index < 0 ? items[items.length - 1] : items[(index - 1 + items.length) % items.length]
  next?.focus()
}

type ContextMenuProps = {
  /** Viewport x of the open point (e.g. `event.clientX` or a button corner). */
  x: number
  /** Viewport y of the open point. */
  y: number
  /** Required accessible name for the menu surface. */
  ariaLabel: string
  onClose: () => void
  children: React.ReactNode
  /** Extra surface classes — typically a `min-w-[…]` floor. */
  surfaceClassName?: string
}

export function ContextMenu({ x, y, ariaLabel, onClose, children, surfaceClassName }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const pos = useClampedMenuPosition(x, y, ref)

  const restoreFocus = useCallback(() => {
    previousFocusRef.current?.focus()
  }, [])

  // Capture the opener and move focus onto the surface so Escape and the
  // arrow keys work immediately. The layout cleanup runs before the node
  // leaves the DOM, so a close triggered while focus is inside the menu
  // (keyboard item activation) hands focus back instead of dropping it.
  useLayoutEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null
    const surface = ref.current
    surface?.focus()
    return () => {
      if (surface?.contains(document.activeElement)) restoreFocus()
    }
  }, [restoreFocus])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') {
        event.preventDefault()
        restoreFocus()
        onClose()
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose, restoreFocus])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={(event) => roveMenuFocus(event, ref.current)}
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: MENU_Z_INDEX }}
      // design-system-allow: tabIndex -1 surface focused only to seed roving focus; the menu item that takes focus carries the shared ring
      className={`${MENU_SURFACE_CLASS} focus:outline-none ${surfaceClassName ?? ''}`}
    >
      {children}
    </div>,
    document.body,
  )
}

type MenuItemProps = {
  children: React.ReactNode
  onClick: () => void
  /** E.g. open a secondary picker at the pointer; the menu stays open. */
  onContextMenu?: (event: React.MouseEvent) => void
  /** Leading glyph; size and color stay with the caller's node. */
  icon?: React.ReactNode
  /** Visible keyboard shortcut hint (e.g. `F2`). Display only. */
  shortcut?: string
  variant?: 'danger'
  disabled?: boolean
  /** When set, the item is checkable and exposes this checked state.
   *  The VISIBLE marker stays with the caller — pass it as `icon` (leading) or
   *  `trailing`, so a row whose leading slot already carries a target glyph can
   *  still show its check. */
  checked?: boolean
  /** How the checkable items in this menu relate to each other. `single` — the
   *  default — is a set of independent toggles. Pass `'one-of'` when the menu
   *  picks exactly one of a mutually exclusive set (a target, a mode): the row
   *  then announces as `menuitemradio`, so a screen reader says "1 of 3"
   *  instead of offering to uncheck a choice that cannot be unchecked. */
  selection?: 'single' | 'one-of'
  /** Trailing node, after the shortcut. For a check mark on a row whose leading
   *  slot is taken. */
  trailing?: React.ReactNode
  /** Attached to the button, so a host menu with its own roving-focus nav (e.g.
   *  SplitButton) can drive arrow keys through the items. ContextMenu omits it
   *  and keeps its own surface-level handling — same contract as
   *  MenuSwatchRow's `onItemKeyDown`. */
  onKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void
}

export function MenuItem({
  children,
  onClick,
  onContextMenu,
  icon,
  shortcut,
  variant,
  disabled,
  checked,
  selection = 'single',
  trailing,
  onKeyDown,
}: MenuItemProps) {
  const checkableRole = selection === 'one-of' ? 'menuitemradio' : 'menuitemcheckbox'
  return (
    <button
      type="button"
      role={checked !== undefined ? checkableRole : 'menuitem'}
      aria-checked={checked}
      data-menu-item="true"
      tabIndex={-1}
      disabled={disabled}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        variant === 'danger'
          ? 'text-[color:var(--tone-error)] hover:bg-[rgba(255,120,124,0.08)]'
          : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
      } ${FOCUS_RING_CLASS}`}
    >
      {icon ?? null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? (
        <span className="text-micro text-[color:var(--text-disabled)] font-mono">{shortcut}</span>
      ) : null}
      {trailing}
    </button>
  )
}

export function MenuDivider() {
  return <div role="separator" className="my-1 h-px bg-[color:var(--border-subtle)]" />
}

type MenuSwatchRowProps = {
  /** Optional section label rendered above the row (e.g. "Highlight color"). */
  label?: string
  /** Currently applied color; null means no color is applied. */
  value: HighlightColor | null
  onPick: (color: HighlightColor) => void
  onClear: () => void
  /** Optional keydown handler attached to each swatch button, so a host menu
   *  with its own roving-focus nav (e.g. OverflowMenu) can drive arrow keys
   *  through the swatches. ContextMenu omits it and keeps its own handling. */
  onItemKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void
}

// One-tap color choice row: a clear control followed by the seven canonical
// highlight swatches. Swatches behave as a radio group within the menu —
// each is a menuitemradio carrying aria-checked for the applied color.
export function MenuSwatchRow({ label, value, onPick, onClear, onItemKeyDown }: MenuSwatchRowProps) {
  return (
    <>
      {label ? (
        <div className="px-2.5 pb-1 pt-1.5 text-micro font-medium text-[color:var(--text-muted)]">
          {label}
        </div>
      ) : null}
      <div className="flex items-center gap-1 px-2 pb-1.5">
        <Tooltip content="Clear color">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={value === null}
            data-menu-item="true"
            tabIndex={-1}
            onClick={onClear}
            onKeyDown={onItemKeyDown}
            aria-label="Clear color"
            className={`flex h-5 w-5 items-center justify-center rounded-full border border-[color:var(--border-default)] text-[color:var(--text-disabled)] transition-colors hover:border-[color:var(--text-disabled)] hover:text-[color:var(--text-default)] ${
              value === null ? 'ring-1 ring-[color:var(--text-default)]' : ''
            }`}
          >
            <svg viewBox="0 0 12 12" fill="none" className="icon-xs">
              <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </Tooltip>
        {HIGHLIGHT_COLORS.map((color) => {
          const swatch = getHighlightSwatch(color)
          const selected = value === color
          return (
            <Tooltip key={color} content={swatch.label}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                data-menu-item="true"
                tabIndex={-1}
                onClick={() => onPick(color)}
                onKeyDown={onItemKeyDown}
                aria-label={`Highlight ${swatch.label}`}
                className={`h-5 w-5 rounded-full transition-transform hover:scale-110 ${
                  selected ? 'ring-2 ring-offset-1 ring-offset-[color:var(--bg-surface)]' : ''
                }`}
                style={{
                  backgroundColor: swatch.hex,
                  boxShadow: selected ? `0 0 8px ${swatch.ringRgba(0.6)}` : undefined,
                  ['--tw-ring-color' as never]: swatch.hex,
                }}
              />
            </Tooltip>
          )
        })}
      </div>
    </>
  )
}

type MenuFlyoutItemProps = {
  /** Visible item label. */
  label: React.ReactNode
  /** Required accessible name for the nested menu surface. */
  ariaLabel: string
  icon?: React.ReactNode
  disabled?: boolean
  /** Extra classes for the flyout surface — typically a `min-w-[…]` floor. */
  surfaceClassName?: string
  /** Optional keydown handler run before the trigger's own open logic, so a host
   *  menu with its own roving-focus nav (e.g. OverflowMenu) can drive
   *  Up/Down/Home/End through the flyout trigger. ContextMenu omits it and keeps
   *  its own handling; the trigger still owns ArrowRight/Enter/Space to open. */
  onItemKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void
  /** Open-state notifications, e.g. to lazily refresh flyout content. */
  onOpenChange?: (open: boolean) => void
  /** Flyout content: MenuItem / MenuDivider / MenuSwatchRow children. */
  children: React.ReactNode
}

// Close-intent grace period when the pointer crosses the gap between the
// item and its flyout surface.
const FLYOUT_CLOSE_DELAY_MS = 150
// Offset so the flyout's first item top-aligns with the parent item: the
// surface carries p-1 (4px) padding plus a 1px border above its first child.
const FLYOUT_SURFACE_INSET = 5
const FLYOUT_GAP = 2

function MenuFlyoutSurface({
  anchor,
  ariaLabel,
  surfaceClassName,
  onDismiss,
  children,
}: {
  anchor: DOMRect
  ariaLabel: string
  surfaceClassName?: string
  onDismiss: () => void
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Open at the item's right edge; when the viewport is tight, flip to open
  // leftward of the item instead of sliding over the parent menu.
  const pos = useClampedMenuPosition(anchor.right + FLYOUT_GAP, anchor.top - FLYOUT_SURFACE_INSET, ref, {
    flipXTo: anchor.left - FLYOUT_GAP,
  })

  useEffect(() => {
    const surface = ref.current
    const preferred = surface?.querySelector<HTMLElement>('[data-menu-autofocus="true"]')
    if (preferred) preferred.focus()
    else surface?.focus()
  }, [])

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'ArrowLeft') {
          event.preventDefault()
          event.stopPropagation()
          onDismiss()
          return
        }
        roveMenuFocus(event, ref.current)
      }}
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: MENU_Z_INDEX }}
      // design-system-allow: tabIndex -1 flyout surface focused only to seed roving focus; the menu item that takes focus carries the shared ring
      className={`${MENU_SURFACE_CLASS} focus:outline-none ${surfaceClassName ?? ''}`}
    >
      {children}
    </div>
  )
}

// Flyout submenu: a menu item that opens a nested menu surface beside itself
// on hover, click, or ArrowRight. The nested surface stays inside the parent
// menu's DOM so the parent's outside-pointerdown close treats clicks in the
// flyout as inside clicks.
export function MenuFlyoutItem({
  label,
  ariaLabel,
  icon,
  disabled,
  surfaceClassName,
  onItemKeyDown,
  onOpenChange,
  children,
}: MenuFlyoutItemProps) {
  const itemRef = useRef<HTMLButtonElement>(null)
  const closeTimerRef = useRef<number | null>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const open = anchor !== null

  // Notify on open-state transitions only. The callback rides in a ref so an
  // inline consumer lambda (fresh identity per render) can't re-fire the
  // notification on every parent re-render.
  const onOpenChangeRef = useRef(onOpenChange)
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  })
  useEffect(() => {
    onOpenChangeRef.current?.(open)
  }, [open])

  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const openFlyout = useCallback(() => {
    cancelScheduledClose()
    const rect = itemRef.current?.getBoundingClientRect()
    if (rect) setAnchor(rect)
  }, [cancelScheduledClose])

  const closeFlyout = useCallback(() => {
    cancelScheduledClose()
    setAnchor(null)
  }, [cancelScheduledClose])

  const scheduleClose = useCallback(() => {
    cancelScheduledClose()
    closeTimerRef.current = window.setTimeout(() => setAnchor(null), FLYOUT_CLOSE_DELAY_MS)
  }, [cancelScheduledClose])

  useEffect(() => cancelScheduledClose, [cancelScheduledClose])

  return (
    <div role="none" onMouseEnter={cancelScheduledClose} onMouseLeave={scheduleClose}>
      <button
        ref={itemRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        data-menu-item="true"
        tabIndex={-1}
        disabled={disabled}
        onMouseEnter={() => {
          if (!disabled) openFlyout()
        }}
        onClick={() => {
          if (disabled) return
          if (open) closeFlyout()
          else openFlyout()
        }}
        onKeyDown={(event) => {
          if (disabled) return
          // Let a host menu drive its roving focus first (Up/Down/Home/End); the
          // trigger still owns ArrowRight/Enter/Space to open the flyout.
          onItemKeyDown?.(event)
          if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            openFlyout()
          }
        }}
        className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${
          open ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]' : ''
        } ${FOCUS_RING_CLASS}`}
      >
        {icon ?? null}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0 text-[color:var(--text-disabled)]" aria-hidden="true">
          <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {anchor ? (
        <MenuFlyoutSurface
          anchor={anchor}
          ariaLabel={ariaLabel}
          surfaceClassName={surfaceClassName}
          onDismiss={() => {
            closeFlyout()
            itemRef.current?.focus()
          }}
        >
          {children}
        </MenuFlyoutSurface>
      ) : null}
    </div>
  )
}
