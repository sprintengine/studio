// Width bounds for the right-docked Sprint Engines aside, mirroring the
// workspace sidebar's drag-to-resize idiom (sidebarWidth.ts). No collapse
// snap — closing the aside is the Sprints nav entry / close button's job.
export const SPRINTS_ASIDE_MIN_WIDTH = 240
export const SPRINTS_ASIDE_MAX_WIDTH = 520
export const SPRINTS_ASIDE_DEFAULT_WIDTH = 296

export function clampSprintsAsideWidth(width: number): number {
  if (!Number.isFinite(width)) return SPRINTS_ASIDE_DEFAULT_WIDTH
  return Math.min(SPRINTS_ASIDE_MAX_WIDTH, Math.max(SPRINTS_ASIDE_MIN_WIDTH, Math.round(width)))
}
