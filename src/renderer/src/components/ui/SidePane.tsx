import React, { useCallback, useRef, useState } from 'react'
import { CloseIconButton } from './Buttons'
import { TruncatedText } from './TruncatedText'
import { FOCUS_RING_CLASS } from './tokens'

// SidePane — pure chrome primitive for the side columns that sit alongside
// a board or list. Owns the width preset, the single hairline divider, and
// the flex column. Does NOT own the header (callers compose either
// PanelHeader for primary-column inboxes or SidePaneHeader for the simpler
// closable-aside pattern) or the scroll body (kept caller-owned because
// keyboard handlers and list semantics vary per surface).
//
// Renders as <aside> by default (secondary content). Use `as="section"` for
// primary content columns like the inbox column in Watchtower and Sprint
// Engine, where the column carries the panel's main flow.
//
// Width presets match the documented sister-aside widths:
//   sm — 38 % / 320–520. Quieter right-side asides (running agents,
//        active review).
//   md — 42 % / 320–560. Detail asides anchored to the right.
//   lg — 44 % / 320–560. Primary content columns (inbox columns).

type WidthPreset = 'sm' | 'md' | 'lg'

const WIDTH_PRESETS: Record<WidthPreset, string> = {
  sm: 'w-[38%] min-w-[320px] max-w-[520px]',
  md: 'w-[42%] min-w-[320px] max-w-[560px]',
  lg: 'w-[44%] min-w-[320px] max-w-[560px]',
}

type SidePaneProps = {
  /** `aside` (default) marks secondary content; `section` marks a primary
   *  content column anchored on one side of the panel. */
  as?: 'aside' | 'section'
  /** Which edge carries the hairline divider. */
  side: 'left' | 'right'
  /** Width preset; see comment header for the per-token mapping. */
  width?: WidthPreset
  /** When true, the pane fills the available flex row (caller is responsible
   *  for hiding the adjacent content). The side divider is dropped since
   *  there is no neighbouring surface to separate from. */
  expanded?: boolean
  /** Render the pane with `--bg-app` instead of inheriting the panel's
   *  surface. Used for "sunken" secondary asides (running agents, active
   *  review) that benefit from a quiet shade contrast against the lane. */
  tone?: 'default' | 'sunken'
  ariaLabel?: string
  ariaLabelledBy?: string
  className?: string
  /** Opt-in drag-resize: the pane's current width in px. While set (and not
   *  expanded) it overrides the preset width. Callers own clamping and
   *  persistence; `null` falls back to the preset. */
  widthPx?: number | null
  /** Opt-in drag-resize: called with the raw dragged width in px on every
   *  resize step (pointer drag or arrow keys on the separator). Rendering the
   *  drag handle is gated on this prop. */
  onResizeWidth?: (px: number) => void
  /** Optional reset (double-click / Home on the separator) — typically
   *  restores the preset width. */
  onResizeReset?: () => void
  /** Accessible name for the resize separator. */
  resizeLabel?: string
  children: React.ReactNode
}

export function SidePane({
  as = 'aside',
  side,
  width = 'md',
  expanded = false,
  tone = 'default',
  ariaLabel,
  ariaLabelledBy,
  className,
  widthPx,
  onResizeWidth,
  onResizeReset,
  resizeLabel = 'Resize pane',
  children,
}: SidePaneProps) {
  const paneRef = useRef<HTMLElement | null>(null)
  const [isResizing, setIsResizing] = useState(false)
  const hasPixelWidth = !expanded && typeof widthPx === 'number'
  const resizable = !expanded && Boolean(onResizeWidth)

  // Width from the drag position: the pane grows away from its divider edge,
  // so a right-side pane measures from its right edge back to the pointer.
  const widthFromPointer = useCallback(
    (clientX: number): number | null => {
      const rect = paneRef.current?.getBoundingClientRect()
      if (!rect) return null
      return Math.round(side === 'right' ? rect.right - clientX : clientX - rect.left)
    },
    [side],
  )

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!onResizeWidth || event.button !== 0) return
      event.preventDefault()
      // Capture the pointer on the handle: the pane commonly hosts an iframe
      // (sandboxed HTML previews) that would otherwise swallow pointermove /
      // pointerup mid-drag and leave the resize stuck with the listeners and
      // the body cursor/user-select overrides leaked.
      const handle = event.currentTarget
      try {
        handle.setPointerCapture(event.pointerId)
      } catch {
        // Capture is an enhancement; the drag still works without it.
      }
      let frame: number | null = null
      let pendingX = event.clientX
      const apply = () => {
        frame = null
        const next = widthFromPointer(pendingX)
        if (next !== null) onResizeWidth(next)
      }
      const onMove = (e: PointerEvent) => {
        pendingX = e.clientX
        if (frame === null) frame = window.requestAnimationFrame(apply)
      }
      const end = () => {
        if (frame !== null) window.cancelAnimationFrame(frame)
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', end)
        handle.removeEventListener('pointercancel', end)
        try {
          handle.releasePointerCapture(event.pointerId)
        } catch {
          // Already released (e.g. pointercancel) — nothing to undo.
        }
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setIsResizing(false)
      }
      setIsResizing(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', end)
      handle.addEventListener('pointercancel', end)
    },
    [onResizeWidth, widthFromPointer],
  )

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!onResizeWidth) return
      const STEP = 16
      const current = paneRef.current?.getBoundingClientRect().width ?? widthPx ?? 0
      // The divider sits on the pane's inner edge, so "toward the divider"
      // grows a right pane and shrinks a left one.
      const grow = side === 'right' ? 'ArrowLeft' : 'ArrowRight'
      const shrink = side === 'right' ? 'ArrowRight' : 'ArrowLeft'
      if (event.key === grow) {
        event.preventDefault()
        onResizeWidth(Math.round(current + STEP))
      } else if (event.key === shrink) {
        event.preventDefault()
        onResizeWidth(Math.round(current - STEP))
      } else if (event.key === 'Home' && onResizeReset) {
        event.preventDefault()
        onResizeReset()
      }
    },
    [onResizeWidth, onResizeReset, side, widthPx],
  )

  const classes = [
    'flex flex-col',
    expanded
      ? 'min-w-0 w-full max-w-none flex-1'
      : hasPixelWidth
        ? // Pixel widths still respect a container-relative ceiling so a wide
          // persisted width cannot starve the adjacent board on a narrow
          // window — CSS max-width beats the inline width when they conflict.
          'min-w-[320px] max-w-[65%] shrink-0'
        : WIDTH_PRESETS[width],
    expanded
      ? ''
      : side === 'left'
        ? 'border-r border-[color:var(--border-default)]'
        : 'border-l border-[color:var(--border-default)]',
    tone === 'sunken' ? 'bg-[color:var(--bg-app)]' : '',
    resizable ? 'relative' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  const style = hasPixelWidth ? { width: widthPx } : undefined

  const resizeHandle = resizable ? (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={resizeLabel}
      tabIndex={0}
      onPointerDown={handleResizePointerDown}
      onKeyDown={handleResizeKeyDown}
      onDoubleClick={onResizeReset}
      className={`group absolute top-0 z-[var(--z-pane)] h-full w-1.5 cursor-col-resize ${FOCUS_RING_CLASS} ${
        side === 'right' ? 'left-0 -translate-x-1/2' : 'right-0 translate-x-1/2'
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[color:var(--accent-primary)] transition-opacity ${
          isResizing ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'
        }`}
      />
    </div>
  ) : null

  if (as === 'section') {
    return (
      <section
        ref={paneRef as React.RefObject<HTMLElement>}
        className={classes}
        style={style}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
      >
        {resizeHandle}
        {children}
      </section>
    )
  }
  return (
    <aside
      ref={paneRef as React.RefObject<HTMLElement>}
      className={classes}
      style={style}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
    >
      {resizeHandle}
      {children}
    </aside>
  )
}

// SidePaneHeader — the simple title+count+close header used by the
// closable secondary asides (Switchboard running agents, Watchtower active
// review). Detail panes with bespoke headers (Switchboard board detail,
// Sprint Engine inspector) compose their own headers inside SidePane
// directly and do not use this component.
//
// Anatomy matches PanelHeader's title rhythm (13 px semibold) so a board
// and its detail aside read as one family. No status dot here; the close
// is the only chrome.

type SidePaneHeaderProps = {
  title: string
  /** Optional trailing count or short status. Display only — must not host
   *  interactive elements. */
  count?: React.ReactNode
  onClose: () => void
  /** Accessible name for the close button. Required: blanket "Close" is
   *  ambiguous when several side panes can be open in the same view. */
  closeLabel: string
  titleId?: string
}

export function SidePaneHeader({ title, count, onClose, closeLabel, titleId }: SidePaneHeaderProps) {
  return (
    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-[color:var(--border-default)] px-3 py-2">
      <TruncatedText
        as="h3"
        id={titleId}
        text={title}
        className="text-body font-semibold tracking-tight text-[color:var(--text-strong)]"
      />
      <div className="flex shrink-0 items-center gap-2 text-micro text-[color:var(--text-muted)]">
        {count !== undefined && count !== null ? (
          <span className="tabular-nums">{count}</span>
        ) : null}
        <CloseIconButton aria-label={closeLabel} onClick={onClose} />
      </div>
    </header>
  )
}
