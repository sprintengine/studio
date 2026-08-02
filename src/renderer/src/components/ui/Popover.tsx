import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

type PopoverRenderTriggerArgs = {
  ref: { current: HTMLButtonElement | null }
  open: boolean
  openPopover: () => void
  closePopover: (restoreFocus?: boolean) => void
  togglePopover: () => void
  triggerProps: {
    'aria-haspopup': 'menu' | 'listbox' | 'dialog' | 'true'
    'aria-expanded': boolean
    'aria-controls': string | undefined
  }
}

type PopoverSurfaceElement = 'div' | 'ul'

type PopoverProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  ariaLabel: string
  popupRole: 'menu' | 'listbox' | 'dialog'
  renderTrigger: (args: PopoverRenderTriggerArgs) => React.ReactNode
  children: React.ReactNode
  placement?: PopoverPlacement
  className?: string
  surfaceClassName?: string
  surfaceAs?: PopoverSurfaceElement
  onOpenAutoFocus?: (surface: HTMLElement) => void
}

// The surface is portaled to <body> and positioned with fixed coordinates so it
// can never be clipped by an ancestor's overflow. Gap matches the former mt-1/mb-1.
const SURFACE_GAP = 4
const VIEWPORT_EDGE = 8

// The surface is anchored by the CSS edge nearest the trigger (right for `end`,
// left for `start`; bottom for flipped-up, top otherwise) so its measured size
// never enters the horizontal math — the chosen edge stays glued to the trigger
// and can't drift by a surface-width if the measurement is momentarily off.
type SurfacePosition = {
  top?: number
  bottom?: number
  left?: number
  right?: number
  triggerWidth: number
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.max(min, Math.min(value, max))
}

function computeSurfacePosition(
  trigger: DOMRect,
  surfaceWidth: number,
  surfaceHeight: number,
  placement: PopoverPlacement,
): SurfacePosition {
  const vw = window.innerWidth
  const vh = window.innerHeight

  const wantsBottom = placement.startsWith('bottom')
  const spaceBelow = vh - trigger.bottom - VIEWPORT_EDGE
  const spaceAbove = trigger.top - VIEWPORT_EDGE
  let onBottom = wantsBottom
  if (wantsBottom && surfaceHeight + SURFACE_GAP > spaceBelow && spaceAbove > spaceBelow) onBottom = false
  if (!wantsBottom && surfaceHeight + SURFACE_GAP > spaceAbove && spaceBelow > spaceAbove) onBottom = true

  const vertical = onBottom
    ? { top: clamp(trigger.bottom + SURFACE_GAP, VIEWPORT_EDGE, vh - surfaceHeight - VIEWPORT_EDGE) }
    : { bottom: clamp(vh - trigger.top + SURFACE_GAP, VIEWPORT_EDGE, vh - surfaceHeight - VIEWPORT_EDGE) }

  // Anchor the end-aligned surface by its right edge and the start-aligned one by
  // its left edge. Width only feeds an overflow guard so a surface wider than the
  // space on its anchored side flips to the opposite edge instead of clipping.
  const wantsEnd = placement.endsWith('end')
  const overflowsLeft = wantsEnd && trigger.right - surfaceWidth < VIEWPORT_EDGE
  const overflowsRight = !wantsEnd && trigger.left + surfaceWidth > vw - VIEWPORT_EDGE
  const horizontal =
    (wantsEnd && !overflowsLeft) || overflowsRight
      ? { right: clamp(vw - trigger.right, VIEWPORT_EDGE, vw - surfaceWidth - VIEWPORT_EDGE) }
      : { left: clamp(trigger.left, VIEWPORT_EDGE, vw - surfaceWidth - VIEWPORT_EDGE) }

  return { ...vertical, ...horizontal, triggerWidth: trigger.width }
}

// Open popovers in stacking order, each with its own surface. The surface is
// carried (not just the id) so a popover can tell whether a pointer landed in
// one stacked ABOVE it — see the outside-click guard below.
type OpenPopoverEntry = { id: string; surface: React.MutableRefObject<HTMLElement | null> }

const openPopoverStack: OpenPopoverEntry[] = []

function indexOfOpenPopover(id: string): number {
  return openPopoverStack.findIndex((entry) => entry.id === id)
}

function pushOpenPopover(id: string, surface: React.MutableRefObject<HTMLElement | null>): void {
  const existing = indexOfOpenPopover(id)
  if (existing >= 0) openPopoverStack.splice(existing, 1)
  openPopoverStack.push({ id, surface })
}

function removeOpenPopover(id: string): void {
  const existing = indexOfOpenPopover(id)
  if (existing >= 0) openPopoverStack.splice(existing, 1)
}

function isTopmostPopover(id: string): boolean {
  return openPopoverStack[openPopoverStack.length - 1]?.id === id
}

// Every surface is portaled to <body>, so a popover opened FROM inside another
// one is not a DOM descendant of it — `surface.contains(target)` reads a click
// on the nested surface as an outside click. Dismissing on that mousedown
// unmounts the nested popover before its own click lands, so the choice the
// user just made is silently dropped. Anything stacked above this popover
// therefore counts as inside it.
function pointerLandedInPopoverAbove(id: string, target: Node): boolean {
  const index = indexOfOpenPopover(id)
  if (index < 0) return false
  return openPopoverStack.slice(index + 1).some((entry) => entry.surface.current?.contains(target))
}

export function Popover({
  open,
  onOpenChange,
  ariaLabel,
  popupRole,
  renderTrigger,
  children,
  placement = 'bottom-start',
  className,
  surfaceClassName,
  surfaceAs = 'div',
  onOpenAutoFocus,
}: PopoverProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  // Wrapper around the trigger. Used as the positioning anchor when a caller's
  // renderTrigger doesn't forward `ref` to a button (e.g. a trigger that is itself
  // a composite control like OverflowMenu). The wrapper is `relative inline-flex`,
  // so it shrink-wraps the trigger and its rect matches it closely enough to anchor.
  const containerRef = useRef<HTMLDivElement | null>(null)
  const surfaceRef = useRef<HTMLElement | null>(null)
  const popoverId = useId()
  const [position, setPosition] = useState<SurfacePosition | null>(null)

  const closePopover = useCallback(
    (restoreFocus = true) => {
      onOpenChange(false)
      if (restoreFocus) triggerRef.current?.focus()
    },
    [onOpenChange],
  )

  const openPopover = useCallback(() => {
    onOpenChange(true)
  }, [onOpenChange])

  const togglePopover = useCallback(() => {
    onOpenChange(!open)
  }, [onOpenChange, open])

  useEffect(() => {
    if (!open) return
    const surface = surfaceRef.current
    if (surface) onOpenAutoFocus?.(surface)
  }, [open, onOpenAutoFocus])

  // Measure the trigger and surface once open, then anchor the surface with fixed
  // coordinates. Reposition on viewport resize and on scroll anywhere in the tree
  // (capture phase) so the menu tracks its trigger inside scrollable panels.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const reposition = () => {
      const anchor = triggerRef.current ?? containerRef.current
      const surface = surfaceRef.current
      if (!anchor || !surface) return
      const triggerRect = anchor.getBoundingClientRect()
      setPosition(
        computeSurfacePosition(triggerRect, surface.offsetWidth, surface.offsetHeight, placement),
      )
    }
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, placement])

  useEffect(() => {
    if (!open) return
    pushOpenPopover(popoverId, surfaceRef)
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (surfaceRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      if (pointerLandedInPopoverAbove(popoverId, target)) return
      onOpenChange(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (!isTopmostPopover(popoverId)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        closePopover(true)
      }
    }
    window.addEventListener('mousedown', onPointer)
    // On document, not window: hosting dialogs key their own Escape handlers off
    // event.defaultPrevented, but their window listeners are registered at mount
    // — before this one — and same-target listeners fire in registration order.
    // Document bubble listeners always run before window listeners, so the
    // popover consumes Escape first regardless of when it opened.
    document.addEventListener('keydown', onKey)
    return () => {
      removeOpenPopover(popoverId)
      window.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, closePopover, onOpenChange, popoverId])

  const Surface = surfaceAs

  return (
    <div ref={containerRef} className={['relative inline-flex', className ?? ''].join(' ')}>
      {renderTrigger({
        ref: triggerRef,
        open,
        openPopover,
        closePopover,
        togglePopover,
        triggerProps: {
          'aria-haspopup': popupRole === 'dialog' ? 'dialog' : popupRole,
          'aria-expanded': open,
          'aria-controls': open ? popoverId : undefined,
        },
      })}
      {open
        ? createPortal(
            <Surface
              ref={surfaceRef as React.Ref<never>}
              id={popoverId}
              role={popupRole}
              aria-label={ariaLabel}
              style={{
                position: 'fixed',
                top: position?.top,
                bottom: position?.bottom,
                left: position?.left,
                right: position?.right,
                // Exposed so width-coupled surfaces (Select, Sprint Engine listboxes)
                // can match the trigger via min-w-[var(--popover-trigger-width)]
                // without an inline width that would clobber their own min-w floor.
                ['--popover-trigger-width' as string]: position ? `${position.triggerWidth}px` : undefined,
                // Hidden until measured so the first paint never flashes at 0,0.
                visibility: position ? 'visible' : 'hidden',
              }}
              className={[
                // design-tokens-allow: canonical popover elevation shared by anchored app-shell surfaces
                'popover-enter z-50 rounded-[7px] border border-[color:var(--border-strong)]',
                'bg-[color:var(--bg-surface-raised)] shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]',
                surfaceClassName ?? '',
              ].join(' ')}
            >
              {children}
            </Surface>,
            document.body,
          )
        : null}
    </div>
  )
}

export type { PopoverProps }
