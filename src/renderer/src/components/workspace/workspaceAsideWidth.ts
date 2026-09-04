// Width bounds for the right-docked workspace pane column, mirroring the
// workspace sidebar's drag-to-resize idiom (sidebarWidth.ts). No collapse snap —
// the column's visibility is the pane's open flag, not the drag's. The names
// keep the column's original "aside" vocabulary: the chrome in
// workspaceAsideColumn.tsx predates the pane and is what the pane renders in.
export const WORKSPACE_ASIDE_MIN_WIDTH = 240
// A browser tab wants room: a phone preset scaled to fit reads at 420, a
// desktop page at 720.
export const WORKSPACE_ASIDE_MAX_WIDTH = 720
export const WORKSPACE_ASIDE_DEFAULT_WIDTH = 420

export function clampWorkspaceAsideWidth(width: number): number {
  if (!Number.isFinite(width)) return WORKSPACE_ASIDE_DEFAULT_WIDTH
  return Math.min(WORKSPACE_ASIDE_MAX_WIDTH, Math.max(WORKSPACE_ASIDE_MIN_WIDTH, Math.round(width)))
}
