import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import SettingsPanel from './SettingsPanel'

type LifecycleState = 'closed' | 'entering' | 'open' | 'closing'

const EXIT_FALLBACK_MS = 320

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export default function SettingsOverlay() {
  const overlay = useWorkspaceStore((s) => s.settingsOverlay)
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)
  const closeSettingsOverlay = useWorkspaceStore((s) => s.closeSettingsOverlay)

  const [lifecycle, setLifecycle] = useState<LifecycleState>('closed')
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const exitTimerRef = useRef<number | null>(null)
  const enterFrameRef = useRef<number | null>(null)

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
      } else {
        const fallback = document.querySelector<HTMLElement>('[aria-label="Settings"]')
        fallback?.focus()
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
      if (panelRef.current && !panelRef.current.contains(document.activeElement)) {
        panelRef.current.focus()
      }
    })
    return () => window.cancelAnimationFrame(handle)
  }, [lifecycle])

  useEffect(() => {
    if (lifecycle === 'closed') return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeSettingsOverlay()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lifecycle, closeSettingsOverlay])

  const trapFocus = useCallback((position: 'start' | 'end') => () => {
    const root = panelRef.current
    if (!root) return
    const focusables = Array.from(
      root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => !el.hasAttribute('data-focus-sentinel'))
    if (focusables.length === 0) {
      root.focus()
      return
    }
    if (position === 'start') focusables[focusables.length - 1].focus()
    else focusables[0].focus()
  }, [])

  const handleOpenSettingsTab = useCallback((tabId: string) => {
    openSettingsOverlay({ initialTab: tabId })
  }, [openSettingsOverlay])

  if (lifecycle === 'closed') return null

  return (
    <div className="absolute inset-0 z-40">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[color:var(--bg-app,#08090b)]/55 transition-opacity duration-200"
        style={{ opacity: lifecycle === 'open' ? 1 : 0 }}
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
        aria-labelledby="settings-overlay-title"
        tabIndex={-1}
        data-state={lifecycle}
        className="settings-overlay-panel absolute inset-y-0 right-0 flex h-full w-full flex-col border-l border-[color:var(--border-subtle,rgba(255,255,255,0.06))] bg-[color:var(--bg-surface,#0d0e11)] outline-none"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#1f2025] bg-[#0d0e11] px-4 py-3">
          <div className="min-w-0">
            <h2
              id="settings-overlay-title"
              className="truncate text-[15px] font-semibold tracking-tight text-[#ececee]"
            >
              Settings
            </h2>
            <p className="mt-0.5 truncate text-[12px] leading-5 text-[#8a8a92]">
              Configure local CLIs, workspace paths, updates, and telemetry.
            </p>
          </div>
          <button
            type="button"
            onClick={closeSettingsOverlay}
            aria-label="Close settings"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#24252b] bg-[#111216] text-[#9a9aa2] transition-colors hover:border-[#303139] hover:bg-[#17181d] hover:text-[#ececee] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60"
          >
            <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="min-h-0 flex-1">
          <SettingsPanel
            chrome="overlay"
            initialTab={overlay.initialTab}
            checkForUpdatesRequestId={overlay.checkForUpdatesRequestId ?? undefined}
            onOpenSettingsTab={handleOpenSettingsTab}
            onClose={closeSettingsOverlay}
          />
        </div>
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
