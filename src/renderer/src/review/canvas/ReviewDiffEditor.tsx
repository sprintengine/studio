import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DiffEditor, type DiffOnMount, type Monaco } from '@monaco-editor/react'
import type * as MonacoNs from 'monaco-editor'

import type { DiffView, ReviewAnchor, ReviewAnnotation, ReviewComment } from '../../../../shared/review'
import { MONO_FONT_STACK } from '../../utils/fonts'
import { buildDiffFileModel, modifiedZoneLineForAnchor, type DiffFileModel } from './diffModel'
import { placeAnnotations, hoverLinesForAnnotation, type AnnotationPlacement } from './annotationZones'
import type { ChangeSetFile } from '../../../../shared/review'
import { AnnotationRibbon } from './AnnotationRibbon'
import { CommentThread } from './CommentThread'
import { CommentComposer } from './CommentComposer'
import { wireCommentGutter } from './commentGutter'

type DiffEditorInstance = MonacoNs.editor.IStandaloneDiffEditor

// Human label for the line a composer is anchored to — names the removed side
// explicitly so the reviewer knows a comment lands on the old file, not the new.
function composerAnchorLabel(anchor: ReviewAnchor): string {
  return anchor.side === 'old' ? `removed line ${anchor.startLine}` : `line ${anchor.startLine}`
}

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
  // The human's comments on THIS file. When the create/edit/delete handlers are
  // present the gutter "+" opens an inline composer and each comment renders as a
  // thread view zone; without them the surface is read-only (the T7 harness).
  comments?: ReviewComment[]
  onCreateComment?: (path: string, anchor: ReviewAnchor, body: string) => void
  onEditComment?: (id: string, body: string) => void
  onDeleteComment?: (id: string) => void
}

interface MountedZone {
  placement: AnnotationPlacement
  domNode: HTMLElement
  zone: MonacoNs.editor.IViewZone
  zoneId: string
}

// A comment thread or the open composer, rendered as a view zone that tracks the
// anchored modified-editor line. Keyed so the reconcile effect can add/remove
// exactly the zones that changed as comments come and go. The composer carries the
// full anchor (side + line) so it can open on a removed line, not just an added one.
type DynamicDescriptor = { kind: 'thread'; comment: ReviewComment } | { kind: 'composer'; anchor: ReviewAnchor }
interface DynamicZone {
  key: string
  afterLineNumber: number
  descriptor: DynamicDescriptor
  domNode: HTMLElement
  zone: MonacoNs.editor.IViewZone
  zoneId: string
}

// Measures its content and reports the height so the host can size the Monaco view
// zone to exactly fit an interactive thread or composer (which grow as the user
// types). Holds the callback in a ref so the ResizeObserver subscribes once.
function MeasuredZone({ onMeasured, children }: { onMeasured: (height: number) => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const cb = useRef(onMeasured)
  cb.current = onMeasured
  useLayoutEffect(() => {
    if (ref.current) cb.current(ref.current.scrollHeight)
  })
  useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => cb.current(node.scrollHeight))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return <div ref={ref}>{children}</div>
}

// One file card's diff body. The two sides are reconstructed from the changeset
// hunks (no git read), so it renders identically from a fixture or a live
// branch. Annotations attach as view zones on the modified editor (both view
// modes); hover tips ride inline decorations; the comment gutter glyph opens an
// inline composer, and the human's comments render as thread zones anchored by
// line math — so they land on the right line in side-by-side and inline alike.
export function ReviewDiffEditor({
  file,
  annotations,
  diffView,
  monacoTheme,
  onRequestComment,
  onAskGuide,
  onOrphans,
  registerReveal,
  comments = [],
  onCreateComment,
  onEditComment,
  onDeleteComment,
}: ReviewDiffEditorProps) {
  const model = useMemo<DiffFileModel>(() => buildDiffFileModel(file), [file])
  const editorRef = useRef<DiffEditorInstance | null>(null)
  const hunksRef = useRef<MonacoNs.editor.ILineChange[]>([])
  const hunkIndexRef = useRef(0)
  const [zones, setZones] = useState<MountedZone[]>([])
  const [editorReady, setEditorReady] = useState(false)
  const [composerAnchor, setComposerAnchor] = useState<ReviewAnchor | null>(null)

  const commentsEnabled = Boolean(onCreateComment)

  const { placements, orphans } = useMemo(() => {
    const placed = placeAnnotations(annotations, model)
    return { placements: placed.zones, orphans: placed.orphans }
  }, [annotations, model])

  // Report orphaned annotations up (side-panel fallback + one warning each).
  useEffect(() => {
    if (orphans.length > 0) {
      for (const orphan of orphans) {
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

  // The gutter "+" click routes here: open the inline composer when commenting is
  // wired, else fall back to the notify-only prop (the read-only harness). Held in
  // a ref so the Monaco mouse handlers, registered once at mount, see the latest.
  const requestCommentRef = useRef<(anchor: ReviewAnchor) => void>(() => {})
  requestCommentRef.current = (anchor: ReviewAnchor) => {
    if (commentsEnabled) setComposerAnchor(anchor)
    else onRequestComment(file.path, anchor.startLine)
  }

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

  // ── Dynamic comment/composer zones ────────────────────────────────────────
  // Comments and the composer come and go, so they live in their own reconciled
  // set (annotations stay static above). Each thread hangs off the SAME modified-
  // editor line the anchor math yields — which is independent of the view mode —
  // so a comment stays on its line across side-by-side ↔ inline.
  const dynamicZonesRef = useRef<Map<string, DynamicZone>>(new Map())
  const modelRef = useRef<DiffFileModel | null>(null)
  // Signature of the last reconciled zone set. `comments` is a fresh array on
  // every parent render, so the effect re-runs constantly; this lets it bail
  // before touching Monaco unless the anchored set or a comment body actually
  // changed.
  const zoneSigRef = useRef<string>('')
  const [dynamicZones, setDynamicZones] = useState<DynamicZone[]>([])

  const resizeDynamic = useCallback((key: string, height: number) => {
    const editor = editorRef.current
    const zone = dynamicZonesRef.current.get(key)
    if (!editor || !zone || height <= 0 || zone.zone.heightInPx === height) return
    zone.zone.heightInPx = height
    editor.getModifiedEditor().changeViewZones((accessor) => accessor.layoutZone(zone.zoneId))
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !editorReady) return
    const modified = editor.getModifiedEditor()
    const current = dynamicZonesRef.current

    // A new file model means Monaco dropped the old zones with it; forget them so
    // we do not layout against dead ids.
    const modelChanged = modelRef.current !== model
    if (modelChanged) {
      modelRef.current = model
      current.clear()
    }

    const desired: Array<{ key: string; afterLineNumber: number; descriptor: DynamicDescriptor }> = []
    for (const comment of comments) {
      const afterLineNumber = modifiedZoneLineForAnchor(model, comment.anchor)
      if (afterLineNumber === null) continue // out of range: it still shows in the tray
      desired.push({ key: `thread:${comment.id}`, afterLineNumber, descriptor: { kind: 'thread', comment } })
    }
    if (composerAnchor !== null) {
      const afterLineNumber = modifiedZoneLineForAnchor(model, composerAnchor)
      if (afterLineNumber !== null) {
        desired.push({ key: 'composer', afterLineNumber, descriptor: { kind: 'composer', anchor: composerAnchor } })
      }
    }

    // Skip the Monaco reconcile when nothing that affects a zone changed. The
    // signature folds in each thread's body + sync state so an edit still repaints,
    // and the composer's anchor so re-targeting it to another line repositions it.
    const signature = JSON.stringify(
      desired.map((entry) =>
        entry.descriptor.kind === 'thread'
          ? [entry.key, entry.afterLineNumber, entry.descriptor.comment.body, entry.descriptor.comment.sync.state]
          : [entry.key, entry.afterLineNumber, entry.descriptor.anchor.side, entry.descriptor.anchor.startLine],
      ),
    )
    if (!modelChanged && signature === zoneSigRef.current) return
    zoneSigRef.current = signature

    const desiredByKey = new Map(desired.map((entry) => [entry.key, entry]))

    modified.changeViewZones((accessor) => {
      // Remove zones that are gone or whose anchor line moved.
      for (const [key, zone] of current) {
        const want = desiredByKey.get(key)
        if (!want || want.afterLineNumber !== zone.afterLineNumber) {
          accessor.removeZone(zone.zoneId)
          current.delete(key)
        }
      }
      // Add new zones; refresh the descriptor on ones that stayed (edited body).
      for (const entry of desired) {
        const existing = current.get(entry.key)
        if (existing) {
          existing.descriptor = entry.descriptor
          continue
        }
        const domNode = document.createElement('div')
        domNode.style.width = '100%'
        domNode.style.zIndex = '6'
        const zone: MonacoNs.editor.IViewZone = {
          afterLineNumber: entry.afterLineNumber,
          afterColumn: 1,
          heightInPx: 1,
          domNode,
        }
        const zoneId = accessor.addZone(zone)
        current.set(entry.key, { key: entry.key, afterLineNumber: entry.afterLineNumber, descriptor: entry.descriptor, domNode, zone, zoneId })
      }
    })
    setDynamicZones([...current.values()])
  }, [comments, composerAnchor, model, editorReady])

  const handleMount = useCallback<DiffOnMount>(
    (editor, monaco) => {
      editorRef.current = editor
      applyLineNumbers(editor)
      applyHintDecorations(editor, monaco)
      wireCommentGutter(editor, monaco, model, (anchor) => requestCommentRef.current(anchor))
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
      setEditorReady(true)
    },
    [applyLineNumbers, applyHintDecorations, revealHunk, mountZones, registerReveal, file.path, model],
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
      {dynamicZones.map((zone) => {
        const descriptor = zone.descriptor
        return createPortal(
          <MeasuredZone onMeasured={(height) => resizeDynamic(zone.key, height)}>
            {descriptor.kind === 'thread' ? (
              <CommentThread
                comment={descriptor.comment}
                onEdit={onEditComment ?? (() => {})}
                onDelete={onDeleteComment ?? (() => {})}
              />
            ) : (
              <CommentComposer
                submitLabel="Add comment"
                placeholder={`Comment on ${file.path}…`}
                anchorLabel={composerAnchorLabel(descriptor.anchor)}
                hint="Comments collect in Your review and post together."
                onSubmit={(body) => {
                  onCreateComment?.(file.path, descriptor.anchor, body)
                  setComposerAnchor(null)
                }}
                onCancel={() => setComposerAnchor(null)}
              />
            )}
          </MeasuredZone>,
          zone.domNode,
          zone.key,
        )
      })}
    </div>
  )
}

export default ReviewDiffEditor
