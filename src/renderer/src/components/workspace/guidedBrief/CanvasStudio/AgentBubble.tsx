import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { StageLiveStatus } from '../stageReadiness'
import {
  agentInitials,
  bubbleDotTone,
  bubbleStatusLine,
} from './canvasStudioModel'

// The floating agent presence for the canvas-first studio (MC-1510). Collapsed:
// a soft-edged pill bottom-right — avatar + name + the live stage status line
// (MC-1503), gone-but-alive while you review. Expanded: a floating card (14px
// radius, the deliberate softness the item asks for) that hosts the *existing*
// ConversationPane — this shell only positions and frames it, never forks a
// second chat surface (MC-1478 owns message anatomy). Collapsing unmounts the
// card, not the session: the session is owned upstream and the raw terminal
// re-attaches by id and replays its scrollback on re-expand.

type Props = {
  expanded: boolean
  onExpand: () => void
  onCollapse: () => void
  /** Specialist display name, e.g. "Frontend Designer". */
  name: string
  /** Live specialist status from the transport's own signal (MC-1503). */
  liveStatus?: StageLiveStatus
  /** Whether the stage's validated artifacts are ready (status line + dot tone). */
  ready?: boolean
  /** Renders the reused ConversationPane; `onCollapse` wires its minimize control. */
  renderConversation: (args: { onCollapse: () => void }) => ReactNode
  /** Collapsed-pill button, so the shell can restore focus here on Escape. */
  buttonRef: RefObject<HTMLButtonElement>
}

export function AgentBubble({
  expanded,
  onExpand,
  onCollapse,
  name,
  liveStatus,
  ready = false,
  renderConversation,
  buttonRef,
}: Props) {
  if (expanded) {
    return <ExpandedCard name={name}>{renderConversation({ onCollapse })}</ExpandedCard>
  }

  const statusLine = bubbleStatusLine(liveStatus, ready)
  const dotTone = bubbleDotTone(liveStatus, ready)

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onExpand}
      aria-expanded={false}
      aria-label={`Open the ${name} conversation — ${statusLine}`}
      className={`
        absolute bottom-5 right-5 z-[var(--z-pane)] flex max-w-[calc(100%-2.5rem)] items-center gap-2.5
        rounded-full border bg-[color:var(--bg-surface-raised)] py-2 pl-2.5 pr-4 text-left
        shadow-[var(--shadow-drawer)] transition-colors hover:bg-[color:var(--bg-hover)]
        focus-visible:focus-ring border-[color:var(--border-default)]
      `}
    >
      {/* One status mark: the dot on the avatar. The warn ring around the whole
          pill for `needs-input` (and the accent-soft avatar behind the dot)
          said the same status twice; the status line beside the name and
          `aria-label` carry it in words (audit, status-said-twice).
          The host still decides the collapsed/expanded flip via `bubbleNeedsAttention`. */}
      <span
        aria-hidden="true"
        className="relative inline-flex size-control-xs shrink-0 items-center justify-center rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] text-micro font-semibold text-[color:var(--text-muted)]"
      >
        {agentInitials(name)}
        <span
          className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[color:var(--bg-surface-raised)]"
          style={{ backgroundColor: dotTone }}
        />
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-meta font-semibold text-[color:var(--text-strong)]">
          {name}
        </span>
        <span className="truncate text-micro text-[color:var(--text-subtle)]">{statusLine}</span>
      </span>
    </button>
  )
}

// The floating conversation card. A brief fade/rise on mount, honored under
// prefers-reduced-motion via the `motion-safe:` gate (no transition set → the
// card simply appears). The card is pure framing; the reused ConversationPane
// fills it and carries its own header (avatar + name + status chip) and the
// minimize control (its `onCollapse`), so there is exactly one header and one
// collapse affordance.
function ExpandedCard({ name, children }: { name: string; children: ReactNode }) {
  const [entered, setEntered] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // The collapsed bubble button unmounts as this card mounts, so move focus
    // into the card (PTY runs then hand it on to the auto-focusing terminal).
    cardRef.current?.focus()
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      role="dialog"
      aria-label={`${name} conversation`}
      className={`
        absolute bottom-5 right-5 z-[var(--z-float)] flex h-[480px] max-h-[calc(100%-2.5rem)] w-[380px]
        max-w-[calc(100%-2.5rem)] flex-col overflow-hidden rounded-[var(--radius-md)] border
        border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] p-3
        shadow-[var(--shadow-drawer)]
        motion-safe:transition motion-safe:duration-150
        ${entered ? 'opacity-100 motion-safe:translate-y-0' : 'opacity-0 motion-safe:translate-y-1'}
      `}
    >
      {children}
    </div>
  )
}
