// The workspace header — the right half of the split top chrome. It sits above
// the active workspace's content column (not spanning the sidebar), so the
// identity + controls read as belonging to the workspace rather than floating in
// one full-width bar. Left→right:
//
//   Backlog switch │ WorkspaceIdentity ····· WorkspaceActions · diagnostics · attention · Skills
//
// The strip is an `app-drag` region; interactive controls opt out. Non-mac window
// controls are NOT here — they pin to the window's absolute top-right corner
// (WorkspaceManager), since the Sprint Engines aside can own that corner.

import React from 'react'
import { IconButton, Tooltip } from '../ui'
import { AttentionQueuePopover, type AttentionQueueSurface } from './AttentionQueuePopover'
import { PanelSwitches } from './PanelSwitches'
import { AppMenuButton } from './SidebarChrome'
import { TitleBarFoldProvider, useMeasuredTitleBarFold } from './titleBarFold'
import type { WorkspaceId } from '../../types/workspace'

type WorkspaceHeaderProps<MenuItem extends string> = {
  // Window-scoped active workspace — the panel switches derive their active
  // accent + git badge from it (null while no workspace is active).
  activeWorkspaceId: WorkspaceId | null
  // Collapsed-sidebar launcher: when the sidebar is hidden, the window's left
  // controls (traffic-light inset / app-menu on win-linux, open-sidebar, search,
  // and a New Agent "+") relocate here to the header's left so they stay at the
  // window's top-left corner (Cursor idiom).
  isMac: boolean
  isFullScreen: boolean
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  onOpenSearch: () => void
  onNewChat: () => void
  menuItems: readonly MenuItem[]
  onShowMenu: (event: React.MouseEvent<HTMLButtonElement>, label: MenuItem) => void
  // The active workspace's identity cluster (WorkspaceIdentity) and control
  // groups (WorkspaceActions), filled by WorkspaceManager. Kept as ReactNode
  // slots so this header never threads the ~50 workspace/agent props they need.
  identitySlot: React.ReactNode
  actionsSlot: React.ReactNode
  // True when a global "door" surface (Roadmap, Reviews, Automations) covers the
  // workspace card. The workspace-scoped left cluster (panel switches + identity)
  // is chrome for the active workspace — with the card hidden behind a full-page
  // door it has nothing to act on, so it's replaced by the surface's own bar,
  // which the surface portals into `surfaceBarSlotRef`. The right-side workspace
  // controls (Sessions, notifications, spawn) stay — they remain useful on a door.
  globalSurfaceActive: boolean
  // Destination for the active door surface's lifted bar (title · status · context
  // · actions). Filled only while `globalSurfaceActive`.
  surfaceBarSlotRef: React.Ref<HTMLDivElement>
  attentionQueue: AttentionQueueSurface
  // Null outside dev/diagnostics builds.
  onOpenDiagnostics: (() => void) | null
}

function DiagnosticsButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip content="Performance diagnostics" placement="bottom">
      <IconButton onClick={onOpen} aria-label="Open performance diagnostics" className="app-no-drag">
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <path
            d="M1 8h3l2-4.5L9.5 13 12 8h3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </IconButton>
    </Tooltip>
  )
}

// Open-sidebar toggle for the collapsed launcher (panel-left glyph).
function OpenSidebarButton({ onToggle }: { onToggle: () => void }) {
  return (
    <Tooltip content="Open sidebar" placement="bottom">
      <IconButton onClick={onToggle} aria-label="Open sidebar" aria-pressed={false} className="app-no-drag">
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 3V13" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </IconButton>
    </Tooltip>
  )
}

function LauncherSearchButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip content="Search" placement="bottom">
      <IconButton onClick={onOpen} aria-label="Search" className="app-no-drag">
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </IconButton>
    </Tooltip>
  )
}

// "New" + — the collapsed launcher's creation entry (Cursor keeps this when
// the sidebar is hidden), opening New chat exactly as the sidebar cluster does.
function NewChatButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip content="New chat" placement="bottom">
      <IconButton onClick={onClick} aria-label="New chat" className="app-no-drag">
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <path d="M8 3.5V12.5M3.5 8H12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </IconButton>
    </Tooltip>
  )
}

export function WorkspaceHeader<MenuItem extends string>({
  activeWorkspaceId,
  isMac,
  isFullScreen,
  sidebarCollapsed,
  onToggleSidebar,
  onOpenSearch,
  onNewChat,
  menuItems,
  onShowMenu,
  identitySlot,
  actionsSlot,
  globalSurfaceActive,
  surfaceBarSlotRef,
  attentionQueue,
  onOpenDiagnostics,
}: WorkspaceHeaderProps<MenuItem>) {
  // With the sidebar hidden, the app-menu (win-linux) and the open-sidebar /
  // search / New Agent launcher relocate to the header's left. No traffic-light
  // reserve any more (app shell, 2026-09-05): the app rail stays put
  // when the sidebar collapses, and the lights sit in its top reserve.
  void isFullScreen
  // How much room the left block actually has, so the identity cluster knows how
  // much of itself to fold into its overflow menu. Measured off THIS block
  // rather than the window: it is what narrows when the sidebar opens, and the
  // identity cluster is the only thing in the strip that can give.
  const [fold, foldRef] = useMeasuredTitleBarFold()
  return (
    <div className="app-drag flex h-[36px] shrink-0 items-center border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
      {/* Left: (collapsed) window launcher, then panel switches + identity. */}
      <div ref={foldRef} className="flex min-w-0 flex-1 items-center">
        {sidebarCollapsed ? (
          <div className="flex shrink-0 items-center gap-0.5 pl-1.5">
            {!isMac ? <AppMenuButton menuItems={menuItems} onShowMenu={onShowMenu} /> : null}
            <OpenSidebarButton onToggle={onToggleSidebar} />
            <LauncherSearchButton onOpen={onOpenSearch} />
            <NewChatButton onClick={onNewChat} />
          </div>
        ) : null}
        {/* Workspace-scoped left cluster — replaced by the door surface's own
            lifted bar while a global door owns the card region, since neither the
            panel switches nor the identity chips have a live workspace to act on
            there. The surface portals its bar into the slot div below. */}
        {globalSurfaceActive ? (
          // `pl-5` is the door gutter, not a nudge: the door's name sits on the
          // same 20px left edge as the content under it (the tab row, the canvas
          // body), so the title and the page it names share one vertical line.
          // At the panel-switch inset (6px) it read as hanging off the left edge
          // of its own page.
          <div
            ref={surfaceBarSlotRef}
            className="app-no-drag flex min-w-0 flex-1 items-center gap-2.5 pl-5 pr-2"
          />
        ) : (
          <>
            <div className={`flex shrink-0 items-center gap-0.5 ${sidebarCollapsed ? '' : 'pl-1.5'}`}>
              <PanelSwitches activeWorkspaceId={activeWorkspaceId} leadingDivider={sidebarCollapsed} />
            </div>
            <div className="flex min-w-0 items-center pl-1.5 pr-2">
              <TitleBarFoldProvider fold={fold}>{identitySlot}</TitleBarFoldProvider>
            </div>
          </>
        )}
      </div>

      {/* Right: workspace controls, then the cross-workspace surfaces. Skills
          renders outermost, past diagnostics and the attention cue — the mirror
          of the collapse control's outermost position on the left edge. The pane
          it opens does not slide in: animating a docked pane's width reflows the
          whole workspace card, terminals included, every frame (the call
          workspaceAsideColumn.tsx already made for this same column). */}
      <div className="flex shrink-0 items-center">
        {actionsSlot}
        <div
          role="toolbar"
          aria-label="Workspace surfaces"
          className="flex items-center gap-0.5 px-1.5"
        >
          {onOpenDiagnostics ? <DiagnosticsButton onOpen={onOpenDiagnostics} /> : null}
          <AttentionQueuePopover {...attentionQueue} />
          {/* Workspace-scoped, so it goes with the left cluster while a door
              paints over the card: diagnostics and the attention cue stay useful
              on a door, but toggling a pane in a layout nobody can see would be
              a control that visibly does nothing. */}
          {globalSurfaceActive ? null : (
            <PanelSwitches activeWorkspaceId={activeWorkspaceId} cluster="right" />
          )}
        </div>
      </div>
    </div>
  )
}
