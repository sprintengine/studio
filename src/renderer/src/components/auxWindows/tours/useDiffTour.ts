import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type * as Monaco from 'monaco-editor'

import type { LiveTourStep } from '../../../../../shared/tours/tour-types'
import { mapRangeAcross, stepEditorSide } from './tourModel'

// Tour mode, layered onto the diff editor that is already mounted.
//
// The one rule this file exists to keep: **the DiffEditor is never remounted.**
// A new element (or a `key`) disposes Monaco's models under the diff widget
// mid-reset (DiffViewer's `DiffBody`), so everything a tour draws is added to
// and taken off the live editor — a decorations collection, one view zone, and
// a class on the host — and the file under it is swapped by the viewer the
// same way a file step swaps it.
//
// What is drawn for a step:
//
// - **Highlight.** A neutral `bg.selected` wash on the step's lines and a 2px
//   hairline in the line-decorations gutter. The accent is spent as a hairline
//   and nowhere else; the diff's own red and green stay the diff's.
// - **The callout.** A view zone after the step's last line, filled by a React
//   portal and resized to its content, so it pushes the code down and never
//   covers it. In side-by-side view Monaco's diff widget pads the other side by
//   the same height on its own (it re-aligns on every view-zone change), so the
//   two sides stay line-for-line without a spacer of ours.
// - **Dim.** Every line outside the step, on both sides, takes an inline class
//   whose opacity is `--tour-dim`: a registered custom property animated on
//   the host, so the dim eases in rather than snapping.
// - **Ruler marks.** Every step in the file on the overview ruler; the current
//   one in the accent.
//
// And one motion at a time: the callout and highlight fade out, the editor
// scrolls, then the highlight and callout fade in as the dim settles. Reduced
// motion jumps.

type DiffEditor = Monaco.editor.IStandaloneDiffEditor
type MonacoApi = typeof Monaco

/** A best first guess at the callout's height, used until it has been measured. */
const INITIAL_ZONE_HEIGHT = 168

export type DiffTourLayer = {
  /** The node the callout portals into; null while no step is placed. */
  zoneNode: HTMLElement | null
  /** Whether the callout is showing (for its fade). */
  calloutVisible: boolean
  /** The callout's measured height; the zone is resized to it so the code below moves, never hides. */
  reportHeight: (height: number) => void
}

export type UseDiffTourInput = {
  editor: DiffEditor | null
  monaco: MonacoApi | null
  /** The step to show, or null when the tour is not playing or its file is not on screen yet. */
  step: LiveTourStep | null
  /** Every step drawn in this file, for the ruler. */
  fileSteps: readonly LiveTourStep[]
  /**
   * Ticks each time the diff on screen was recomputed. The layer is placed
   * after the diff it describes, and re-placed silently when the file's text
   * is re-read under the same step (models are replaced; zones go with them).
   */
  diffVersion: number
  /** The host whose `--tour-dim` animates. */
  host: HTMLElement | null
  reducedMotion: boolean
}

function motionMs(name: 'fast' | 'normal' | 'deliberate', reduced: boolean): number {
  if (reduced) return 0
  return name === 'fast' ? 120 : name === 'normal' ? 180 : 260
}

// The overview ruler takes a colour VALUE, not a variable, so the theme's own is read.
function cssColor(name: string, fallback = 'transparent'): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

export function useDiffTour({
  editor,
  monaco,
  step,
  fileSteps,
  diffVersion,
  host,
  reducedMotion,
}: UseDiffTourInput): DiffTourLayer {
  const [zoneNode, setZoneNode] = useState<HTMLElement | null>(null)
  const [calloutVisible, setCalloutVisible] = useState(false)
  const placedRef = useRef<{
    stepId: string
    target: Monaco.editor.ICodeEditor
    zoneId: string | null
    zone: Monaco.editor.IViewZone | null
    decorations: Monaco.editor.IEditorDecorationsCollection[]
    layoutListener: { dispose(): void } | null
  } | null>(null)
  const measuredRef = useRef(INITIAL_ZONE_HEIGHT)

  const stepKey = step ? `${step.id}@${step.startLine ?? 0}-${step.endLine ?? 0}:${step.anchor.side}` : null
  const rulerKey = fileSteps.map((entry) => `${entry.id}@${entry.startLine ?? 0}`).join(',')

  useEffect(() => {
    if (!editor || !monaco || !step) {
      clearPlacement(placedRef)
      setZoneNode(null)
      setCalloutVisible(false)
      host?.classList.remove('tour-dimmed-host', 'tour-leaving', 'tour-arriving')
      return
    }
    const previous = placedRef.current
    const sameStep = previous?.stepId === step.id
    const timers: number[] = []
    const frames: number[] = []
    let cancelled = false
    const later = (ms: number, run: () => void): void => {
      if (ms <= 0) {
        run()
        return
      }
      timers.push(window.setTimeout(() => !cancelled && run(), ms))
    }

    const side = stepEditorSide(step)
    const target = side === 'original' ? editor.getOriginalEditor() : editor.getModifiedEditor()
    const other = side === 'original' ? editor.getModifiedEditor() : editor.getOriginalEditor()
    const model = target.getModel()
    if (!model) return
    const lineCount = model.getLineCount()
    const start = step.startLine === null ? null : Math.min(Math.max(1, step.startLine), lineCount)
    const end = step.endLine === null || start === null ? null : Math.min(Math.max(start, step.endLine), lineCount)

    /**
     * The zone under the step. The SAME step placed again (an agent saved the
     * file, the lines moved) keeps its node: the callout portals into it, and a
     * new node would remount the callout and take the half-typed question and
     * its focus with it. Only the position is updated, in place.
     */
    const placeZone = (): void => {
      if (sameStep && previous && previous.target === target && previous.zone && previous.zone.domNode.isConnected) {
        clearDecorations(previous)
        previous.zone.afterLineNumber = end ?? 0
        const zoneId = previous.zoneId
        target.changeViewZones((accessor) => {
          if (zoneId) accessor.layoutZone(zoneId)
        })
        return
      }
      const reused = sameStep && previous?.zone ? previous.zone.domNode : null
      clearPlacement(placedRef)
      host?.classList.remove('tour-leaving')
      // Its DOM belongs to Monaco's layout and to React's portal; the pointer
      // and the plain keys inside it belong to neither of Monaco's handlers —
      // a click must reach the field rather than move the editor's cursor, and
      // a `[` typed into the field is a character, not a step back. A key with
      // a modifier is left to travel, so the app's own shortcuts still work.
      const domNode = reused ?? document.createElement('div')
      if (!reused) {
        domNode.className = 'tour-zone'
        const stopPointer = (event: Event): void => event.stopPropagation()
        const stopKey = (event: Event): void => {
          const key = event as KeyboardEvent
          if (key.metaKey || key.ctrlKey || key.altKey) return
          event.stopPropagation()
        }
        for (const type of ['pointerdown', 'mousedown', 'dblclick']) domNode.addEventListener(type, stopPointer)
        for (const type of ['keydown', 'keyup', 'keypress']) domNode.addEventListener(type, stopKey)
      }
      const zone: Monaco.editor.IViewZone = { afterLineNumber: end ?? 0, heightInPx: measuredRef.current, domNode }
      let zoneId: string | null = null
      target.changeViewZones((accessor) => {
        zoneId = accessor.addZone(zone)
      })
      // A zone is as wide as the editor's SCROLLABLE content, which for a long
      // line is far wider than what shows. The callout is held to the visible
      // text column instead, and follows it when the editor is resized.
      const fitToView = (): void => {
        const layout = target.getLayoutInfo()
        const visible = layout.contentWidth - layout.verticalScrollbarWidth
        domNode.style.setProperty('--tour-zone-width', `${Math.max(0, Math.floor(visible))}px`)
      }
      fitToView()
      const layoutListener = target.onDidLayoutChange(fitToView)
      placedRef.current = { stepId: step.id, target, zoneId, zone, decorations: [], layoutListener }
      setZoneNode(domNode)
    }

    /**
     * Scroll so the step AND its callout are in view: centred when they fit,
     * top-aligned with a little air when they do not. Measured two frames on:
     * the diff widget answers a new zone by re-aligning the other side, and a
     * scroll computed before that lands short by the padding it adds. Only for
     * a step the owner moved to — a re-placed step leaves the scroll alone.
     */
    const reveal = (): void => {
      const scrollType = reducedMotion ? monaco.editor.ScrollType.Immediate : monaco.editor.ScrollType.Smooth
      const run = (): void => {
        const placed = placedRef.current
        if (cancelled || !placed?.zone) return
        if (start === null || end === null) {
          target.setScrollTop(0, scrollType)
          return
        }
        const lineHeight = target.getOption(monaco.editor.EditorOption.lineHeight)
        const top = target.getTopForLineNumber(start)
        const block = (end - start + 1) * lineHeight + (placed.zone.heightInPx ?? 0)
        const viewport = target.getLayoutInfo().height
        const scrollTop = block < viewport * 0.85 ? top - (viewport - block) / 2 : top - lineHeight * 2
        target.setScrollTop(Math.max(0, scrollTop), scrollType)
      }
      frames.push(window.requestAnimationFrame(() => frames.push(window.requestAnimationFrame(run))))
    }

    const decorate = (): void => {
      const placed = placedRef.current
      if (!placed) return
      const current: Monaco.editor.IModelDeltaDecoration[] = []
      // A deleted file is played as its old text on both sides, so the diff
      // draws no removal of its own: the removed tint is laid on here, so the
      // file still reads as what is going away.
      if (step.fileStatus === 'deleted' && lineCount > 0) {
        current.push({
          range: new monaco.Range(1, 1, lineCount, 1),
          options: { isWholeLine: true, className: 'tour-deleted-line' },
        })
      }
      const accent = cssColor('--border-focus')
      const quiet = cssColor('--text-subtle')
      for (const entry of fileSteps) {
        if (entry.startLine === null || entry.endLine === null || stepEditorSide(entry) !== side) continue
        if (entry.id === step.id) continue
        current.push({
          range: new monaco.Range(entry.startLine, 1, entry.endLine, 1),
          options: { overviewRuler: { color: quiet, position: monaco.editor.OverviewRulerLane.Center } },
        })
      }
      if (start !== null && end !== null) {
        current.push({
          range: new monaco.Range(start, 1, end, 1),
          options: {
            isWholeLine: true,
            className: 'tour-step-line',
            linesDecorationsClassName: 'tour-step-rail',
            overviewRuler: { color: accent, position: monaco.editor.OverviewRulerLane.Full },
          },
        })
        // Dim everything outside the step, on this side…
        current.push(...dimRanges(monaco, start, end, lineCount))
      }
      placed.decorations.push(target.createDecorationsCollection(current))
      // …and outside the matching lines on the other side, in side-by-side.
      const otherModel = other.getModel()
      if (start !== null && end !== null && otherModel) {
        const changes = editor.getLineChanges() ?? []
        const [otherStart, otherEnd] = mapRangeAcross(changes, start, end, side)
        placed.decorations.push(
          other.createDecorationsCollection(
            dimRanges(monaco, otherStart, Math.min(otherEnd, otherModel.getLineCount()), otherModel.getLineCount()),
          ),
        )
      }
      host?.classList.toggle('tour-dimmed-host', start !== null)
    }

    if (sameStep) {
      // The same step, placed again. No choreography and no scroll — the owner
      // did not ask to go anywhere.
      placeZone()
      decorate()
      setCalloutVisible(true)
    } else {
      // Out, move, in — one motion at a time. The callout and highlight fade
      // (`tour-leaving`), the zone is placed and the editor scrolls, and only
      // once the scroll has settled do the highlight, the dim and the callout
      // come back (`tour-arriving` plays the highlight's fade once).
      setCalloutVisible(false)
      const leaving = previous !== null
      if (leaving) host?.classList.add('tour-leaving')
      host?.classList.remove('tour-dimmed-host')
      later(leaving ? motionMs('fast', reducedMotion) : 0, () => {
        placeZone()
        reveal()
        later(motionMs('deliberate', reducedMotion), () => {
          host?.classList.add('tour-arriving')
          decorate()
          setCalloutVisible(true)
          later(motionMs('deliberate', reducedMotion), () => host?.classList.remove('tour-arriving'))
        })
      })
    }

    return () => {
      cancelled = true
      for (const timer of timers) window.clearTimeout(timer)
      for (const frame of frames) window.cancelAnimationFrame(frame)
    }
    // `fileSteps` is read through `rulerKey`; the step through `stepKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, monaco, stepKey, rulerKey, diffVersion, host, reducedMotion])

  // Leaving tour mode, or the viewer going away.
  useEffect(
    () => () => {
      clearPlacement(placedRef)
    },
    [],
  )

  const reportHeight = useCallback((height: number) => {
    const placed = placedRef.current
    const measured = Math.ceil(height)
    if (!placed?.zone || !placed.zoneId || measured <= 0 || measured === placed.zone.heightInPx) return
    measuredRef.current = measured
    placed.zone.heightInPx = measured
    const zoneId = placed.zoneId
    placed.target.changeViewZones((accessor) => accessor.layoutZone(zoneId))
  }, [])

  return { zoneNode, calloutVisible, reportHeight }
}

function dimRanges(
  monaco: MonacoApi,
  start: number,
  end: number,
  lineCount: number,
): Monaco.editor.IModelDeltaDecoration[] {
  const out: Monaco.editor.IModelDeltaDecoration[] = []
  const options: Monaco.editor.IModelDecorationOptions = { inlineClassName: 'tour-dim' }
  if (start > 1) out.push({ range: new monaco.Range(1, 1, start - 1, Number.MAX_SAFE_INTEGER), options })
  if (end < lineCount) out.push({ range: new monaco.Range(end + 1, 1, lineCount, Number.MAX_SAFE_INTEGER), options })
  return out
}

function clearPlacement(
  ref: MutableRefObject<{
    target: Monaco.editor.ICodeEditor
    zoneId: string | null
    decorations: Monaco.editor.IEditorDecorationsCollection[]
    layoutListener: { dispose(): void } | null
  } | null>,
): void {
  const placed = ref.current
  if (!placed) return
  ref.current = null
  placed.layoutListener?.dispose()
  clearDecorations(placed)
  try {
    placed.target.changeViewZones((accessor) => {
      if (placed.zoneId) accessor.removeZone(placed.zoneId)
    })
  } catch {
    // Same: a disposed editor has no zones to remove.
  }
}

function clearDecorations(placed: { decorations: Monaco.editor.IEditorDecorationsCollection[] }): void {
  for (const collection of placed.decorations.splice(0)) {
    try {
      collection.clear()
    } catch {
      // The editor went first; its decorations went with it.
    }
  }
}
