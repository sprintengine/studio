import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Popover } from '../ui/Popover'
import { formatRelativeMsAgo } from '../../utils/relativeTime'

// The last prompt a person sent to a terminal, revealed by hovering its tab.
//
// A tab says "Agent" or "Terminal" and nothing about what it was for, so a
// workspace of them is unreadable after a day away. This shows the message that
// started the work, clamped to a few lines; when it is longer than the clamp the
// popover itself expands it — there is no label saying so, because the clipped
// text and the pointer cursor already say it.
//
// The surface is `ui/Popover` (the canonical anchored shell — portal, viewport
// flip/clamp, Escape, outside-click). What this adds is hover: Popover is
// controlled, so open/close is driven from pointer enter/leave on the tab AND on
// the surface, with a grace period so the gap between them is crossable. Built to
// backlog/mockups/2026-07-29-tab-prompt-peek.html.

/** Resting height, in lines, before the message clips. */
const CLAMP_LINES = 4

/** Ceiling on the expanded message before it scrolls in place. */
const EXPANDED_MAX_HEIGHT = 220

/** Hover delay. Matches `Tooltip`'s default so tab chrome feels consistent. */
const OPEN_DELAY_MS = 350

/**
 * Grace period after the pointer leaves the tab or the surface. Without it the
 * gap between the two closes the popover before it can be reached, which makes
 * the expand click impossible to perform.
 */
const CLOSE_GRACE_MS = 120

type TabPromptPeekProps = {
  /** The message to reveal. */
  prompt: { text: string; at: number }
  /** The tab's own content. Rendered inline; its events are left untouched. */
  children: React.ReactNode
  /** Accessible name for the surface — the tab's name. */
  tabLabel: string
}

export function TabPromptPeek({ prompt, children, tabLabel }: TabPromptPeekProps) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)

  const clearOpenTimer = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
  }, [])

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  const close = useCallback(() => {
    clearOpenTimer()
    cancelClose()
    setOpen(false)
    // Reset to the resting height, so re-opening never starts expanded from a
    // previous visit.
    setExpanded(false)
  }, [cancelClose, clearOpenTimer])

  const scheduleClose = useCallback(() => {
    clearOpenTimer()
    cancelClose()
    closeTimer.current = window.setTimeout(close, CLOSE_GRACE_MS)
  }, [cancelClose, clearOpenTimer, close])

  const scheduleOpen = useCallback(() => {
    cancelClose()
    clearOpenTimer()
    openTimer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS)
  }, [cancelClose, clearOpenTimer])

  const openNow = useCallback(() => {
    cancelClose()
    clearOpenTimer()
    setOpen(true)
  }, [cancelClose, clearOpenTimer])

  useEffect(
    () => () => {
      clearOpenTimer()
      cancelClose()
    },
    [cancelClose, clearOpenTimer],
  )

  // A new message reopens at the resting height — the previous prompt's overflow
  // verdict says nothing about this one.
  useEffect(() => {
    setExpanded(false)
  }, [prompt.at])

  // Is the message actually clipped? That is what makes the surface clickable at
  // all. Measured before paint, and only while clamped: once expanded the clamp
  // is gone and scrollHeight would describe the scroll box, not an overflow.
  useLayoutEffect(() => {
    if (!open || expanded) return
    const text = textRef.current
    if (!text) return
    setOverflows(text.scrollHeight > text.clientHeight + 1)
  }, [open, expanded, prompt.text])

  const canExpand = overflows && !expanded

  return (
    <span
      className="inline-flex min-w-0"
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      // Keyboard parity: focusing the tab reveals the message with no delay, so
      // the affordance is never hover-only.
      onFocus={openNow}
      onBlur={scheduleClose}
    >
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (!next) close()
        }}
        ariaLabel={`Last message in ${tabLabel}`}
        popupRole="dialog"
        placement="bottom-start"
        className="min-w-0"
        surfaceClassName="w-[320px]"
        renderTrigger={({ ref, triggerProps }) => (
          <span
            ref={ref as unknown as React.Ref<HTMLSpanElement>}
            {...triggerProps}
            className="inline-flex min-w-0"
          >
            {children}
          </span>
        )}
      >
        {/* Padding lives here rather than on the surface so this element covers
            the whole surface — it carries the hover keep-alive, and a padded gap
            it did not cover would read as a pointer-leave. */}
        <div
          className={`px-2.5 py-2 text-left ${canExpand ? 'cursor-pointer' : ''}`}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onClick={canExpand ? () => setExpanded(true) : undefined}
          onKeyDown={
            canExpand
              ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setExpanded(true)
                  }
                }
              : undefined
          }
          role={canExpand ? 'button' : undefined}
          tabIndex={canExpand ? 0 : undefined}
        >
          <p
            ref={textRef}
            className="m-0 whitespace-pre-wrap break-words text-meta leading-snug text-[color:var(--text-default)]"
            style={
              expanded
                ? { maxHeight: EXPANDED_MAX_HEIGHT, overflowY: 'auto' }
                : {
                    display: '-webkit-box',
                    WebkitLineClamp: CLAMP_LINES,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }
            }
          >
            {prompt.text}
          </p>
          <p className="m-0 mt-1.5 text-micro tabular-nums text-[color:var(--text-subtle)]">
            {formatRelativeMsAgo(prompt.at, Date.now())}
          </p>
        </div>
      </Popover>
    </span>
  )
}
