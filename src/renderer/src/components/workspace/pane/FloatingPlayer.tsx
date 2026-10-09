import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
import { Badge, CloseIconButton, IconButton, Tooltip } from '../../ui'
import { agentBrowserTracker } from './browser/agentBrowserFloat'
import { BrowserRecordingIndicator } from './browser/BrowserRecordingIndicator'
import { useBrowserLiveState } from './browser/useAgentBrowserAutoFloat'

// The floating browser player (browser-pane epic, `floating-preview`): the
// pane's browser tab kept in view over the workspace while the pane is closed,
// so a person can read the transcript and watch the page at once. The person
// floats a tab from its View menu; an agent taking a page in a closed pane
// floats it by itself (useAgentBrowserAutoFloat).
//
// The player is NOT a new surface. It is the same panel element the pane
// renders, restyled to `position: fixed` — see the comment at the restyle in
// `WorkspacePaneBody`. Everything here is chrome laid over that element plus
// the arithmetic that keeps its rectangle on screen.

/**
 * What the player keeps clear of the window's edges, so it never sits flush
 * against the frame or looks half fallen off: `--sem-space-xl`, read from the
 * token, with its value as the fallback where no stylesheet is loaded.
 */
export const FLOAT_EDGE_GAP_FALLBACK = 16
let edgeGapCache: number | null = null
function edgeGap(): number {
  if (edgeGapCache !== null) return edgeGapCache
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return FLOAT_EDGE_GAP_FALLBACK
  const token = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sem-space-xl'))
  edgeGapCache = Number.isFinite(token) && token > 0 ? token : FLOAT_EDGE_GAP_FALLBACK
  return edgeGapCache
}
/** The drag bar's height; the page starts below it. */
const BAR_HEIGHT = 28

export type FloatRect = { left: number; top: number; width: number; height: number }

function clampRect(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
): FloatRect {
  const EDGE_GAP = edgeGap()
  // Size first: a rect saved on a wide monitor and read on a laptop must shrink
  // to fit before its position is judged, or it would be pinned to the top-left
  // and still overflow.
  const width = Math.min(
    Math.max(rect.width, FLOAT_MIN_WIDTH),
    Math.min(FLOAT_MAX_WIDTH, viewport.width - EDGE_GAP * 2),
  )
  const height = Math.min(
    Math.max(rect.height, FLOAT_MIN_HEIGHT),
    Math.min(FLOAT_MAX_HEIGHT, viewport.height - EDGE_GAP * 2),
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
function defaultRect(viewport: { width: number; height: number }): {
  x: number
  y: number
  width: number
  height: number
} {
  const EDGE_GAP = edgeGap()
  return {
    x: viewport.width - FLOAT_DEFAULT_WIDTH - EDGE_GAP,
    y: viewport.height - FLOAT_DEFAULT_HEIGHT - EDGE_GAP,
    width: FLOAT_DEFAULT_WIDTH,
    height: FLOAT_DEFAULT_HEIGHT,
  }
}

type Box = { left: number; top: number; right: number; bottom: number }

/**
 * The default corner lifted clear of the chat's composer, when the two would
 * overlap: a player parked over the field the person types into, or over its
 * send button, is in the way of the one thing they came to do. Lifted only as
 * far as sitting just above it; when the window is too short for that the
 * corner stands, since a player that is somewhere beats one that is nowhere.
 */
export function clearOfComposer(
  rect: { x: number; y: number; width: number; height: number },
  composer: Box | null,
): { x: number; y: number; width: number; height: number } {
  if (!composer) return rect
  const overlaps =
    rect.x < composer.right &&
    rect.x + rect.width > composer.left &&
    rect.y < composer.bottom &&
    rect.y + rect.height > composer.top
  if (!overlaps) return rect
  const EDGE_GAP = edgeGap()
  const lifted = composer.top - EDGE_GAP - rect.height
  return lifted >= EDGE_GAP ? { ...rect, y: lifted } : rect
}

/** The composer on screen in this window, if a chat is showing one. */
function visibleComposerBox(): Box | null {
  // Every chat tab keeps its composer mounted. A workspace kept warm behind
  // the one on screen is `invisible` (laid out, not drawn), so a box alone
  // does not say it is the composer the person sees.
  for (const frame of document.querySelectorAll<HTMLElement>('[data-chat-composer]')) {
    if (frame.closest('[hidden], [inert], [aria-hidden="true"], .invisible')) continue
    const check = (frame as HTMLElement & { checkVisibility?: (options?: object) => boolean }).checkVisibility
    if (typeof check === 'function' && !check.call(frame, { visibilityProperty: true })) continue
    const box = frame.getBoundingClientRect()
    if (box.width > 0 && box.height > 0) return box
  }
  return null
}

/**
 * The rectangle to draw the player at, clamped to the live window.
 *
 * Null when nothing is floating. Recomputed on resize so a window dragged
 * smaller pulls the player back in rather than leaving it off the edge. A
 * player with no rect of its own yet takes the default corner, lifted clear
 * of the composer.
 */
export function useFloatRect(workspaceId: WorkspaceId, tab: WorkspacePaneTab | null): FloatRect | null {
  const stored = tab?.float
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const tabId = tab?.id ?? null
  // Read once per player and window size, not per render: the composer only
  // moves when the window does.
  const fallback = useMemo(
    () => (tabId === null ? null : clearOfComposer(defaultRect(viewport), visibleComposerBox())),
    [tabId, viewport],
  )
  if (!tab || !fallback) return null
  void workspaceId
  return clampRect(stored ?? fallback, viewport)
}

/** Which edges a resize gesture moves; the opposite edges stay where they are. */
export type ResizeEdges = { n?: boolean; s?: boolean; e?: boolean; w?: boolean }

/**
 * The rectangle a resize from `edges` lands on after the pointer moved by
 * `dx`/`dy`. The edges NOT being dragged are anchored: pulling the left edge
 * past the minimum stops the left edge, it does not push the right one. Each
 * dragged edge stops at the window's gap and at the size limits.
 */
export function resizeFloatRect(
  start: FloatRect,
  edges: ResizeEdges,
  dx: number,
  dy: number,
  viewport: { width: number; height: number },
): FloatRect {
  const EDGE_GAP = edgeGap()
  const maxWidth = Math.min(FLOAT_MAX_WIDTH, viewport.width - EDGE_GAP * 2)
  const maxHeight = Math.min(FLOAT_MAX_HEIGHT, viewport.height - EDGE_GAP * 2)
  const between = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high))
  let { left, top, width, height } = start
  const right = left + width
  const bottom = top + height
  if (edges.e) width = between(width + dx, FLOAT_MIN_WIDTH, Math.min(maxWidth, viewport.width - EDGE_GAP - left))
  if (edges.w) {
    left = between(left + dx, Math.max(EDGE_GAP, right - maxWidth), right - FLOAT_MIN_WIDTH)
    width = right - left
  }
  if (edges.s) {
    height = between(height + dy, FLOAT_MIN_HEIGHT, Math.min(maxHeight, viewport.height - EDGE_GAP - top))
  }
  if (edges.n) {
    top = between(top + dy, Math.max(EDGE_GAP, bottom - maxHeight), bottom - FLOAT_MIN_HEIGHT)
    height = bottom - top
  }
  // A window smaller than the floor leaves nothing to anchor against; the
  // ordinary clamp keeps the player on screen.
  return clampRect({ x: left, y: top, width, height }, viewport)
}

// The eight grips. Edges are thin strips along the border and corners small
// squares over them, so most of a grip sits on the frame rather than the page;
// the page keeps its own pointer everywhere else.
const RESIZE_HANDLES: ReadonlyArray<{ id: string; edges: ResizeEdges; label: string; className: string }> = [
  { id: 'n', edges: { n: true }, label: 'top edge', className: 'inset-x-3 -top-1 h-2 cursor-ns-resize' },
  { id: 's', edges: { s: true }, label: 'bottom edge', className: 'inset-x-3 -bottom-1 h-2 cursor-ns-resize' },
  { id: 'e', edges: { e: true }, label: 'right edge', className: 'inset-y-3 -right-1 w-2 cursor-ew-resize' },
  { id: 'w', edges: { w: true }, label: 'left edge', className: 'inset-y-3 -left-1 w-2 cursor-ew-resize' },
  {
    id: 'nw',
    edges: { n: true, w: true },
    label: 'top left corner',
    className: '-left-1 -top-1 size-icon-sm cursor-nwse-resize',
  },
  {
    id: 'ne',
    edges: { n: true, e: true },
    label: 'top right corner',
    className: '-right-1 -top-1 size-icon-sm cursor-nesw-resize',
  },
  {
    id: 'sw',
    edges: { s: true, w: true },
    label: 'bottom left corner',
    className: '-bottom-1 -left-1 size-icon-sm cursor-nesw-resize',
  },
  // The corner the player grows from by habit keeps the visible grip it always
  // had, so the other seven are found by the cursor rather than by looking.
  {
    id: 'se',
    edges: { s: true, e: true },
    label: 'bottom right corner',
    className: 'bottom-0 right-0 size-icon-md cursor-nwse-resize',
  },
]

type ChromeProps = {
  workspaceId: WorkspaceId
  tab: WorkspacePaneTab
  rect: FloatRect
}

type Gesture = { kind: 'move' } | { kind: 'resize'; edges: ResizeEdges }

/**
 * The player's own chrome: a drag bar with the page title, who is driving it,
 * and the dock and close buttons, and a resize grip on every edge and corner.
 *
 * The pane's full toolbar stays under it — this is deliberately a reduced
 * chrome, as the spec asks. The bar is `absolute` inside the floating panel,
 * and the page is pushed below it by the padding the panel carries.
 */
export function FloatingPlayerChrome({ workspaceId, tab, rect }: ChromeProps) {
  const updatePaneTab = useWorkspaceStore((s) => s.updatePaneTab)
  const setPaneTabFloating = useWorkspaceStore((s) => s.setPaneTabFloating)
  const dismissPaneTabFloat = useWorkspaceStore((s) => s.dismissPaneTabFloat)
  const live = useBrowserLiveState(tab.id)
  // The live rect during a gesture. Written straight to the store on pointer-up
  // so no frame pays for a persisted-registry re-serialization; the same idiom
  // the aside column's resize uses.
  const gesture = useRef<(Gesture & { startX: number; startY: number; rect: FloatRect }) | null>(null)

  const commit = useCallback(
    (next: FloatRect) => {
      updatePaneTab(workspaceId, tab.id, {
        float: { x: next.left, y: next.top, width: next.width, height: next.height },
      })
    },
    [updatePaneTab, workspaceId, tab.id],
  )

  const dock = useCallback(
    () => setPaneTabFloating(workspaceId, tab.id, false),
    [setPaneTabFloating, workspaceId, tab.id],
  )
  const close = useCallback(() => {
    // Down for the rest of this agent session, or the agent's next step would
    // bring it straight back up (agentBrowserFloat.AGENT_SESSION_QUIET_MS).
    agentBrowserTracker.dismiss(tab.id, Date.now())
    dismissPaneTabFloat(workspaceId, tab.id)
  }, [dismissPaneTabFloat, workspaceId, tab.id])

  const onPointerDown = useCallback(
    (next: Gesture) => (event: React.PointerEvent<HTMLElement>) => {
      // Left button only: a right-click on the bar is a context menu, not a drag.
      if (event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      gesture.current = { ...next, startX: event.clientX, startY: event.clientY, rect }
    },
    [rect],
  )

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const current = gesture.current
    if (!current) return
    const dx = event.clientX - current.startX
    const dy = event.clientY - current.startY
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const next =
      current.kind === 'move'
        ? clampRect(
            {
              x: current.rect.left + dx,
              y: current.rect.top + dy,
              width: current.rect.width,
              height: current.rect.height,
            },
            viewport,
          )
        : resizeFloatRect(current.rect, current.edges, dx, dy, viewport)
    // The panel is the element being moved; writing straight to its style keeps
    // the drag at pointer speed instead of one store write per frame.
    const panel = event.currentTarget.closest('[role="tabpanel"]') as HTMLElement | null
    if (panel) {
      panel.style.left = `${next.left}px`
      panel.style.top = `${next.top}px`
      panel.style.width = `${next.width}px`
      panel.style.height = `${next.height}px`
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
    [commit],
  )

  // The bar's buttons own their own presses; without this a press on one
  // starts a drag, and a double-click on one docks the player.
  const stopBar = (event: React.SyntheticEvent) => event.stopPropagation()

  return (
    <>
      <div
        // `cursor-grab` and the title make the bar read as the handle; the page
        // below it is the guest and must keep its own pointer behaviour.
        // Double-clicking it docks the player, the way double-clicking a
        // window's title bar makes it the size it is meant to be.
        className="absolute inset-x-0 top-0 z-[var(--z-float)] flex cursor-grab items-center gap-1 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-2 active:cursor-grabbing"
        style={{ height: BAR_HEIGHT }}
        onPointerDown={onPointerDown({ kind: 'move' })}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={dock}
      >
        <span className="min-w-0 flex-1 truncate text-micro text-[color:var(--text-muted)]">
          {tab.title || tab.url || 'Browser'}
        </span>
        {/* Who has the page, said the way the pane's toolbar says it. */}
        {live?.controller === 'agent' ? (
          <Badge tone="accent" ariaLabel="An agent is driving this page">
            Agent
          </Badge>
        ) : null}
        {live?.recording ? (
          <span className="flex items-center gap-1" onPointerDown={stopBar} onDoubleClick={stopBar}>
            <BrowserRecordingIndicator
              recording={live.recording}
              onStop={() => void window.api.browserStopRecording(tab.id)}
            />
          </span>
        ) : null}
        <Tooltip content="Dock in pane" placement="bottom">
          <IconButton
            size="3xs"
            aria-label="Dock this page back in the pane"
            onPointerDown={stopBar}
            onDoubleClick={stopBar}
            onClick={dock}
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
        <Tooltip content="Close" placement="bottom">
          <CloseIconButton
            size="3xs"
            aria-label="Close the floating browser"
            onPointerDown={stopBar}
            onDoubleClick={stopBar}
            onClick={close}
          />
        </Tooltip>
      </div>
      {RESIZE_HANDLES.map((handle) => (
        <div
          key={handle.id}
          role="separator"
          aria-label={`Resize the floating browser from its ${handle.label}`}
          className={`absolute z-[var(--z-float)] ${handle.className}`}
          onPointerDown={onPointerDown({ kind: 'resize', edges: handle.edges })}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {handle.id === 'se' ? (
            <svg viewBox="0 0 16 16" fill="none" className="icon-sm text-[color:var(--text-subtle)]" aria-hidden="true">
              <path d="M11 15L15 11M6 15L15 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          ) : null}
        </div>
      ))}
    </>
  )
}

/** The padding the floating panel owes its chrome, so the page clears the bar. */
export const FLOATING_PAGE_INSET = BAR_HEIGHT
