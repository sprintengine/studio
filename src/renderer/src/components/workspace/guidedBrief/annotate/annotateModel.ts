// Parent-side annotate-mode model (MC-1468 part 2). Pure decisions the frame UI
// renders from — availability, sandbox selection, batch edits, geometry — kept
// free of DOM/React imports so they are unit-testable in the node harness
// (guidedBriefFlow.test.ts) like the rest of the substrate.

import { frameRectToPageRect, type AnnotateSelectMessage } from './bridge'
import type { AnnotationRect, MockupAnnotation } from './types'

/** The frame's file states (FrameState kinds in MockupPreviewPane). */
export type AnnotateFrameKind = 'loading' | 'ready' | 'generating' | 'deleted' | 'error'

export type AnnotateAvailability = { available: true } | { available: false; reason: string }

/**
 * Annotate mode needs a rendered document to anchor to, so only a readable
 * file supports it. Every unavailable state carries explicit human copy for
 * the disabled toggle — a missing file must never read as a broken control.
 */
export function annotateAvailability(kind: AnnotateFrameKind): AnnotateAvailability {
  switch (kind) {
    case 'ready':
      return { available: true }
    case 'deleted':
      return { available: false, reason: 'This file isn’t on disk, so notes can’t be anchored to it.' }
    case 'generating':
      return { available: false, reason: 'This file is still being written. Comment when it renders.' }
    case 'error':
      return { available: false, reason: 'This file can’t be previewed, so it can’t be commented on.' }
    case 'loading':
      return { available: false, reason: 'The preview is still loading.' }
  }
}

/**
 * Sandbox for the preview iframe. Annotate mode requires `allow-scripts` so the
 * injected picker runs (author scripts are neutralized by the srcDoc composer);
 * with annotate off the existing scripts-off default / interactive-demo toggle
 * is byte-for-byte unchanged — the regression contract asserted in tests.
 */
export function annotateFrameSandbox(annotateActive: boolean, allowScripts: boolean): string {
  return annotateActive || allowScripts ? 'allow-scripts' : ''
}

/** A picker selection promoted to a durable anchor (page coords). */
export function anchorFromSelect(select: AnnotateSelectMessage): AnnotateAnchor {
  return {
    selector: select.selector,
    snippet: select.snippet,
    rect: frameRectToPageRect(select.rect, select.scrollOffset),
  }
}

// Batch edits are immutable so React state updates stay referentially honest.
export function addAnnotation(batch: readonly MockupAnnotation[], annotation: MockupAnnotation): MockupAnnotation[] {
  return [...batch, annotation]
}

export function updateAnnotationMessage(
  batch: readonly MockupAnnotation[],
  index: number,
  message: string,
): MockupAnnotation[] {
  return batch.map((annotation, i) => (i === index ? { ...annotation, message } : annotation))
}

export function removeAnnotation(batch: readonly MockupAnnotation[], index: number): MockupAnnotation[] {
  return batch.filter((_, i) => i !== index)
}

/**
 * The rect a pin renders at: the picker's freshest located rect wins, an
 * un-located selector falls back to its capture-time rect, and an explicit
 * null means the selector no longer matches — the pin hides and the tray row
 * flags the note as unanchored instead of silently vanishing.
 */
export function annotationDisplayRect(
  annotation: Pick<MockupAnnotation, 'selector' | 'rect'>,
  anchors: Readonly<Record<string, AnnotationRect | null>>,
): AnnotationRect | null {
  if (annotation.selector in anchors) return anchors[annotation.selector]
  return annotation.rect
}

/** An element anchor before any message is written — a selection, not yet a note. */
export type AnnotateAnchor = Omit<MockupAnnotation, 'message'>

/** Composer lifecycle: closed, drafting a new note on an anchor, or editing note `index`. */
export type AnnotateComposerState =
  | { kind: 'closed' }
  | { kind: 'new'; anchor: AnnotateAnchor; message: string }
  | { kind: 'edit'; index: number; message: string }

/** Batch submit lifecycle. A failure always preserves the batch for retry. */
export type AnnotateSubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'failed'; reason: string }

export function submitFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message.trim() : ''
  return detail
    ? `Your notes were not sent: ${detail} They are kept here — try again.`
    : 'Your notes were not sent. They are kept here — try again.'
}

// --- Overlay geometry -------------------------------------------------------

export const ANNOTATE_PIN_SIZE = 20
export const ANNOTATE_COMPOSER_WIDTH = 260
// Estimated composer height for the above/below flip; measuring the real node
// would need a second layout pass for no visible gain at this size.
const COMPOSER_ESTIMATED_HEIGHT = 150
const EDGE_GAP = 8

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Pin position in overlay coords: centered on the element's top-right corner
 * (the approved mockup's placement), clamped inside the stage so a pin on an
 * edge element never clips away.
 */
export function pinPlacement(
  rect: AnnotationRect,
  container: { width: number; height: number },
): { left: number; top: number } {
  const half = ANNOTATE_PIN_SIZE / 2
  return {
    left: clamp(rect.x + rect.width - half, 2, Math.max(2, container.width - ANNOTATE_PIN_SIZE - 2)),
    top: clamp(rect.y - half, 2, Math.max(2, container.height - ANNOTATE_PIN_SIZE - 2)),
  }
}

/**
 * Composer position in overlay coords: below the anchored element, flipped
 * above when there is no room beneath, clamped to the stage horizontally.
 */
export function composerPlacement(
  rect: AnnotationRect,
  container: { width: number; height: number },
): { left: number; top: number } {
  const left = clamp(rect.x, EDGE_GAP, Math.max(EDGE_GAP, container.width - ANNOTATE_COMPOSER_WIDTH - EDGE_GAP))
  const below = rect.y + rect.height + EDGE_GAP
  const top =
    below + COMPOSER_ESTIMATED_HEIGHT > container.height - EDGE_GAP
      ? Math.max(EDGE_GAP, rect.y - COMPOSER_ESTIMATED_HEIGHT - EDGE_GAP)
      : below
  return { left, top }
}

/** "3 notes" — the tray count, mirrored by the numbered pins. */
export function annotateCountLabel(count: number): string {
  return `${count} note${count === 1 ? '' : 's'}`
}

/** "Send 3 notes" — the one batch action (MC-1468 batch-first decision). */
export function annotateSubmitLabel(count: number): string {
  return `Send ${annotateCountLabel(count)}`
}
