// Workspace sidebar width constants and resize helpers.
//
// The sidebar is a draggable, resizable rail. The user drags its right edge to
// set the expanded width (persisted as `sidebarWidth`); dragging far enough
// toward the left edge collapses it to the icon rail. Kept in one module so the
// component, the store default, and the drag math can never disagree.

// Default expanded width (matches the historical fixed `w-[296px]`).
export const SIDEBAR_DEFAULT_WIDTH = 296
// Narrowest the expanded sidebar may be dragged before it snaps shut.
export const SIDEBAR_MIN_WIDTH = 200
// Widest the sidebar may be dragged.
export const SIDEBAR_MAX_WIDTH = 520
// Collapsed icon-rail width (matches the `w-[44px]` collapsed class).
export const SIDEBAR_COLLAPSED_WIDTH = 44
// While dragging, a width below this snaps the sidebar to collapsed — "drag it
// close to the left edge and it collapses". Sits below SIDEBAR_MIN_WIDTH so the
// expanded sidebar has a dead band between its narrowest and the collapse snap.
export const SIDEBAR_COLLAPSE_SNAP_WIDTH = 150

// Clamp an arbitrary dragged width into the allowed expanded range.
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
}

export type SidebarResizeOutcome = { kind: 'collapse' } | { kind: 'width'; width: number }

// Given a raw dragged width, decide whether the sidebar should collapse or take
// a clamped expanded width. Used on every pointer-move during a resize drag.
export function resolveSidebarResize(rawWidth: number): SidebarResizeOutcome {
  if (rawWidth < SIDEBAR_COLLAPSE_SNAP_WIDTH) return { kind: 'collapse' }
  return { kind: 'width', width: clampSidebarWidth(rawWidth) }
}
