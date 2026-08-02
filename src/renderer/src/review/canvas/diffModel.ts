// Pure diff geometry for the review walkthrough. A ReviewChangeSet carries the
// full normalized diff (hunks with context/add/del lines); this module turns one
// file's hunks into the two text sides a Monaco DiffEditor needs, plus the line
// maps that let annotations, hover tips, and the comment gutter address REAL
// source lines instead of editor rows.
//
// Node-free and Monaco-free by design so the whole model is unit-testable
// without mounting an editor — the fixture harness (T7 acceptance) leans on it.

import type { ChangeSetFile, ReviewAnchor } from '../../../../shared/review'
import { detectLanguage } from '../../utils/files'

// One reconstructed diff row, carrying its position on both sides. `newLine` /
// `oldLine` are 1-based REAL source line numbers (null when the row does not
// exist on that side); `modifiedEditorLine` / `originalEditorLine` are the
// 1-based row positions inside the reconstructed text Monaco actually renders.
export interface DiffRow {
  kind: 'context' | 'add' | 'del'
  text: string
  newLine: number | null
  oldLine: number | null
  modifiedEditorLine: number | null
  originalEditorLine: number | null
}

export interface DiffFileModel {
  path: string
  language: string
  original: string // old side — context + del rows
  modified: string // new side — context + add rows
  rows: DiffRow[]
  // editorLine (1-based) -> real source line, per side. Index i holds the real
  // line for editor line i + 1. Used to drive Monaco's lineNumbers renderer so
  // the gutter shows real file lines even though the model is a hunk digest.
  modifiedRealLines: number[]
  originalRealLines: number[]
}

// Build the Monaco-ready model for one changed file. Binary files and pure
// renames (no hunks) yield empty sides — Monaco renders that as an empty diff
// rather than throwing, and the file card shows its chrome without a body.
export function buildDiffFileModel(file: ChangeSetFile): DiffFileModel {
  const rows: DiffRow[] = []
  let modifiedEditorLine = 0
  let originalEditorLine = 0

  for (const hunk of file.hunks) {
    let newLine = hunk.newStart
    let oldLine = hunk.oldStart
    for (const line of hunk.lines) {
      if (line.kind === 'context') {
        rows.push({
          kind: 'context',
          text: line.text,
          newLine,
          oldLine,
          modifiedEditorLine: ++modifiedEditorLine,
          originalEditorLine: ++originalEditorLine,
        })
        newLine += 1
        oldLine += 1
      } else if (line.kind === 'add') {
        rows.push({
          kind: 'add',
          text: line.text,
          newLine,
          oldLine: null,
          modifiedEditorLine: ++modifiedEditorLine,
          originalEditorLine: null,
        })
        newLine += 1
      } else {
        rows.push({
          kind: 'del',
          text: line.text,
          newLine: null,
          oldLine,
          modifiedEditorLine: null,
          originalEditorLine: ++originalEditorLine,
        })
        oldLine += 1
      }
    }
  }

  const modifiedRows = rows.filter((row) => row.modifiedEditorLine !== null)
  const originalRows = rows.filter((row) => row.originalEditorLine !== null)

  return {
    path: file.path,
    language: detectLanguage(file.path),
    modified: modifiedRows.map((row) => row.text).join('\n'),
    original: originalRows.map((row) => row.text).join('\n'),
    rows,
    modifiedRealLines: modifiedRows.map((row) => row.newLine as number),
    originalRealLines: originalRows.map((row) => row.oldLine as number),
  }
}

// Real source line -> Monaco editor line for one side, or null when that source
// line is not present in the reconstructed model (out of the described extent).
export function editorLineForRealLine(
  model: DiffFileModel,
  side: ReviewAnchor['side'],
  realLine: number,
): number | null {
  const table = side === 'new' ? model.modifiedRealLines : model.originalRealLines
  const index = table.indexOf(realLine)
  return index === -1 ? null : index + 1
}

// The modified-editor line a view zone for `anchor` attaches after. Annotation
// zones always hang off the modified editor (both view modes), so a new-side
// anchor maps directly, while an old-side (deletion) anchor snaps to the nearest
// surviving modified line at or before it. Returns null when the anchor's end
// falls outside the described extent — the caller then keeps the annotation in
// the side panel only and logs one warning (never a Monaco exception).
export function modifiedZoneLineForAnchor(model: DiffFileModel, anchor: ReviewAnchor): number | null {
  if (anchor.side === 'new') {
    return editorLineForRealLine(model, 'new', anchor.endLine)
  }
  // Old-side anchor: find the row for the deleted end line, then walk back to the
  // last row that exists on the modified side (a context line, or an earlier add).
  const endIndex = model.rows.findIndex((row) => row.oldLine === anchor.endLine)
  if (endIndex === -1) return null
  for (let i = endIndex; i >= 0; i -= 1) {
    const line = model.rows[i].modifiedEditorLine
    if (line !== null) return line
  }
  // Deletion at the very top of the file: attach above the first modified line.
  return model.modifiedRealLines.length > 0 ? 0 : null
}
