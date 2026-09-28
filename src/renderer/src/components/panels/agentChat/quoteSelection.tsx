import { useEffect, useLayoutEffect, useRef, useState, type JSX, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { GhostButton } from '../../ui'
import { OVERLAY_SURFACE_CLASS } from '../../ui/tokens'

// Quote a stretch of a reply back into the composer: select text in the
// assistant's prose and a small toolbar offers to carry it down as a markdown
// blockquote, so the follow-up says which sentence it is about.

/** The attribute that marks a reply's prose as quotable. */
export const QUOTE_SOURCE_ATTRIBUTE = 'data-quote-source'

// Gap between the selection's last line and the toolbar, and the margin it
// keeps from the window's edges.
const TOOLBAR_GAP = 6
const VIEWPORT_MARGIN = 8

/** `> `-prefixed lines, blank lines kept as bare `>` so the quote stays one block. */
export function quoteAsMarkdown(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.trimEnd())
  while (lines.length && !lines[0]) lines.shift()
  while (lines.length && !lines.at(-1)) lines.pop()
  // A run of blank lines is one paragraph break in the quote, not several.
  const collapsed = lines.filter((line, index) => line || lines[index - 1])
  return collapsed.map((line) => (line ? `> ${line}` : '>')).join('\n')
}

/** The draft with the quote appended as its own block, leaving the caret on a fresh line below it. */
export function appendQuoteToDraft(draft: string, text: string): string {
  const quote = quoteAsMarkdown(text)
  if (!quote) return draft
  const head = draft.trimEnd()
  return `${head ? `${head}\n\n` : ''}${quote}\n\n`
}

type SelectionPoint = { x: number; y: number }

/** The quotable text under the current selection, and where its last line ends. */
export function readQuotableSelection(
  root: HTMLElement,
  selection: Selection | null,
): { text: string; point: SelectionPoint } | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const container = range.commonAncestorContainer
  // 1 is Node.ELEMENT_NODE; a text node answers for its parent element.
  const element = container.nodeType === 1 ? (container as Element) : container.parentElement
  const source = element?.closest(`[${QUOTE_SOURCE_ATTRIBUTE}]`)
  if (!source || !root.contains(source)) return null
  const text = selection.toString().trim()
  if (!text) return null
  const rects = range.getClientRects()
  const last = rects.length ? rects[rects.length - 1]! : range.getBoundingClientRect()
  return { text, point: { x: last.right, y: last.bottom + TOOLBAR_GAP } }
}

type QuotableSelection = { text: string; point: SelectionPoint }

/**
 * Where the toolbar goes after something scrolled. The transcript scrolls on
 * its own while it follows a streaming reply, so a scroll is not a reason to
 * leave: the toolbar moves with the selection it belongs to, and goes only when
 * the selection has gone or scrolled out of the window. The same object comes
 * back when nothing moved, so an unmoved scroll renders nothing.
 */
export function selectionAfterScroll(
  previous: QuotableSelection | null,
  next: QuotableSelection | null,
  viewportHeight: number,
): QuotableSelection | null {
  if (!previous || !next || next.text !== previous.text) return null
  // The point sits under the selection's last line: out of the window above or
  // below, the line it points at is too.
  if (next.point.y - TOOLBAR_GAP < 0 || next.point.y > viewportHeight) return null
  if (Math.abs(next.point.x - previous.point.x) < 0.5 && Math.abs(next.point.y - previous.point.y) < 0.5)
    return previous
  return next
}

// 16-grid, 1.4 line work, currentColor: two opening quote marks.
function QuoteGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0" aria-hidden="true">
      <path
        d="M3 9.5h3v3.5H3V9.5Zm0 0c0-2.5.8-4.2 3-5.5M9.5 9.5h3v3.5h-3V9.5Zm0 0c0-2.5.8-4.2 3-5.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * The floating "Quote" action for a selection inside a reply. It appears once
 * the selection settles — after the pointer is released, or as a keyboard
 * selection changes — and never while a drag is still extending it. Pressing
 * it keeps the selection alive (the press does not move focus) until the quote
 * has been read, then clears it; Escape, the reader scrolling, or a selection
 * elsewhere dismisses it. A scroll the reader did not make — the transcript
 * following a streaming reply — carries it along with the selection instead.
 */
export function QuoteSelectionToolbar({
  rootRef,
  enabled,
  onQuote,
}: {
  rootRef: RefObject<HTMLElement | null>
  enabled: boolean
  onQuote: (text: string) => void
}): JSX.Element | null {
  const [selection, setSelection] = useState<QuotableSelection | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!enabled) {
      setSelection(null)
      return
    }
    let dragging = false
    let frame = 0
    let scrollFrame = 0
    const read = () => {
      frame = 0
      const root = rootRef.current
      setSelection(root && !dragging ? readQuotableSelection(root, document.getSelection()) : null)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    const follow = () => {
      scrollFrame = 0
      const root = rootRef.current
      const next = root && !dragging ? readQuotableSelection(root, document.getSelection()) : null
      setSelection((previous) => selectionAfterScroll(previous, next, window.innerHeight))
    }
    const onPointerDown = (event: PointerEvent) => {
      if (toolbarRef.current?.contains(event.target as Node)) return
      dragging = true
      setSelection(null)
    }
    const onPointerUp = () => {
      dragging = false
      schedule()
    }
    const onSelectionChange = () => {
      if (!dragging) schedule()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !toolbarRef.current) return
      event.preventDefault()
      setSelection(null)
    }
    // The toolbar is placed in window coordinates, so a scroll under it is
    // read again on the next frame and the toolbar follows the selection. The
    // reader's own wheel or swipe means they have moved on, and it goes.
    const onScroll = () => {
      if (!scrollFrame) scrollFrame = requestAnimationFrame(follow)
    }
    const onUserScroll = () => setSelection(null)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('wheel', onUserScroll, { capture: true, passive: true })
    document.addEventListener('touchmove', onUserScroll, { capture: true, passive: true })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      if (scrollFrame) cancelAnimationFrame(scrollFrame)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('wheel', onUserScroll, true)
      document.removeEventListener('touchmove', onUserScroll, true)
    }
  }, [enabled, rootRef])

  // Clamp into the window once the toolbar's own size is known.
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar || !selection) return
    const rect = toolbar.getBoundingClientRect()
    const x = selection.point.x - rect.width
    toolbar.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(x, window.innerWidth - rect.width - VIEWPORT_MARGIN))}px`
    toolbar.style.top = `${Math.max(VIEWPORT_MARGIN, Math.min(selection.point.y, window.innerHeight - rect.height - VIEWPORT_MARGIN))}px`
  }, [selection])

  if (!selection) return null
  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="Selection"
      data-quote-toolbar=""
      className={`fixed z-[var(--z-popover)] p-0.5 ${OVERLAY_SURFACE_CLASS}`}
      style={{ left: selection.point.x, top: selection.point.y }}
    >
      <GhostButton
        size="xs"
        // Keep the selection: a press that took focus would collapse it first.
        onPointerDown={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onQuote(selection.text)
          document.getSelection()?.removeAllRanges()
          setSelection(null)
        }}
      >
        <QuoteGlyph />
        Quote in reply
      </GhostButton>
    </div>,
    document.body,
  )
}
