// Monaco-free annotation placement. Given a file's diff model and the guide's
// annotations for it, decide which render as in-editor view zones (with a
// modified-editor line to hang off) and which are out of range and belong in the
// side panel only. Keeping this pure means the placement logic — including the
// defensive out-of-range path — is unit-testable without mounting an editor.

import type { ReviewAnnotation } from '../../../../shared/review'
import { modifiedZoneLineForAnchor, type DiffFileModel } from './diffModel'

// Left inset for anything rendered inside a view zone — the annotation ribbon, a
// comment thread, the inline composer. It lines the zone's content up with the
// editor's code column, past Monaco's line-number and decoration gutters, so a
// zone never reads as a differently-indented block wedged into the diff. Named
// once here because all three surfaces must move together if the gutter does.
// design-system-allow: tracks Monaco's gutter width, not the app's space scale
export const ZONE_CONTENT_INSET = 'pl-[55px]'

export interface AnnotationPlacement {
  annotation: ReviewAnnotation
  // Modified-editor line the view zone attaches after (0 = above the first line).
  afterLineNumber: number
}

export interface AnnotationPlacements {
  zones: AnnotationPlacement[]
  // Anchors whose span falls outside the file's described extent. They still get
  // a side-panel card; the surface logs one warning per orphan and never a zone.
  orphans: ReviewAnnotation[]
}

// Split a file's annotations into placeable zones and out-of-range orphans. Input
// order is preserved so the side panel and zones read in the guide's sequence.
export function placeAnnotations(
  annotations: ReviewAnnotation[],
  model: DiffFileModel,
): AnnotationPlacements {
  const zones: AnnotationPlacement[] = []
  const orphans: ReviewAnnotation[] = []
  for (const annotation of annotations) {
    const afterLineNumber = modifiedZoneLineForAnchor(model, annotation.anchor)
    if (afterLineNumber === null) orphans.push(annotation)
    else zones.push({ annotation, afterLineNumber })
  }
  return { zones, orphans }
}

// Hover-tip index: the real new-side lines an annotation covers, so the surface
// can decorate exactly those modified lines and answer the hover provider. Only
// new-side anchors carry hover tips (they decorate lines present in the modified
// editor); an old-side anchor contributes nothing here.
export function hoverLinesForAnnotation(
  annotation: ReviewAnnotation,
  model: DiffFileModel,
): number[] {
  if (annotation.anchor.side !== 'new') return []
  const lines: number[] = []
  for (let real = annotation.anchor.startLine; real <= annotation.anchor.endLine; real += 1) {
    if (model.modifiedRealLines.includes(real)) lines.push(real)
  }
  return lines
}
