// Width bounds for the right-docked workspace aside column, mirroring the
// workspace sidebar's drag-to-resize idiom (sidebarWidth.ts). No collapse snap —
// the column's visibility is the open flag's job, not the drag's. Owned by the
// mount seam rather than by whichever module fills the column, so a tenant
// inherits resize behaviour instead of re-implementing it.
export const WORKSPACE_ASIDE_MIN_WIDTH = 240
export const WORKSPACE_ASIDE_MAX_WIDTH = 520
export const WORKSPACE_ASIDE_DEFAULT_WIDTH = 296

export function clampWorkspaceAsideWidth(width: number): number {
  if (!Number.isFinite(width)) return WORKSPACE_ASIDE_DEFAULT_WIDTH
  return Math.min(WORKSPACE_ASIDE_MAX_WIDTH, Math.max(WORKSPACE_ASIDE_MIN_WIDTH, Math.round(width)))
}
