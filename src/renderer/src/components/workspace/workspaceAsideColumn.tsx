import React, { useCallback, useRef } from 'react'

import { FOCUS_RING_CLASS } from '../ui/tokens'
import {
  WORKSPACE_ASIDE_DEFAULT_WIDTH,
  WORKSPACE_ASIDE_MIN_WIDTH,
  clampWorkspaceAsideWidth,
} from './workspaceAsideWidth'

// The workspace aside: the right-docked, width-consuming column that sits
// OUTSIDE the rounded workspace card, on the same --bg-app gutter as the
// workspace sidebar. Chrome only — the width, the drag-to-resize edge, and the
// labelled landmark. The workspace pane (pane/WorkspacePaneColumn.tsx) is its
// tenant since the browser-pane epic. Store-free by design: the caller owns
// where the width lives, so this renders identically under the app store and
// under a test harness.
//
// It is a side-pane in the design system's sense (components/side-pane): in
// the document flow, one hairline on its inner edge, no shadow. `collapsed`
// keeps the column mounted at zero width so a tenant's retained content (a
// terminal, a browser page) survives the pane closing; `fill` is the
// expanded variant that takes the whole row and drops the hairline.

type WorkspaceAsideColumnProps = {
  /** Accessible name for the column landmark — the tenant's surface name. */
  label: string
  width: number
  /** Called once on pointer-up / key step, never per drag frame. */
  onWidthChange: (width: number) => void
  /** Mounted but zero-width: hidden from the accessibility tree, no handle. */
  collapsed?: boolean
  /** Take the whole row (the caller hides the neighbour); no inner hairline. */
  fill?: boolean
  children: React.ReactNode
}

export function WorkspaceAsideColumn({
  label,
  width,
  onWidthChange,
  collapsed = false,
  fill = false,
  children,
}: WorkspaceAsideColumnProps) {
  const asideRef = useRef<HTMLElement>(null)
  // Live width during an active drag — written straight to the element (never
  // through `onWidthChange`) so no frame pays for a persisted-registry
  // re-serialization; the final width is reported once on pointer-up. A stray
  // re-render mid-drag re-reads this ref instead of snapping back to the stale
  // committed value. Same idiom as the workspace sidebar's resize.
  const dragWidthRef = useRef<number | null>(null)

  // Drag the column's left edge to resize. The column is right-docked, so
  // moving the pointer LEFT widens it. rAF-coalesced: at most one pure DOM
  // width write per frame.
  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      const startX = event.clientX
      const startWidth = dragWidthRef.current ?? width
      let frame: number | null = null
      let pendingX = startX
      dragWidthRef.current = startWidth

      const apply = () => {
        frame = null
        const next = clampWorkspaceAsideWidth(startWidth + (startX - pendingX))
        dragWidthRef.current = next
        if (asideRef.current) asideRef.current.style.width = `${next}px`
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
        const finalWidth = dragWidthRef.current
        dragWidthRef.current = null
        if (finalWidth !== null) onWidthChange(finalWidth)
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [width, onWidthChange],
  )

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const STEP = 16
      // Left edge of a right-docked column: ArrowLeft widens.
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        onWidthChange(width + STEP)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        onWidthChange(Math.max(WORKSPACE_ASIDE_MIN_WIDTH, width - STEP))
      } else if (event.key === 'Home') {
        event.preventDefault()
        onWidthChange(WORKSPACE_ASIDE_DEFAULT_WIDTH)
      }
    },
    [width, onWidthChange],
  )

  const resizable = !collapsed && !fill
  const columnStyle: React.CSSProperties = collapsed
    ? { width: 0 }
    : fill
      ? {}
      : { width: clampWorkspaceAsideWidth(dragWidthRef.current ?? width) }

  return (
    <aside
      ref={asideRef}
      aria-label={label}
      aria-hidden={collapsed || undefined}
      className={[
        'flex h-full shrink-0 flex-col overflow-hidden bg-[color:var(--bg-canvas)]',
        // Filling: the column floats over its row (the caller's `relative`
        // wrapper) rather than growing beside the content, so the terminals
        // underneath keep their size and nothing reflows on maximise.
        fill ? 'absolute inset-0 z-[var(--z-pane)]' : 'relative',
        // The side-pane's one hairline, on the inner edge. Dropped when the
        // column fills the row: there is nothing left to separate from.
        resizable ? 'border-l border-[color:var(--border-default)]' : '',
      ].join(' ')}
      // No entrance animation on purpose: animating the width reflows the whole
      // workspace card (terminals included) every frame and reads as lag. The
      // column mounts instantly, like the workspace sidebar. During a drag the
      // live width comes from dragWidthRef, so a mid-drag re-render keeps the
      // pointer width instead of snapping back to the committed one.
      style={columnStyle}
    >
      {/* Drag the left edge to resize (same idiom as the workspace sidebar). */}
      {resizable ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${label} panel`}
          tabIndex={0}
          onPointerDown={handleResizePointerDown}
          onKeyDown={handleResizeKeyDown}
          className={`group absolute left-0 top-0 z-[var(--z-pane)] h-full w-1.5 -translate-x-1/2 cursor-col-resize ${FOCUS_RING_CLASS}`}
        >
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[color:var(--accent-primary)] opacity-0 transition-opacity group-hover:opacity-60"
          />
        </div>
      ) : null}
      {children}
    </aside>
  )
}
