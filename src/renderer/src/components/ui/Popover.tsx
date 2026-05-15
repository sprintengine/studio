import React, { useCallback, useEffect, useId, useRef } from 'react'

export type PopoverPlacement = 'bottom-start' | 'bottom-end'

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

const PLACEMENT_CLASS: Record<PopoverPlacement, string> = {
  'bottom-start': 'left-0 top-full',
  'bottom-end': 'right-0 top-full',
}

const openPopoverStack: string[] = []

function pushOpenPopover(id: string): void {
  const existing = openPopoverStack.indexOf(id)
  if (existing >= 0) openPopoverStack.splice(existing, 1)
  openPopoverStack.push(id)
}

function removeOpenPopover(id: string): void {
  const existing = openPopoverStack.indexOf(id)
  if (existing >= 0) openPopoverStack.splice(existing, 1)
}

function isTopmostPopover(id: string): boolean {
  return openPopoverStack[openPopoverStack.length - 1] === id
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
  const surfaceRef = useRef<HTMLElement | null>(null)
  const popoverId = useId()

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

  useEffect(() => {
    if (!open) return
    pushOpenPopover(popoverId)
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (surfaceRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
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
    window.addEventListener('keydown', onKey)
    return () => {
      removeOpenPopover(popoverId)
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, closePopover, onOpenChange, popoverId])

  const Surface = surfaceAs

  return (
    <div className={['relative inline-flex', className ?? ''].join(' ')}>
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
      {open ? (
        <Surface
          ref={surfaceRef as React.Ref<never>}
          id={popoverId}
          role={popupRole}
          aria-label={ariaLabel}
          className={[
            // design-tokens-allow: canonical popover elevation shared by anchored app-shell surfaces
            'popover-enter absolute z-30 mt-1 rounded-[7px] border border-[color:var(--border-strong)]',
            'bg-[color:var(--bg-surface-raised)] shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]',
            PLACEMENT_CLASS[placement],
            surfaceClassName ?? '',
          ].join(' ')}
        >
          {children}
        </Surface>
      ) : null}
    </div>
  )
}

export type { PopoverProps }
