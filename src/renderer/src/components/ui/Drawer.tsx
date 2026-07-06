// Canonical right-slide-in Drawer primitive. Consumers do not roll their own
// drawer chrome: this primitive owns the elevation (`--shadow-drawer`), the
// slide-in motion (.drawer-panel + `--motion-deliberate`), focus capture,
// Escape close, focus restoration to the opener, and body scroll-lock.
//
// API matches the architect plan (T3):
//   <Drawer open onClose title ariaLabel>
//     <Drawer.Body>...</Drawer.Body>
//   </Drawer>
//
// Consumer migration (Switchboard runner, Watchtower active review, Sprint
// Engine inspector) is T11, not this task.

import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { CloseIconButton } from './Buttons'
import { TruncatedText } from './TruncatedText'

type DrawerLifecycle = 'closed' | 'entering' | 'open' | 'closing'

const EXIT_FALLBACK_MS = 320

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

type DrawerProps = {
  open: boolean
  onClose: () => void
  /** Visible header title. */
  title: string
  /** Accessible name for the dialog. Use a sentence that matches the drawer purpose. */
  ariaLabel: string
  /** Drawer width in pixels. Defaults to 360, the shared panel-aside width. */
  width?: number
  children: React.ReactNode
}

function DrawerRoot({ open, onClose, title, ariaLabel, width = 360, children }: DrawerProps) {
  const [lifecycle, setLifecycle] = useState<DrawerLifecycle>('closed')
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const exitTimerRef = useRef<number | null>(null)
  const enterFrameRef = useRef<number | null>(null)
  const titleId = useId()

  useEffect(() => {
    if (open) {
      if (lifecycle === 'closed') {
        const active = document.activeElement
        restoreFocusRef.current = active instanceof HTMLElement ? active : null
        setLifecycle('entering')
      } else if (lifecycle === 'closing') {
        if (exitTimerRef.current !== null) {
          window.clearTimeout(exitTimerRef.current)
          exitTimerRef.current = null
        }
        setLifecycle('open')
      }
      return
    }

    if (!open && (lifecycle === 'open' || lifecycle === 'entering')) {
      setLifecycle('closing')
    }
  }, [open, lifecycle])

  useEffect(() => {
    if (lifecycle !== 'entering') return undefined
    enterFrameRef.current = window.requestAnimationFrame(() => {
      enterFrameRef.current = window.requestAnimationFrame(() => {
        setLifecycle('open')
      })
    })
    return () => {
      if (enterFrameRef.current !== null) {
        window.cancelAnimationFrame(enterFrameRef.current)
        enterFrameRef.current = null
      }
    }
  }, [lifecycle])

  useEffect(() => {
    if (lifecycle !== 'closing') return undefined
    const reduced = prefersReducedMotion()
    const finish = () => {
      setLifecycle('closed')
      exitTimerRef.current = null
      const target = restoreFocusRef.current
      restoreFocusRef.current = null
      if (target && document.contains(target)) {
        target.focus()
      }
    }
    if (reduced) {
      finish()
      return undefined
    }
    exitTimerRef.current = window.setTimeout(finish, EXIT_FALLBACK_MS)
    return () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current)
        exitTimerRef.current = null
      }
    }
  }, [lifecycle])

  // Move focus into the panel when it lands open.
  useEffect(() => {
    if (lifecycle !== 'open') return undefined
    const handle = window.requestAnimationFrame(() => {
      const node = panelRef.current
      if (!node) return
      if (node.contains(document.activeElement)) return
      node.focus()
    })
    return () => window.cancelAnimationFrame(handle)
  }, [lifecycle])

  // Body scroll-lock while the drawer is mounted.
  useEffect(() => {
    if (lifecycle === 'closed') return undefined
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [lifecycle])

  // Escape close.
  useEffect(() => {
    if (lifecycle === 'closed') return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lifecycle, onClose])

  const trapFocus = useCallback(
    (position: 'start' | 'end') => () => {
      const root = panelRef.current
      if (!root) return
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => !el.hasAttribute('data-focus-sentinel'),
      )
      if (focusables.length === 0) {
        root.focus()
        return
      }
      if (position === 'start') focusables[focusables.length - 1].focus()
      else focusables[0].focus()
    },
    [],
  )

  if (lifecycle === 'closed') return null

  return (
    <div className="fixed inset-0 z-40">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[color:var(--surface-overlay-backdrop)] backdrop-blur-sm transition-opacity duration-200"
        style={{ opacity: lifecycle === 'open' ? 1 : 0 }}
        onMouseDown={onClose}
      />

      <div
        data-focus-sentinel="true"
        tabIndex={0}
        onFocus={trapFocus('start')}
        className="sr-only"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="false"
        aria-label={ariaLabel}
        aria-labelledby={titleId}
        tabIndex={-1}
        data-state={lifecycle}
        style={{ width }}
        className="drawer-panel absolute inset-y-0 right-0 flex h-full max-w-full flex-col border-l border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] outline-none"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[color:var(--border-default)] px-3 py-2">
          <TruncatedText
            as="h2"
            id={titleId}
            text={title}
            className="text-[length:var(--text-size-md)] font-semibold tracking-tight text-[color:var(--text-strong)]"
          />
          <CloseIconButton aria-label="Close" onClick={onClose} />
        </header>

        {children}
      </div>

      <div
        data-focus-sentinel="true"
        tabIndex={0}
        onFocus={trapFocus('end')}
        className="sr-only"
      />
    </div>
  )
}

function DrawerBody({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={[
        'min-h-0 flex-1 overflow-auto px-3 py-3 text-[length:var(--text-size-sm)] text-[color:var(--text-default)]',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </div>
  )
}

export const Drawer = Object.assign(DrawerRoot, { Body: DrawerBody })
export type { DrawerProps }
