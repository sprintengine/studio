// How big the rendered board comes out.
//
// Two failure modes sit either side of this, and both make a screenshot useless
// to the agent that asked for it. Scale everything to the budget and a diagram
// of three boxes arrives as a 1024px blur of upscaled strokes. Render at 1:1 and
// the same three boxes arrive 180px across, with labels nobody can read.
//
// So: never more than twice the board's natural size, never more than the
// budget, and never past what the browser will allocate a canvas for.

/** The widest canvas the renderer will allocate. Past it, `toBlob` is null. */
export const CANVAS_MAX_EXPORT_EDGE = 16384

/** The most an export is enlarged past the size the board is drawn at. */
export const CANVAS_MAX_EXPORT_SCALE = 2

export type ExportDimensions = { width: number; height: number; scale: number }

export function exportDimensions(width: number, height: number, maxEdge: number): ExportDimensions {
  const natural = Math.max(width, height)
  if (!Number.isFinite(natural) || natural <= 0) return { width: 1, height: 1, scale: 1 }
  const budget =
    Number.isFinite(maxEdge) && maxEdge > 0 ? Math.min(maxEdge, CANVAS_MAX_EXPORT_EDGE) : CANVAS_MAX_EXPORT_EDGE
  const scale = Math.min(CANVAS_MAX_EXPORT_SCALE, budget / natural)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  }
}
