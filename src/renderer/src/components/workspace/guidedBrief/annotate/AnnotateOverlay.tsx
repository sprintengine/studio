import { useEffect, useRef, useState } from 'react'
import { pageRectToOverlayRect, type OverlayTransform } from './bridge'
import {
  ANNOTATE_COMPOSER_WIDTH,
  ANNOTATE_PIN_SIZE,
  annotationDisplayRect,
  composerPlacement,
  pinPlacement,
  type AnnotateComposerState,
} from './annotateModel'
import type { AnnotationRect, MockupAnnotation } from './types'

// The parent-side annotate surface that floats over the sandboxed iframe:
// numbered pins on the captured elements and the anchored note composer. Pins
// and composer are host UI, never injected DOM — the frame stays an opaque
// origin and reports geometry over the validated bridge. The overlay root is
// pointer-transparent so the picker inside the frame keeps receiving hover and
// click; only the pins and the composer accept pointer events.

type Props = {
  annotations: readonly MockupAnnotation[]
  /** Freshest located page rects per selector; explicit null = unanchored. */
  anchors: Readonly<Record<string, AnnotationRect | null>>
  transform: OverlayTransform
  composer: AnnotateComposerState
  /** True while the batch submit is in flight — capture and edits pause. */
  busy: boolean
  onOpenEdit: (index: number) => void
  onComposerMessageChange: (message: string) => void
  onComposerCancel: () => void
  onComposerCommit: () => void
  onComposerRemove: () => void
}

export function AnnotateOverlay({
  annotations,
  anchors,
  transform,
  composer,
  busy,
  onOpenEdit,
  onComposerMessageChange,
  onComposerCancel,
  onComposerCommit,
  onComposerRemove,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const pinRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 })

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new ResizeObserver(() => {
      setContainerSize({ width: root.clientWidth, height: root.clientHeight })
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  // Focus restoration: an edit composer opened from a pin returns focus to that
  // pin when it closes, keeping the keyboard path unbroken.
  const previousComposer = useRef<AnnotateComposerState>(composer)
  useEffect(() => {
    const previous = previousComposer.current
    previousComposer.current = composer
    if (previous.kind === 'edit' && composer.kind === 'closed') {
      pinRefs.current[previous.index]?.focus()
    }
  }, [composer])

  const composerAnchorRect = (): AnnotationRect | null => {
    if (composer.kind === 'new') {
      // The draft anchor falls back to its capture rect so the composer never
      // vanishes mid-typing even if a live reload orphans the selector.
      return annotationDisplayRect(composer.anchor, anchors) ?? composer.anchor.rect
    }
    if (composer.kind === 'edit') {
      const annotation = annotations[composer.index]
      if (!annotation) return null
      return annotationDisplayRect(annotation, anchors) ?? annotation.rect
    }
    return null
  }

  const anchorRect = composerAnchorRect()
  const composerOverlayRect = anchorRect ? pageRectToOverlayRect(anchorRect, transform) : null
  const composerPosition = composerOverlayRect ? composerPlacement(composerOverlayRect, containerSize) : null
  const composerSelector =
    composer.kind === 'new'
      ? composer.anchor.selector
      : composer.kind === 'edit'
        ? annotations[composer.index]?.selector ?? ''
        : ''

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {annotations.map((annotation, index) => {
        const pageRect = annotationDisplayRect(annotation, anchors)
        if (!pageRect) return null // unanchored — flagged in the tray list, never a stray pin
        const position = pinPlacement(pageRectToOverlayRect(pageRect, transform), containerSize)
        return (
          <button
            key={`${annotation.selector}::${index}`}
            ref={(node) => {
              pinRefs.current[index] = node
            }}
            type="button"
            disabled={busy}
            onClick={() => onOpenEdit(index)}
            aria-label={`Edit note ${index + 1}: ${annotation.message}`}
            className="
              pointer-events-auto absolute grid place-items-center rounded-full
              border-2 border-[color:var(--bg-surface)] bg-[color:var(--annotate-pin-bg)]
              text-micro font-semibold tabular-nums text-[color:var(--annotate-pin-ink)]
              shadow-[var(--shadow-drawer)] disabled:opacity-60
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]
            "
            style={{ left: position.left, top: position.top, width: ANNOTATE_PIN_SIZE, height: ANNOTATE_PIN_SIZE }}
          >
            {index + 1}
          </button>
        )
      })}
      {composer.kind !== 'closed' && composerPosition ? (
        <NoteComposer
          mode={composer.kind}
          message={composer.message}
          selector={composerSelector}
          position={composerPosition}
          onMessageChange={onComposerMessageChange}
          onCancel={onComposerCancel}
          onCommit={onComposerCommit}
          onRemove={onComposerRemove}
        />
      ) : null}
    </div>
  )
}

function NoteComposer({
  mode,
  message,
  selector,
  position,
  onMessageChange,
  onCancel,
  onCommit,
  onRemove,
}: {
  mode: 'new' | 'edit'
  message: string
  selector: string
  position: { left: number; top: number }
  onMessageChange: (message: string) => void
  onCancel: () => void
  onCommit: () => void
  onRemove: () => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    textareaRef.current?.focus()
    // Two-frame flip so the motion-safe fade has a start state; reduced motion
    // gets the final state immediately (no transition is registered).
    const frame = window.requestAnimationFrame(() => setEntered(true))
    return () => window.cancelAnimationFrame(frame)
  }, [])

  const commitDisabled = message.trim().length === 0

  return (
    <div
      role="dialog"
      aria-label={mode === 'edit' ? 'Edit note' : 'New note'}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel()
        }
      }}
      className={`
        pointer-events-auto absolute flex flex-col gap-2 rounded-md border border-[color:var(--border-default)]
        bg-[color:var(--bg-surface-raised)] p-2.5 shadow-[var(--shadow-drawer)]
        motion-safe:transition-opacity motion-safe:duration-150
        ${entered ? 'opacity-100' : 'motion-safe:opacity-0'}
      `}
      style={{ left: position.left, top: position.top, width: ANNOTATE_COMPOSER_WIDTH }}
    >
      <span className="truncate font-mono text-micro text-[color:var(--text-subtle)]">{selector}</span>
      <textarea
        ref={textareaRef}
        value={message}
        rows={3}
        placeholder="Describe the change"
        onChange={(event) => onMessageChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !commitDisabled) {
            event.preventDefault()
            onCommit()
          }
        }}
        className="
          resize-none rounded-sm border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]
          px-2 py-1.5 text-[12px] leading-5 text-[color:var(--text-default)]
          placeholder:text-[color:var(--text-subtle)]
          focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]
        "
      />
      <div className="flex items-center gap-1.5">
        {mode === 'edit' ? (
          <button
            type="button"
            onClick={onRemove}
            className="
              inline-flex h-6 items-center rounded-sm px-1.5 text-[11px] text-[color:var(--tone-warn)]
              transition-colors hover:bg-[color:var(--tone-warn-soft)]
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]
            "
          >
            Remove
          </button>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="
              inline-flex h-6 items-center rounded-sm px-1.5 text-[11px] text-[color:var(--text-muted)]
              transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]
            "
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onCommit}
            disabled={commitDisabled}
            className="
              inline-flex h-6 items-center rounded-sm bg-[color:var(--accent-primary)] px-2 text-[11px] font-medium
              text-[color:var(--text-on-accent)] transition-colors disabled:opacity-50
              enabled:hover:opacity-90
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]
            "
          >
            {mode === 'edit' ? 'Save' : 'Add note'}
          </button>
        </span>
      </div>
    </div>
  )
}
