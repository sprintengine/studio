import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useClampedMenuPosition } from './ContextMenu'

type PointerPopoverProps = {
  /** Viewport x of the open point (e.g. `event.clientX` or a button corner). */
  x: number
  /** Viewport y of the open point. */
  y: number
  /** Required accessible name for the surface. */
  ariaLabel: string
  onClose: () => void
  children: React.ReactNode
  /** ARIA role for the surface. Defaults to `menu`. */
  popupRole?: 'menu' | 'listbox' | 'dialog'
  /** Extra surface classes — typically a width floor. */
  surfaceClassName?: string
}

// Pointer-positioned popover for RICH content — the coordinate-anchored analog of
// `Popover` (which anchors to a trigger element) and the rich-content counterpart
// to `ContextMenu` (which is for roving menu-item lists only). Opens at a viewport
// point, clamps inside the viewport, and dismisses on outside pointerdown or
// Escape. Children own their own internal roles; the surface carries the popup
// role so a portaled rich body (search field, listboxes, nested flyouts that
// position themselves `fixed`) reads as one menu/dialog.
//
// Nested `fixed` flyouts rendered by the children stay DOM descendants of this
// surface, so the contains() check keeps them from dismissing their own parent.
export function PointerPopover({
  x,
  y,
  ariaLabel,
  onClose,
  children,
  popupRole = 'menu',
  surfaceClassName,
}: PointerPopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const pos = useClampedMenuPosition(x, y, ref)

  const restoreFocus = useCallback(() => {
    previousFocusRef.current?.focus()
  }, [])

  // Capture the opener so a close (Escape or keyboard activation inside the
  // surface) hands focus back. The cleanup runs before the node leaves the DOM,
  // so focus is restored only when it was still inside the menu.
  useLayoutEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null
    const surface = ref.current
    return () => {
      if (surface?.contains(document.activeElement)) restoreFocus()
    }
  }, [restoreFocus])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    // Bubble phase + defaultPrevented guard so rich children (e.g. a nested chip
    // flyout that closes itself on Escape) can handle the key first, matching
    // Popover/ContextMenu.
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
      role={popupRole}
      aria-label={ariaLabel}
      // zIndex 60 keeps it above the z-50 Popover/Tooltip layer, matching ContextMenu.
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 60 }}
      className={[
        'rounded-[7px] border border-[color:var(--border-strong)]',
        // design-tokens-allow: canonical popover elevation shared by anchored app-shell surfaces (matches Popover)
        'bg-[color:var(--bg-surface-raised)] shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]',
        surfaceClassName ?? '',
      ].join(' ')}
    >
      {children}
    </div>,
    document.body,
  )
}
