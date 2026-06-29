// Guided-brief studio column widths and resize helpers.
//
// Every guided-brief stage shares one three-column studio: activity (terminal
// or interview) | artifacts | preview. The first two columns are user-resizable
// by dragging the divider on their right edge; the preview column flexes to take
// the remaining space. Widths are persisted to localStorage so a drag survives
// renderer reloads and stage transitions. Kept in one module so the component,
// the drag math, and the persistence keys can never disagree — same shape as
// sidebarWidth.ts.

import { useCallback, useEffect, useRef, useState } from 'react'

export const ACTIVITY_DEFAULT_WIDTH = 360
export const ACTIVITY_MIN_WIDTH = 280
export const ACTIVITY_MAX_WIDTH = 760

export const ARTIFACTS_DEFAULT_WIDTH = 340
export const ARTIFACTS_MIN_WIDTH = 240
export const ARTIFACTS_MAX_WIDTH = 560

// Below this viewport width the studio stacks vertically and the widths do not
// apply (matches Tailwind's `lg` breakpoint used elsewhere in the studio).
const DESKTOP_MIN_VIEWPORT = 1024

const ACTIVITY_STORAGE_KEY = 'guidedBrief.studio.activityWidth'
const ARTIFACTS_STORAGE_KEY = 'guidedBrief.studio.artifactsWidth'

export type StudioColumn = 'activity' | 'artifacts'

const BOUNDS: Record<StudioColumn, { min: number; max: number; fallback: number; key: string }> = {
  activity: {
    min: ACTIVITY_MIN_WIDTH,
    max: ACTIVITY_MAX_WIDTH,
    fallback: ACTIVITY_DEFAULT_WIDTH,
    key: ACTIVITY_STORAGE_KEY,
  },
  artifacts: {
    min: ARTIFACTS_MIN_WIDTH,
    max: ARTIFACTS_MAX_WIDTH,
    fallback: ARTIFACTS_DEFAULT_WIDTH,
    key: ARTIFACTS_STORAGE_KEY,
  },
}

export function clampStudioColumnWidth(column: StudioColumn, width: number): number {
  const { min, max, fallback } = BOUNDS[column]
  if (!Number.isFinite(width)) return fallback
  return Math.min(max, Math.max(min, Math.round(width)))
}

function readPersistedWidth(column: StudioColumn): number {
  const { key, fallback } = BOUNDS[column]
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    return clampStudioColumnWidth(column, Number.parseFloat(raw))
  } catch {
    return fallback
  }
}

function persistWidth(column: StudioColumn, width: number): void {
  try {
    window.localStorage.setItem(BOUNDS[column].key, String(width))
  } catch {
    // Persistence is best-effort; an unavailable localStorage just means the
    // width resets to the default on the next mount.
  }
}

function readIsDesktop(): boolean {
  try {
    return window.matchMedia(`(min-width: ${DESKTOP_MIN_VIEWPORT}px)`).matches
  } catch {
    return true
  }
}

export type StageStudioColumnsState = {
  /** True at desktop widths, where the columns lay out side by side. */
  isDesktop: boolean
  activityWidth: number
  artifactsWidth: number
  /** Whether a divider drag is in progress (drives handle styling). */
  resizing: StudioColumn | null
  /** Pointer-down handler for a column's right-edge divider. */
  startResize: (column: StudioColumn) => (event: React.PointerEvent<HTMLDivElement>) => void
  /** Keyboard nudge (±16px) and Home-to-reset for an accessible divider. */
  handleResizeKeyDown: (column: StudioColumn) => (event: React.KeyboardEvent<HTMLDivElement>) => void
}

const KEYBOARD_STEP = 16

// Drives the resizable studio columns: tracks the two widths, persists them,
// and exposes pointer + keyboard handlers that mirror the workspace sidebar's
// resize ergonomics (rAF-batched pointer moves, col-resize cursor, arrow-key
// nudges, Home to reset).
export function useStageStudioColumns(): StageStudioColumnsState {
  const [isDesktop, setIsDesktop] = useState(readIsDesktop)
  const [activityWidth, setActivityWidth] = useState(() => readPersistedWidth('activity'))
  const [artifactsWidth, setArtifactsWidth] = useState(() => readPersistedWidth('artifacts'))
  const [resizing, setResizing] = useState<StudioColumn | null>(null)

  const widthsRef = useRef({ activity: activityWidth, artifacts: artifactsWidth })
  widthsRef.current = { activity: activityWidth, artifacts: artifactsWidth }

  useEffect(() => {
    let media: MediaQueryList
    try {
      media = window.matchMedia(`(min-width: ${DESKTOP_MIN_VIEWPORT}px)`)
    } catch {
      return
    }
    const onChange = () => setIsDesktop(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const setWidth = useCallback((column: StudioColumn, next: number) => {
    const clamped = clampStudioColumnWidth(column, next)
    if (column === 'activity') setActivityWidth(clamped)
    else setArtifactsWidth(clamped)
    persistWidth(column, clamped)
  }, [])

  const startResize = useCallback(
    (column: StudioColumn) => (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      const startX = event.clientX
      const startWidth = widthsRef.current[column]
      let frame: number | null = null
      let pendingX = startX

      const apply = () => {
        frame = null
        setWidth(column, startWidth + (pendingX - startX))
      }
      const onMove = (e: PointerEvent) => {
        pendingX = e.clientX
        if (frame === null) frame = window.requestAnimationFrame(apply)
      }
      const onUp = () => {
        if (frame !== null) window.cancelAnimationFrame(frame)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setResizing(null)
      }
      setResizing(column)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [setWidth],
  )

  const handleResizeKeyDown = useCallback(
    (column: StudioColumn) => (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setWidth(column, widthsRef.current[column] - KEYBOARD_STEP)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        setWidth(column, widthsRef.current[column] + KEYBOARD_STEP)
      } else if (event.key === 'Home') {
        event.preventDefault()
        setWidth(column, BOUNDS[column].fallback)
      }
    },
    [setWidth],
  )

  return {
    isDesktop,
    activityWidth,
    artifactsWidth,
    resizing,
    startResize,
    handleResizeKeyDown,
  }
}
