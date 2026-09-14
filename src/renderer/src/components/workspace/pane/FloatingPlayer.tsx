import React, { useCallback, useEffect, useRef, useState } from 'react'

import { useWorkspaceStore } from '../../../store/workspaceStore'
import {
  FLOAT_DEFAULT_HEIGHT,
  FLOAT_DEFAULT_WIDTH,
  FLOAT_MAX_HEIGHT,
  FLOAT_MAX_WIDTH,
  FLOAT_MIN_HEIGHT,
  FLOAT_MIN_WIDTH,
} from '../../../store/slices/workspacePaneSlice'
import type { WorkspaceId, WorkspacePaneTab } from '../../../types/workspace'
import { IconButton, Tooltip } from '../../ui'

// The floating browser player (browser-pane epic, `floating-preview`): the
// pane's browser tab kept in view over the workspace while the pane is closed,
// so a person can read the transcript and watch the page at once.
//
// The player is NOT a new surface. It is the same panel element the pane
// renders, restyled to `position: fixed` — see the comment at the restyle in
// `WorkspacePaneBody`. Everything here is chrome laid over that element plus
// the arithmetic that keeps its rectangle on screen.

/** Kept clear of the window edges so the player never looks half fallen off. */
const EDGE_GAP = 8
/** The drag bar's height; the page starts below it. */
const BAR_HEIGHT = 28

export type FloatRect = { left: number; top: number; width: number; height: number }

function clampRect(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number }
): FloatRect {
  // Size first: a rect saved on a wide monitor and read on a laptop must shrink
  // to fit before its position is judged, or it would be pinned to the top-left
  // and still overflow.
  const width = Math.min(Math.max(rect.width, FLOAT_MIN_WIDTH), Math.min(FLOAT_MAX_WIDTH, viewport.width - EDGE_GAP * 2))
  const height = Math.min(
    Math.max(rect.height, FLOAT_MIN_HEIGHT),
    Math.min(FLOAT_MAX_HEIGHT, viewport.height - EDGE_GAP * 2)
  )
  const maxLeft = Math.max(EDGE_GAP, viewport.width - width - EDGE_GAP)
  const maxTop = Math.max(EDGE_GAP, viewport.height - height - EDGE_GAP)
  return {
    left: Math.min(Math.max(rect.x, EDGE_GAP), maxLeft),
    top: Math.min(Math.max(rect.y, EDGE_GAP), maxTop),
    width,
    height,
  }
}

/** The default corner: bottom-right, where a video player parks. */
function defaultRect(viewport: { width: number; height: number }): { x: number; y: number; width: number; height: number } {
  return {
    x: viewport.width - FLOAT_DEFAULT_WIDTH - EDGE_GAP,
    y: viewport.height - FLOAT_DEFAULT_HEIGHT - EDGE_GAP,
    width: FLOAT_DEFAULT_WIDTH,
    height: FLOAT_DEFAULT_HEIGHT,
  }
}

/**
 * The rectangle to draw the player at, clamped to the live window.
 *
 * Null when nothing is floating. Recomputed on resize so a window dragged
 * smaller pulls the player back in rather than leaving it off the edge.
 */
export function useFloatRect(workspaceId: WorkspaceId, tab: WorkspacePaneTab | null): FloatRect | null {
  const stored = tab?.float
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  if (!tab) return null
  void workspaceId
  return clampRect(stored ?? defaultRect(viewport), viewport)
}

type ChromeProps = {
  workspaceId: WorkspaceId
  tab: WorkspacePaneTab
  rect: FloatRect
}

/**
 * The player's own chrome: a drag bar with the page title and a dock button,
 * and a resize corner.
 *
 * The pane's full toolbar stays under it — this is deliberately a reduced
 * chrome, as the spec asks. The bar is `absolute` inside the floating panel,
 * and the page is pushed below it by the padding the panel carries.
 */
export function FloatingPlayerChrome({ workspaceId, tab, rect }: ChromeProps) {
  const updatePaneTab = useWorkspaceStore((s) => s.updatePaneTab)
  const setPaneTabFloating = useWorkspaceStore((s) => s.setPaneTabFloating)
  // The live rect during a gesture. Written straight to the store on pointer-up
  // so no frame pays for a persisted-registry re-serialization; the same idiom
  // the aside column's resize uses.
  const gesture = useRef<{ kind: 'move' | 'resize'; startX: number; startY: number; rect: FloatRect } | null>(null)

  const commit = useCallback(
    (next: FloatRect) => {
      updatePaneTab(workspaceId, tab.id, {
        float: { x: next.left, y: next.top, width: next.width, height: next.height },
      })
    },
    [updatePaneTab, workspaceId, tab.id]
  )

  const onPointerDown = useCallback(
    (kind: 'move' | 'resize') => (event: React.PointerEvent<HTMLElement>) => {
      // Left button only: a right-click on the bar is a context menu, not a drag.
      if (event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      gesture.current = { kind, startX: event.clientX, startY: event.clientY, rect }
    },
    [rect]
  )

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const current = gesture.current
    if (!current) return
    const dx = event.clientX - current.startX
    const dy = event.clientY - current.startY
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const next =
      current.kind === 'move'
        ? { x: current.rect.left + dx, y: current.rect.top + dy, width: current.rect.width, height: current.rect.height }
        : {
            x: current.rect.left,
            y: current.rect.top,
            width: current.rect.width + dx,
            height: current.rect.height + dy,
          }
    const clamped = clampRect(next, viewport)
    // The panel is the element being moved; writing straight to its style keeps
    // the drag at pointer speed instead of one store write per frame.
    const panel = event.currentTarget.closest('[role="tabpanel"]') as HTMLElement | null
    if (panel) {
      panel.style.left = `${clamped.left}px`
      panel.style.top = `${clamped.top}px`
      panel.style.width = `${clamped.width}px`
      panel.style.height = `${clamped.height}px`
    }
  }, [])

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const current = gesture.current
      if (!current) return
      gesture.current = null
      event.currentTarget.releasePointerCapture(event.pointerId)
      const panel = event.currentTarget.closest('[role="tabpanel"]') as HTMLElement | null
      if (!panel) return
      // `getBoundingClientRect`, not `offsetLeft`: a fixed element has no
      // offsetParent, and the border box is what `left`/`top`/`width`/`height`
      // were written as, so this round-trips exactly.
      const box = panel.getBoundingClientRect()
      commit({
        left: Math.round(box.left),
        top: Math.round(box.top),
        width: Math.round(box.width),
        height: Math.round(box.height),
      })
    },
    [commit]
  )

  return (
    <>
      <div
        // `cursor-grab` and the title make the bar read as the handle; the page
        // below it is the guest and must keep its own pointer behaviour.
        className="absolute inset-x-0 top-0 z-[var(--z-float)] flex cursor-grab items-center gap-1 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-2 active:cursor-grabbing"
        style={{ height: BAR_HEIGHT }}
        onPointerDown={onPointerDown('move')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span className="min-w-0 flex-1 truncate text-micro text-[color:var(--text-muted)]">
          {tab.title || tab.url || 'Browser'}
        </span>
        <Tooltip content="Dock in pane" placement="bottom">
          <IconButton
            size="3xs"
            aria-label="Dock this page back in the pane"
            // The bar owns a drag gesture; without this the button press starts one.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setPaneTabFloating(workspaceId, tab.id, false)}
          >
            <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
              <path
                d="M3 3h10v10H3V3Zm7 0v10"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </IconButton>
        </Tooltip>
      </div>
      <div
        // A corner grip, not a full edge set: one handle is the whole of what a
        // 360x240 player needs, and edge handles would sit over the page.
        role="separator"
        aria-label="Resize the floating browser"
        className="absolute bottom-0 right-0 z-[var(--z-float)] size-icon-md cursor-nwse-resize"
        onPointerDown={onPointerDown('resize')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm text-[color:var(--text-subtle)]" aria-hidden="true">
          <path d="M11 15L15 11M6 15L15 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
    </>
  )
}

/** The padding the floating panel owes its chrome, so the page clears the bar. */
export const FLOATING_PAGE_INSET = BAR_HEIGHT
