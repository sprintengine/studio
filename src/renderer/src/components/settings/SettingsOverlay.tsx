// Centered Settings modal. Renders SettingsPanel (chrome="overlay") inside a
// constrained dialog surface with a dimmed backdrop, so the rail and content
// cluster in screen center instead of drifting to the left bezel. Owns focus
// capture, Escape close, body scroll-lock, focus restoration, and
// click-outside-to-close.

import React, { Suspense, useCallback, useEffect, useId, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { SuspenseFallback } from '../ui/SuspenseFallback'

// Lazy so the (large) settings UI is code-split out of the eager boot chunk and
// only fetched when the overlay first opens. The overlay renders null until then.
const SettingsPanel = React.lazy(() => import('./SettingsPanel'))

type Lifecycle = 'closed' | 'entering' | 'open' | 'closing'

const EXIT_FALLBACK_MS = 200

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export default function SettingsOverlay() {
  const overlay = useWorkspaceStore((s) => s.settingsOverlay)
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)
  const closeSettingsOverlay = useWorkspaceStore((s) => s.closeSettingsOverlay)

  const surfaceRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const exitTimerRef = useRef<number | null>(null)
  const enterFrameRef = useRef<number | null>(null)
  const [lifecycle, setLifecycle] = useState<Lifecycle>('closed')
  const titleId = useId()

  useEffect(() => {
    if (overlay.open) {
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
    if (!overlay.open && (lifecycle === 'open' || lifecycle === 'entering')) {
      setLifecycle('closing')
    }
  }, [overlay.open, lifecycle])

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

  useEffect(() => {
    if (lifecycle !== 'open') return undefined
    const handle = window.requestAnimationFrame(() => {
      const node = surfaceRef.current
      if (!node) return
      if (node.contains(document.activeElement)) return
      node.focus()
    })
    return () => window.cancelAnimationFrame(handle)
  }, [lifecycle])

  useEffect(() => {
    if (lifecycle === 'closed') return undefined
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [lifecycle])

  useEffect(() => {
    if (lifecycle === 'closed') return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeSettingsOverlay()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lifecycle, closeSettingsOverlay])

  const trapFocus = useCallback(
    (position: 'start' | 'end') => () => {
      const root = surfaceRef.current
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

  const handleOpenSettingsTab = useCallback(
    (tabId: string) => {
      openSettingsOverlay({ initialTab: tabId })
    },
    [openSettingsOverlay],
  )

  if (lifecycle === 'closed') return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-state={lifecycle}
      className="settings-route overlay-scrim fixed inset-0 z-50 flex items-center justify-center p-4 outline-none sm:p-8 lg:p-12"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeSettingsOverlay()
      }}
    >
      <div
        data-focus-sentinel="true"
        tabIndex={0}
        onFocus={trapFocus('start')}
        className="sr-only"
      />
      <div
        ref={surfaceRef}
        tabIndex={-1}
        className="flex h-full max-h-[min(760px,calc(100vh-2rem))] w-full max-w-[1080px] flex-col overflow-hidden rounded-[8px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] shadow-[var(--shadow-drawer)] outline-none"
      >
        <Suspense fallback={<SuspenseFallback label="Loading settings" />}>
          <SettingsPanel
            chrome="overlay"
            titleId={titleId}
            initialTab={overlay.initialTab}
            checkForUpdatesRequestId={overlay.checkForUpdatesRequestId ?? undefined}
            onOpenSettingsTab={handleOpenSettingsTab}
            onClose={closeSettingsOverlay}
          />
        </Suspense>
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
