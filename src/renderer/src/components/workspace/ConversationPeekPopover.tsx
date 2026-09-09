import React, { useEffect, useRef, useState } from 'react'

import { PointerPopover } from '../ui'
import type { ConversationPeekIdentity } from './ConversationPeekCard'
import { useConversationPeek, useCopyValue } from './useConversationPeek'

// The peek card itself — the thread, the file list, the image strip — behind a
// `React.lazy` boundary at this call site (bundle-
// budget ratchet). It is only ever rendered inside an OPEN popover, so the
// hover that opens one fetches it; nothing on first paint reads it. The named
// export stays where it was, so anything importing the card directly is
// untouched. `fallback={null}` because the glass surface is already on screen
// with its own size, and a loader inside it would flash for one frame.
const ConversationPeekCard = React.lazy(() =>
  import('./ConversationPeekCard').then((m) => ({ default: m.ConversationPeekCard })),
)


// The conversation peek as a sidebar row's hover surface. The tab anchor lives
// in `AgentTabIdentityPopover` — same card, same hook, a different anchor and a
// different placement, which is the whole difference the design allows between
// the two.
//
// A row may hold several agents, and the card is about ONE of them
// (2026-09-09). The row already lists them as sub-lines, so this shell reads
// the `data-peek-session` of whichever line the pointer is on and shows that
// agent's card; a row with a single agent has one identity and the pointer can
// be anywhere on it.
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
  identities,
  children,
  now,
  className,
  onOpenDiff,
}: {
  /**
   * One identity per agent this row can peek at, most recently active first.
   * Never empty — the caller draws no popover for a row with no conversation.
   */
  identities: ConversationPeekIdentity[]
  /** The row's own title content. Rendered inline; its events are left alone. */
  children: React.ReactNode
  now: number
  className?: string
  /** Open the diff for one of this agent's changed paths, or the whole diff for `null`. */
  onOpenDiff?: (path: string | null) => void
}) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  // The card's own subtree, so a scroll that starts inside it can be told apart
  // from the app scrolling beneath it. It is portaled, so this is the only
  // handle on it from here.
  const cardRef = useRef<HTMLDivElement>(null)
  const [point, setPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  // Which of the row's agent lines the pointer is on, from the row's own
  // `data-peek-session` markup. Null while the pointer is on the row itself —
  // its title, its meta line, the space beside them — and then the card is the
  // FIRST identity, the most recently active terminal, which is the one you are
  // most likely reaching for. Not the first by name or id, which is an
  // arbitrary answer dressed up as a considered one.
  const [hoveredSession, setHoveredSession] = useState<string | null>(null)
  // Whose card this opening started on, captured at reveal. It cannot be read
  // off `identities[0]` each render: that list is sorted by last activity, so a
  // SIBLING agent producing output re-sorts it and the open card silently
  // becomes a different agent's — under a pointer that has not moved, and with
  // a fresh transcript read behind it. The list is still the source of the
  // choice; it is only the moment of choosing that is pinned.
  const [openedOn, setOpenedOn] = useState<string | null>(null)
  // Read through a ref so the reveal handlers below can capture the CURRENT
  // list without re-binding every listener each time it is re-sorted.
  const identitiesRef = useRef(identities)
  identitiesRef.current = identities
  const chosen = hoveredSession ?? openedOn
  const identity =
    identities.find((entry) => entry.agent.sessionId === chosen) ?? identities[0] ?? null
  const sessionId = identity?.agent.sessionId ?? null
  const hover = useConversationPeek(sessionId)
  const { copied, copy } = useCopyValue(sessionId)
  const { openNow, openSoon, closeSoon, closeNow, keepOpen } = hover

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
      setOpenedOn(identitiesRef.current[0]?.agent.sessionId ?? null)
      anchor()
      openSoon()
    }
    const onLeave = () => closeSoon()
    // Hovering one of the row's own agent lines opens the card ON THAT AGENT
    // (mockup frame 3). Delegated from the row rather than wired per line: the
    // lines are the sidebar's markup, and one listener that reads the attribute
    // beats threading a callback through every terminal line. `mouseover`, not
    // `mouseenter`, precisely because it DOES fire moving between descendants —
    // that is the whole event here.
    const onOver = (event: MouseEvent) => {
      const target = event.target as Element | null
      const line = target?.closest?.('[data-peek-session]')
      setHoveredSession(line?.getAttribute('data-peek-session') ?? null)
    }
    const onFocusIn = () => {
      // Focus lands on the ROW, never on one of its agent lines, so a keyboard
      // reveal is about the chat and opens on its first agent — not on whatever
      // line a pointer last crossed, possibly minutes ago. Deliberately NOT
      // done on mouseleave: the close is graced so the pointer can travel into
      // the card, and swapping the agent during that grace would change the
      // card out from under a pointer on its way to it.
      setHoveredSession(null)
      setOpenedOn(identitiesRef.current[0]?.agent.sessionId ?? null)
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
  }, [closeSoon, openNow, openSoon])

  // A row that scrolls out from under an open card leaves the card hanging over
  // whatever took its place. The sidebar scrolls constantly, so the card goes
  // rather than tracks: a peek is a glance, and re-hovering costs one dwell.
  //
  // But it must be a scroll of the PAGE UNDER the card, never one inside it.
  // `scroll` does not bubble, so this listens in the capture phase to catch
  // nested scrollers — and capture on `window` sees every scroller in the
  // document, the card's own thread included. That closed the card a frame
  // after it opened: the thread scrolls itself to its newest message in a
  // layout effect (see `Thread`), that programmatic scroll reached this
  // listener, and the card dismissed itself before it had been seen. It also
  // meant a person scrolling the thread by hand destroyed what they were
  // reading. So a scroll that starts inside the card is not the app moving
  // beneath it, and is ignored.
  const open = hover.open
  useEffect(() => {
    if (!open) return
    const dismiss = (event: Event) => {
      const target = event.target as Node | null
      if (target && cardRef.current?.contains(target)) return
      closeNow()
    }
    window.addEventListener('scroll', dismiss, true)
    return () => window.removeEventListener('scroll', dismiss, true)
  }, [closeNow, open])

  return (
    <span ref={anchorRef} className={className ?? 'flex min-w-0 flex-1 items-center gap-1.5'}>
      {children}
      {open && identity ? (
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
          <div ref={cardRef} onMouseEnter={keepOpen} onMouseLeave={closeSoon}>
            <React.Suspense fallback={null}>
              <ConversationPeekCard
                identity={identity}
                peek={hover.peek}
                loading={hover.loading}
                now={now}
                copied={copied}
                onCopySession={copy}
                onOpenAttachment={hover.openAttachment}
                onOpenDiff={onOpenDiff}
              />
            </React.Suspense>
          </div>
        </PointerPopover>
      ) : null}
    </span>
  )
}
