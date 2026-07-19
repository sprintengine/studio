import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DiffEditor, type DiffOnMount, type Monaco } from '@monaco-editor/react'
import type * as MonacoNs from 'monaco-editor'

import type { DiffView, ReviewAnnotation } from '../../../../../shared/review'
import { MONO_FONT_STACK } from '../../../utils/fonts'
import { buildDiffFileModel, type DiffFileModel } from './diffModel'
import { placeAnnotations, hoverLinesForAnnotation, type AnnotationPlacement } from './annotationZones'
import type { ChangeSetFile } from '../../../../../shared/review'
import { AnnotationRibbon } from './AnnotationRibbon'

type DiffEditorInstance = MonacoNs.editor.IStandaloneDiffEditor

interface ReviewDiffEditorProps {
  file: ChangeSetFile
  annotations: ReviewAnnotation[]
  diffView: DiffView
  monacoTheme: 'vs' | 'vs-dark'
  onRequestComment: (path: string, line: number) => void
  onAskGuide: (annotation: ReviewAnnotation) => void
  // Reports annotations that could not be anchored in the editor so the caller
  // can surface them in the side panel and log one warning each.
  onOrphans: (path: string, orphans: ReviewAnnotation[]) => void
  // Registers a "reveal this real new-side line" fn so a side-panel summary card
  // can jump into the diff. Unregisters on unmount.
  registerReveal?: (path: string, reveal: ((line: number) => void) | null) => void
}

interface MountedZone {
  placement: AnnotationPlacement
  domNode: HTMLElement
  zone: MonacoNs.editor.IViewZone
  zoneId: string
}

// One file card's diff body. The two sides are reconstructed from the changeset
// hunks (no git read), so it renders identically from a fixture or a live
// branch. Annotations attach as view zones on the modified editor (both view
// modes); hover tips ride inline decorations; the comment gutter glyph appears
// on the hovered changed line.
export function ReviewDiffEditor({
  file,
  annotations,
  diffView,
  monacoTheme,
  onRequestComment,
  onAskGuide,
  onOrphans,
  registerReveal,
}: ReviewDiffEditorProps) {
  const model = useMemo<DiffFileModel>(() => buildDiffFileModel(file), [file])
  const editorRef = useRef<DiffEditorInstance | null>(null)
  const hunksRef = useRef<MonacoNs.editor.ILineChange[]>([])
  const hunkIndexRef = useRef(0)
  const commentDecorationsRef = useRef<string[]>([])
  const [zones, setZones] = useState<MountedZone[]>([])

  const { placements, orphans } = useMemo(() => {
    const placed = placeAnnotations(annotations, model)
    return { placements: placed.zones, orphans: placed.orphans }
  }, [annotations, model])

  // Report orphaned annotations up (side-panel fallback + one warning each).
  useEffect(() => {
    if (orphans.length > 0) {
      for (const orphan of orphans) {
        // eslint-disable-next-line no-console
        console.warn(
          `[review] annotation "${orphan.id}" anchor ${orphan.anchor.side} ${orphan.anchor.startLine}-${orphan.anchor.endLine} is outside ${file.path}; rendering in the side panel without a zone.`,
        )
      }
    }
    onOrphans(file.path, orphans)
  }, [orphans, file.path, onOrphans])

  const revealHunk = useCallback((index: number) => {
    const editor = editorRef.current
    const hunks = hunksRef.current
    if (!editor || hunks.length === 0) return
    const clamped = Math.min(Math.max(index, 0), hunks.length - 1)
    const hunk = hunks[clamped]
    hunkIndexRef.current = clamped
    if (hunk.modifiedEndLineNumber === 0) {
      editor.getOriginalEditor().revealLineInCenter(Math.max(1, hunk.originalStartLineNumber))
    } else {
      editor.getModifiedEditor().revealLineInCenter(Math.max(1, hunk.modifiedStartLineNumber))
    }
  }, [])

  const applyLineNumbers = useCallback(
    (editor: DiffEditorInstance) => {
      const forSide = (real: number[]) => (editorLine: number): string => {
        const value = real[editorLine - 1]
        return value === undefined ? '' : String(value)
      }
      editor.getModifiedEditor().updateOptions({ lineNumbers: forSide(model.modifiedRealLines) })
      editor.getOriginalEditor().updateOptions({ lineNumbers: forSide(model.originalRealLines) })
    },
    [model],
  )

  // Inline hover-tip decorations: dotted underline + a Guide-titled hover on
  // every new-side line an annotation covers. Works in both view modes.
  const applyHintDecorations = useCallback(
    (editor: DiffEditorInstance, monaco: Monaco) => {
      const modified = editor.getModifiedEditor()
      const decorations: MonacoNs.editor.IModelDeltaDecoration[] = []
      for (const annotation of annotations) {
        const lines = hoverLinesForAnnotation(annotation, model)
        for (const real of lines) {
          const editorLine = model.modifiedRealLines.indexOf(real) + 1
          if (editorLine <= 0) continue
          decorations.push({
            range: new monaco.Range(editorLine, 1, editorLine, 1),
            options: {
              isWholeLine: true,
              inlineClassName: 'review-hint-line',
              hoverMessage: { value: `**Guide**\n\n${annotation.hoverTip}` },
            },
          })
        }
      }
      modified.createDecorationsCollection(decorations)
    },
    [annotations, model],
  )

  // The comment gutter glyph tracks the hovered changed line; clicking it asks
  // the caller to open a composer (a no-op prop until MC-1681).
  const wireCommentGutter = useCallback(
    (editor: DiffEditorInstance, monaco: Monaco) => {
      const modified = editor.getModifiedEditor()
      const addLines = new Set(
        model.rows.filter((row) => row.kind === 'add' && row.modifiedEditorLine).map((row) => row.modifiedEditorLine as number),
      )
      const clear = () => {
        commentDecorationsRef.current = modified.deltaDecorations(commentDecorationsRef.current, [])
      }
      modified.onMouseMove((event) => {
        const line = event.target.position?.lineNumber
        if (!line || !addLines.has(line)) {
          clear()
          return
        }
        commentDecorationsRef.current = modified.deltaDecorations(commentDecorationsRef.current, [
          {
            range: new monaco.Range(line, 1, line, 1),
            options: { glyphMarginClassName: 'review-comment-glyph', glyphMarginHoverMessage: { value: 'Comment on this line' } },
          },
        ])
      })
      modified.onMouseLeave(() => clear())
      modified.onMouseDown((event) => {
        if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
        const line = event.target.position?.lineNumber
        if (!line || !addLines.has(line)) return
        const real = model.modifiedRealLines[line - 1]
        if (real !== undefined) onRequestComment(file.path, real)
      })
    },
    [model, onRequestComment, file.path],
  )

  const mountZones = useCallback(
    (editor: DiffEditorInstance) => {
      const mounted: MountedZone[] = []
      editor.getModifiedEditor().changeViewZones((accessor) => {
        for (const placement of placements) {
          const domNode = document.createElement('div')
          domNode.style.width = '100%'
          domNode.style.zIndex = '5'
          const zone: MonacoNs.editor.IViewZone = {
            afterLineNumber: placement.afterLineNumber,
            afterColumn: 1,
            heightInPx: 1,
            domNode,
          }
          const zoneId = accessor.addZone(zone)
          mounted.push({ placement, domNode, zone, zoneId })
        }
      })
      setZones(mounted)
    },
    [placements],
  )

  // Re-measure a zone once its ribbon paints so the editor reserves the right
  // height (no clipped annotations, no dead space).
  const resizeZone = useCallback((mounted: MountedZone, height: number) => {
    const editor = editorRef.current
    if (!editor || height <= 0 || mounted.zone.heightInPx === height) return
    mounted.zone.heightInPx = height
    editor.getModifiedEditor().changeViewZones((accessor) => accessor.layoutZone(mounted.zoneId))
  }, [])

  const handleMount = useCallback<DiffOnMount>(
    (editor, monaco) => {
      editorRef.current = editor
      applyLineNumbers(editor)
      applyHintDecorations(editor, monaco)
      wireCommentGutter(editor, monaco)
      editor.getModifiedEditor().onDidChangeModelContent(() => applyLineNumbers(editor))
      editor.onDidUpdateDiff(() => {
        hunksRef.current = editor.getLineChanges() ?? []
      })
      // F7 / Shift+F7 move between hunks while this editor holds focus.
      editor.getModifiedEditor().onKeyDown((event) => {
        if (event.browserEvent.key !== 'F7') return
        event.preventDefault()
        event.stopPropagation()
        revealHunk(hunkIndexRef.current + (event.browserEvent.shiftKey ? -1 : 1))
      })
      mountZones(editor)
      registerReveal?.(file.path, (realLine: number) => {
        const editorLine = model.modifiedRealLines.indexOf(realLine) + 1
        editor.getModifiedEditor().revealLineInCenter(editorLine > 0 ? editorLine : 1)
      })
    },
    [applyLineNumbers, applyHintDecorations, wireCommentGutter, revealHunk, mountZones, registerReveal, file.path, model],
  )

  useEffect(() => {
    return () => registerReveal?.(file.path, null)
  }, [registerReveal, file.path])

  // The view toggle maps straight to Monaco's renderSideBySide.
  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: diffView === 'side-by-side' })
  }, [diffView])

  // A tall file card would scroll internally; size the editor to its content so
  // the card grows instead, matching the walkthrough's single-scroll rhythm.
  const editorHeight = useMemo(() => {
    const lines = Math.max(model.modifiedRealLines.length, model.originalRealLines.length, 1)
    return Math.min(560, Math.max(120, lines * 20 + 20))
  }, [model])

  return (
    <div style={{ height: editorHeight }}>
      <DiffEditor
        height="100%"
        theme={monacoTheme}
        original={model.original}
        modified={model.modified}
        language={model.language}
        keepCurrentOriginalModel={false}
        keepCurrentModifiedModel={false}
        options={{
          readOnly: true,
          renderSideBySide: diffView === 'side-by-side',
          glyphMargin: true,
          fontSize: 12.5,
          fontFamily: MONO_FONT_STACK,
          lineHeight: 20,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          contextmenu: false,
          renderOverviewRuler: false,
          scrollbar: { alwaysConsumeMouseWheel: false },
        }}
        onMount={handleMount}
      />
      {zones.map((mounted) =>
        createPortal(
          <AnnotationRibbon
            annotation={mounted.placement.annotation}
            onAskGuide={onAskGuide}
            onMeasured={(height) => resizeZone(mounted, height)}
          />,
          mounted.domNode,
          mounted.placement.annotation.id,
        ),
      )}
    </div>
  )
}

export default ReviewDiffEditor
