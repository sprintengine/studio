// The "comment on this line" gutter wiring, factored out of ReviewDiffEditor so
// that component stays at its size bar. It hangs the accent "+" glyph and a
// keyboard action on BOTH sides of the diff: the modified editor offers added and
// context lines (new-side anchors), the original editor offers removed lines
// (old-side anchors). Clicking the glyph — or the Cmd/Ctrl+Alt+C action at the
// cursor line — calls back with a single-line anchor carrying the correct side, so
// a comment lands on the exact line the reviewer pointed at, deletions included.
//
// Monaco-only surface: no React, no state. The host holds the request callback in
// a ref so the handlers, registered once at mount, always see the latest.

import type * as MonacoNs from 'monaco-editor'
import type { Monaco } from '@monaco-editor/react'

import type { AnchorSide, ReviewAnchor } from '../../../../../shared/review'
import type { DiffFileModel } from './diffModel'

type DiffEditorInstance = MonacoNs.editor.IStandaloneDiffEditor

// Editor-line -> real source line, for the lines commentable on one side. Context
// lines are credited to the new side only, so every line has exactly one "+":
// added → modified editor, removed → original editor, context → modified editor.
// Exported for the review-model unit test; the wiring below is Monaco-coupled.
export function commentableLines(model: DiffFileModel, side: AnchorSide): Map<number, number> {
  const map = new Map<number, number>()
  for (const row of model.rows) {
    if (side === 'new' && (row.kind === 'add' || row.kind === 'context') && row.modifiedEditorLine && row.newLine) {
      map.set(row.modifiedEditorLine, row.newLine)
    } else if (side === 'old' && row.kind === 'del' && row.originalEditorLine && row.oldLine) {
      map.set(row.originalEditorLine, row.oldLine)
    }
  }
  return map
}

// Wire one code editor's gutter: hover paints the "+" on a commentable line, the
// click (or keyboard action) resolves that editor line to a real-line anchor on
// `side` and requests a composer there.
function wireSide(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  monaco: Monaco,
  side: AnchorSide,
  lines: Map<number, number>,
  actionScope: string,
  requestComment: (anchor: ReviewAnchor) => void,
): void {
  let decorations: string[] = []
  const clear = (): void => {
    decorations = editor.deltaDecorations(decorations, [])
  }
  const anchorForLine = (editorLine: number | undefined): ReviewAnchor | null => {
    if (!editorLine) return null
    const real = lines.get(editorLine)
    return real === undefined ? null : { side, startLine: real, endLine: real }
  }

  editor.onMouseMove((event) => {
    const line = event.target.position?.lineNumber
    if (!line || !lines.has(line)) {
      clear()
      return
    }
    decorations = editor.deltaDecorations(decorations, [
      {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: 'review-comment-glyph',
          glyphMarginHoverMessage: { value: 'Comment on this line' },
        },
      },
    ])
  })
  editor.onMouseLeave(() => clear())
  editor.onMouseDown((event) => {
    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
    const anchor = anchorForLine(event.target.position?.lineNumber)
    if (anchor) requestComment(anchor)
  })

  // Keyboard route to the same composer (Cmd/Ctrl+Alt+C, also in the command
  // palette): comment at the cursor when it is a commentable line for this side.
  editor.addAction({
    id: `review-comment-on-line-${actionScope}`,
    label: 'Comment on this line',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyC],
    run: (ed) => {
      const anchor = anchorForLine(ed.getPosition()?.lineNumber)
      if (anchor) requestComment(anchor)
    },
  })
}

// Wire both sides of the diff editor's comment gutter.
export function wireCommentGutter(
  editor: DiffEditorInstance,
  monaco: Monaco,
  model: DiffFileModel,
  requestComment: (anchor: ReviewAnchor) => void,
): void {
  wireSide(editor.getModifiedEditor(), monaco, 'new', commentableLines(model, 'new'), 'modified', requestComment)
  wireSide(editor.getOriginalEditor(), monaco, 'old', commentableLines(model, 'old'), 'original', requestComment)
}
