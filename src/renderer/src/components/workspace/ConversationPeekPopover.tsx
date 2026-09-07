import React, { useEffect, useRef, useState } from 'react'

import { PointerPopover } from '../ui'
import { ConversationPeekCard, type ConversationPeekIdentity } from './ConversationPeekCard'
import { useConversationPeek, useCopyValue } from './useConversationPeek'

// The conversation peek as a sidebar row's hover surface. The tab anchor lives
// in `AgentTabIdentityPopover` — same card, same hook, a different anchor and a
// different placement, which is the whole difference the design allows between
// the two (mockup frame 3: "one component, two anchors").
//
// The shell is `PointerPopover`, the kit's coordinate-anchored rich surface:
// portal, viewport clamp, Escape, outside-press, focus restore. What is added
// here is hover — the popover is controlled, so open and close come from the
// pointer on the row AND on the card, with the grace period that makes the gap
// between them crossable. That is what separates this from a tooltip, and it is
// why the card may hold buttons at all.

/**
 * Gap between the row and the card. The mockup pins the card one `space-sm`
 * clear of the row's trailing edge and one `space-xs` above its top, so it
 * reads as having risen out of the row rather than as covering the row below.
 */
const ANCHOR_GAP = 8
const ANCHOR_RISE = 6

export function ConversationPeekPopover({
  identity,
  children,
  now,
  className,
}: {
  identity: ConversationPeekIdentity
  /** The row's own title content. Rendered inline; its events are left alone. */
  children: React.ReactNode
  now: number
  className?: string
}) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [point, setPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  // The card opens on the roster's first entry — the most recently active
  // terminal, which is the one you are most likely reaching for. Not the first
  // by name or id, which is an arbitrary answer dressed up as a considered one.
  const hover = useConversationPeek(identity.roster[0]?.sessionId ?? null)
  const { copied, copy } = useCopyValue(hover.selectedSessionId)
  const { openNow, openSoon, closeSoon, closeNow, keepOpen, previewAgent, endPreview } = hover

  // THE WHOLE ROW is the trigger (owner, 2026-09-07). A chat row is two lines —
  // the title, and the meta line carrying heads · provenance · branch · diff —
  // and the card has to open from a hover anywhere on it, either line and the
  // space beside them. Wrapping the title alone would have made most of the row
  // inert for the one surface that describes the whole of it.
  //
  // Wired to the row element from the DOM rather than through a prop, for the
  // same reason the tab resolves its FlexLayout button: the row is the
  // sidebar's markup, and threading a ref down to every row's title cluster
  // would make the whole row component carry this feature.
  //
  // `mouseenter` / `mouseleave` and not `mouseover` / `mouseout`: they do not
  // fire when the pointer moves BETWEEN descendants, so travelling from the
  // title to the row's own trailing controls — the actions button, the close
  // button — never re-fires the dwell and never schedules a close. Those
  // controls keep working exactly as they did.
  //
  // The traffic in the other direction is sealed in the shell, not here:
  // `PointerPopover` stops click / dblclick / mousedown / contextmenu / keydown
  // at its surface, because a portal is still a React CHILD of its opener and
  // React propagates through the React tree. Without that, pressing Copy on
  // this card selected the row it opened from.
  //
  // Focus rides the same element because the ROW is the tree item that takes
  // focus, and focus does not bubble into its children. Arrowing onto a row
  // reveals its card with no dwell, because a person who moved focus here
  // asked for it.
  //
  // Anchoring is measured at reveal, beside the row, so the shell never paints
  // once at 0,0 and then jumps.
  useEffect(() => {
    const el = anchorRef.current
    if (!el) return
    const row = el.closest<HTMLElement>('[data-row-key]') ?? el

    const anchor = () => {
      const rect = row.getBoundingClientRect()
      setPoint({ x: rect.right + ANCHOR_GAP, y: rect.top - ANCHOR_RISE })
    }
    const onEnter = () => {
      anchor()
      openSoon()
    }
    const onLeave = () => closeSoon()
    // Hovering one of the row's own heads opens the card ON THAT TERMINAL
    // (mockup frame 9). Delegated from the row rather than wired per line: the
    // heads are the sidebar's markup, and one listener that reads the attribute
    // beats threading a callback through every terminal line. `mouseover`, not
    // `mouseenter`, precisely because it DOES fire moving between descendants —
    // that is the whole event here.
    const onOver = (event: MouseEvent) => {
      const target = event.target as Element | null
      const head = target?.closest?.('[data-peek-session]')
      const session = head?.getAttribute('data-peek-session')
      if (session) previewAgent(session)
      else endPreview()
    }
    const onFocusIn = () => {
      anchor()
      openNow()
    }
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null
      if (next && row.contains(next)) return
      closeSoon()
    }
    row.addEventListener('mouseenter', onEnter)
    row.addEventListener('mouseleave', onLeave)
    row.addEventListener('mouseover', onOver)
    row.addEventListener('focusin', onFocusIn)
    row.addEventListener('focusout', onFocusOut)
    return () => {
      row.removeEventListener('mouseenter', onEnter)
      row.removeEventListener('mouseleave', onLeave)
      row.removeEventListener('mouseover', onOver)
      row.removeEventListener('focusin', onFocusIn)
      row.removeEventListener('focusout', onFocusOut)
    }
  }, [closeSoon, endPreview, openNow, openSoon, previewAgent])

  // A row that scrolls out from under an open card leaves the card hanging over
  // whatever took its place. The sidebar scrolls constantly, so the card goes
  // rather than tracks: a peek is a glance, and re-hovering costs one dwell.
  const open = hover.open
  useEffect(() => {
    if (!open) return
    const dismiss = () => closeNow()
    window.addEventListener('scroll', dismiss, true)
    return () => window.removeEventListener('scroll', dismiss, true)
  }, [closeNow, open])

  return (
    <span ref={anchorRef} className={className ?? 'flex min-w-0 flex-1 items-center gap-1.5'}>
      {children}
      {open ? (
        <PointerPopover
          x={point.x}
          y={point.y}
          ariaLabel={`${identity.name} — conversation`}
          popupRole="dialog"
          onClose={closeNow}
          material="glass"
          surfaceClassName="conversation-peek-surface w-[340px]"
        >
          {/* The card keeps itself open while the pointer rests on it — that is
              what makes the copy button and the attachment chips reachable
              across the gap from the row. */}
          <div onMouseEnter={keepOpen} onMouseLeave={closeSoon}>
            <ConversationPeekCard
              identity={identity}
              peek={hover.peek}
              loading={hover.loading}
              now={now}
              copied={copied}
              onCopySession={copy}
              onOpenAttachment={hover.openAttachment}
              selectedSessionId={hover.selectedSessionId}
              pinnedSessionId={hover.pinnedSessionId}
              onPreviewAgent={hover.previewAgent}
              onEndPreview={hover.endPreview}
              onPinAgent={hover.pinAgent}
            />
          </div>
        </PointerPopover>
      ) : null}
    </span>
  )
}
