import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { StageLiveStatus } from '../stageReadiness'
import { screenSwitcherMode, type CanvasStudioNav } from './canvasStudioModel'
import { StudioToolbar } from './StudioToolbar'
import { ScreensDrawer } from './ScreensDrawer'
import { AgentBubble } from './AgentBubble'

// The canvas-first studio shell (MC-1510): the reviewed artifact fills the
// surface; chrome floats over it. One floating pill toolbar top-center, an
// optional screens drawer, and the agent as a floating bubble bottom-right —
// no fixed terminal pane. Replaces the three-pane StageStudioBody (that layout
// now lives only in git history; there is no runtime layout flag).
//
// Tab order follows the DOM: toolbar → canvas content → agent bubble (the
// annotate batch tray, T10, mounts between canvas and bubble). Escape closes
// the screens drawer or collapses the bubble, each returning focus to the
// control that opened it. Floating chrome uses the canonical --shadow-drawer
// elevation, never a full-viewport backdrop-filter (the repo scrim rule).

export type CanvasStudioAgent = {
  /** Specialist display name, e.g. "Frontend Designer". */
  name: string
  /** Live specialist status from the transport's own signal (MC-1503). */
  liveStatus?: StageLiveStatus
  /** Whether the stage's validated artifacts are ready. */
  ready?: boolean
  /** Renders the reused ConversationPane; `onCollapse` wires its minimize control. */
  renderConversation: (args: { onCollapse: () => void }) => ReactNode
}

type Props = {
  /** The pill's leading switcher (screens / documents / gallery / none). */
  nav: CanvasStudioNav
  agent: CanvasStudioAgent
  /** The reviewed artifact, rendered full-bleed on the canvas. */
  children: ReactNode
}

export function CanvasStudio({ nav, agent, children }: Props) {
  const [bubbleExpanded, setBubbleExpanded] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const bubbleButtonRef = useRef<HTMLButtonElement>(null)
  const screensButtonRef = useRef<HTMLButtonElement>(null)

  // Only the 7+ screens case has a drawer to open.
  const hasDrawer =
    nav.kind === 'screens' && screenSwitcherMode(nav.screens.length) === 'drawer'

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
    screensButtonRef.current?.focus()
  }, [])

  const collapseBubble = useCallback(() => {
    setBubbleExpanded(false)
    bubbleButtonRef.current?.focus()
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return
    if (drawerOpen) {
      event.stopPropagation()
      closeDrawer()
    } else if (bubbleExpanded) {
      event.stopPropagation()
      collapseBubble()
    }
  }

  return (
    <div
      onKeyDown={onKeyDown}
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[color:var(--bg-app)]"
    >
      <StudioToolbar
        nav={nav}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((open) => !open)}
        screensButtonRef={screensButtonRef}
      />

      {hasDrawer && drawerOpen && nav.kind === 'screens' ? (
        <ScreensDrawer
          screens={nav.screens}
          activeId={nav.activeId}
          onSelect={nav.onSelect}
          onClose={closeDrawer}
        />
      ) : null}

      {/* Canvas: the reviewed artifact fills the surface, inset to clear the
          floating pill above and give the bubble a resting corner. */}
      <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-8">{children}</div>

      <AgentBubble
        expanded={bubbleExpanded}
        onExpand={() => setBubbleExpanded(true)}
        onCollapse={collapseBubble}
        name={agent.name}
        liveStatus={agent.liveStatus}
        ready={agent.ready}
        renderConversation={agent.renderConversation}
        buttonRef={bubbleButtonRef}
      />
    </div>
  )
}
