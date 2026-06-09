import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon, CloseIcon, CopyIcon } from '../AppIcons'
import { LifecycleGlyph } from './LifecycleGlyph'

/** Viewport coordinates of the click/cursor the error belongs to. */
export type CursorAnchor = { x: number; y: number }

type RuntimeClipboardApi = {
  clipboardWriteText?: (text: string) => Promise<void>
}

async function writeClipboardText(text: string): Promise<void> {
  const api = window.api as typeof window.api & RuntimeClipboardApi
  if (typeof api.clipboardWriteText !== 'function') throw new Error('Clipboard API is unavailable.')
  await api.clipboardWriteText(text)
}

// Distance from the cursor to the nearest edge of the box, and the breathing
// room kept against the viewport edge when clamping.
const CURSOR_GAP = 10
const VIEWPORT_EDGE = 8
const BOX_WIDTH_MAX = 340
const COLLAPSED_MAX_HEIGHT = 36
const EXPANDED_MAX_HEIGHT = 360
// Prefer sitting above the cursor unless there is clearly more room below.
const PREFER_ABOVE_THRESHOLD = 140
// Keep the caret clear of the rounded corners.
const CARET_EDGE_MARGIN = 12

type Placement = {
  left: number
  top?: number
  bottom?: number
  maxHeight: number
  /** True when the box sits above the click (caret hangs below, pointing down). */
  placeAbove: boolean
  /** Caret offset from the box's left edge, aimed at the click point. */
  caretLeft: number
}

export type CursorErrorPopoverProps = {
  /** The error text. Long, multi-line messages are fine — collapsed view clips. */
  message: string
  /** Where the failing click happened, in viewport coordinates. */
  anchor: CursorAnchor
  onDismiss: () => void
  /** Time the collapsed box lingers before auto-dismissing. Paused on hover,
   *  focus, or while expanded. */
  autoDismissMs?: number
}

/**
 * A small error box anchored to the pointer that raised it, with a caret tying
 * it back to the click. Used for transient "this click failed" feedback — a
 * missing file link, a rejected drop — where a corner toast is too heavy and
 * too far from the user's eye.
 *
 * It is the pointer-scoped member of the app's --tone-error family (Banner,
 * InlineNotice, Toast): a calm tinted surface, one tone-error hairline, and the
 * shape-coded `failed` glyph rather than a saturated fill. Collapsed it shows
 * one clipped line and self-dismisses; clicking expands it to the full message
 * with copy. It dismisses on Escape, on a click anywhere outside, or on the
 * auto-dismiss timer — whichever comes first.
 */
export function CursorErrorPopover({
  message,
  anchor,
  onDismiss,
  autoDismissMs = 3500,
}: CursorErrorPopoverProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const copiedTimerRef = useRef<number | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [paused, setPaused] = useState(false)
  const [copied, setCopied] = useState(false)
  const [placement, setPlacement] = useState<Placement | null>(null)

  // Measure once mounted, then clamp horizontally and anchor the edge nearest
  // the cursor so the box grows away from the pointer instead of drifting. The
  // caret is aimed back at the click even when the box is clamped sideways.
  useLayoutEffect(() => {
    const node = boxRef.current
    if (!node) return
    const compute = () => {
      const width = Math.min(node.offsetWidth, BOX_WIDTH_MAX)
      const vw = window.innerWidth
      const vh = window.innerHeight
      const left = Math.max(VIEWPORT_EDGE, Math.min(anchor.x - width / 2, vw - width - VIEWPORT_EDGE))
      const caretLeft = Math.max(
        CARET_EDGE_MARGIN,
        Math.min(anchor.x - left, width - CARET_EDGE_MARGIN),
      )
      const spaceAbove = anchor.y - CURSOR_GAP - VIEWPORT_EDGE
      const spaceBelow = vh - anchor.y - CURSOR_GAP - VIEWPORT_EDGE
      const placeAbove = spaceAbove >= PREFER_ABOVE_THRESHOLD || spaceAbove >= spaceBelow
      if (placeAbove) {
        setPlacement({ left, bottom: vh - (anchor.y - CURSOR_GAP), maxHeight: spaceAbove, placeAbove, caretLeft })
      } else {
        setPlacement({ left, top: anchor.y + CURSOR_GAP, maxHeight: spaceBelow, placeAbove, caretLeft })
      }
    }
    compute()
    window.addEventListener('resize', compute)
    return () => window.removeEventListener('resize', compute)
  }, [anchor.x, anchor.y])

  // Auto-dismiss only while collapsed and idle. Expanding or hovering pins it so
  // the user can read and copy without racing the timer.
  useEffect(() => {
    if (paused || expanded) return
    const id = window.setTimeout(onDismiss, autoDismissMs)
    return () => window.clearTimeout(id)
  }, [paused, expanded, autoDismissMs, onDismiss])

  // Escape from anywhere, or a pointer press anywhere outside the box, dismisses
  // it — the box never lingers over the terminal once the user moves on.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onDismiss()
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (target && boxRef.current?.contains(target)) return
      onDismiss()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('mousedown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('mousedown', onPointerDown)
    }
  }, [onDismiss])

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    },
    [],
  )

  const handleCopy = useCallback(async () => {
    try {
      await writeClipboardText(message)
      setCopied(true)
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard denied — the message stays on screen and selectable, so the
      // user can still copy it by hand. No silent success.
    }
  }, [message])

  const expandedMaxHeight = placement ? Math.min(placement.maxHeight, EXPANDED_MAX_HEIGHT) : EXPANDED_MAX_HEIGHT
  const caretSide = placement?.placeAbove ? 'down' : 'up'

  return createPortal(
    // Wrapper owns positioning, the enter animation, and the caret. It stays
    // overflow-visible so the caret can hang past the surface; the inner surface
    // does the one-line clamp without clipping the caret.
    <div
      ref={boxRef}
      role="alert"
      aria-live="assertive"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      onClick={() => setExpanded((value) => !value)}
      style={{
        position: 'fixed',
        left: placement?.left ?? 0,
        top: placement?.top,
        bottom: placement?.bottom,
        maxWidth: BOX_WIDTH_MAX,
        // Scale the enter from the caret so the box visibly emanates from the click.
        transformOrigin: placement ? `${placement.caretLeft}px ${placement.placeAbove ? '100%' : '0%'}` : undefined,
        // Hidden until measured so the first paint never flashes at 0,0.
        visibility: placement ? 'visible' : 'hidden',
      }}
      className={['cursor-error-popover z-50', expanded ? 'cursor-default' : 'cursor-pointer'].join(' ')}
    >
      {placement ? (
        <>
          <span
            aria-hidden="true"
            className={`cursor-error-caret cursor-error-caret--${caretSide}`}
            style={{ left: placement.caretLeft, marginLeft: -4.5 }}
          />
          <span
            aria-hidden="true"
            className={`cursor-error-seam cursor-error-seam--${caretSide}`}
            style={{ left: placement.caretLeft, marginLeft: -5.5 }}
          />
        </>
      ) : null}
      <div
        style={{ maxHeight: expanded ? expandedMaxHeight : COLLAPSED_MAX_HEIGHT }}
        className={[
          'cursor-error-surface',
          // design-tokens-allow: popover elevation reuses the canonical OverflowMenu/Popover shadow shape (directional drop, not a glow CTA)
          'rounded-[6px] border shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]',
          expanded ? 'overflow-y-auto' : 'overflow-hidden',
        ].join(' ')}
      >
        <div className="flex items-start gap-1.5 px-2.5 py-1.5">
          <LifecycleGlyph state="failed" label="Failed" live={false} className="mt-px" />
          <div
            className={[
              'min-w-0 flex-1 text-[11px] leading-snug text-[color:var(--text-strong)]',
              expanded ? 'whitespace-pre-wrap break-words font-mono' : 'truncate',
            ].join(' ')}
          >
            {message}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                void handleCopy()
              }}
              aria-label={copied ? 'Copied' : 'Copy error'}
              className={[
                'interactive -my-0.5 inline-flex h-5 w-5 items-center justify-center rounded-[4px]',
                'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]',
                // Copy stays hidden until the box is hovered or expanded so the
                // resting state is just the message.
                expanded || paused ? 'opacity-100' : 'opacity-0',
              ].join(' ')}
            >
              {copied ? (
                <CheckIcon className="h-3 w-3 text-[color:var(--tone-good)]" />
              ) : (
                <CopyIcon className="h-3 w-3" />
              )}
            </button>
            {expanded ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  onDismiss()
                }}
                aria-label="Dismiss"
                className={[
                  'interactive -my-0.5 inline-flex h-5 w-5 items-center justify-center rounded-[4px]',
                  'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]',
                ].join(' ')}
              >
                <CloseIcon className="h-3 w-3" />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
