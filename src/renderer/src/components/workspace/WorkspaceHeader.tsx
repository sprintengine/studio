// The workspace header — the right half of the split top chrome. It sits above
// the active workspace's content column (not spanning the sidebar), so the
// identity + controls read as belonging to the workspace rather than floating in
// one full-width bar. Left→right:
//
//   Files·Git·Backlog switches │ WorkspaceIdentity ····· WorkspaceActions · attention · sprints
//
// The strip is an `app-drag` region; interactive controls opt out. Non-mac window
// controls are NOT here — they pin to the window's absolute top-right corner
// (WorkspaceManager), since the Sprint Engines aside can own that corner.

import React from 'react'
import { Tooltip } from '../ui'
import { AttentionQueuePopover, type AttentionQueueSurface } from './AttentionQueuePopover'
import { PanelSwitches } from './PanelSwitches'
import { AppMenuButton } from './SidebarChrome'
import { TRAFFIC_LIGHT_INSET } from './AppTitleBar'
import type { WorkspaceId } from '../../types/workspace'

const STRIP_BUTTON =
  'app-no-drag interactive inline-flex h-7 w-7 items-center justify-center bg-transparent text-[color:var(--text-subtle)] transition-colors hover:text-[color:var(--text-default)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]'

type SprintEnginesToggle = {
  open: boolean
  onToggle: () => void
}

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
  onNewAgent: () => void
  menuItems: readonly MenuItem[]
  onShowMenu: (event: React.MouseEvent<HTMLButtonElement>, label: MenuItem) => void
  // The active workspace's identity cluster (WorkspaceIdentity) and control
  // groups (WorkspaceActions), filled by WorkspaceManager. Kept as ReactNode
  // slots so this header never threads the ~50 workspace/agent props they need.
  identitySlot: React.ReactNode
  actionsSlot: React.ReactNode
  attentionQueue: AttentionQueueSurface
  // Null when the sprint-engine module is disabled — the toggle hides entirely.
  sprintEnginesToggle: SprintEnginesToggle | null
  // Null outside dev/diagnostics builds.
  onOpenDiagnostics: (() => void) | null
}

function DiagnosticsButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip content="Performance diagnostics" placement="bottom">
      <button type="button" onClick={onOpen} aria-label="Open performance diagnostics" className={STRIP_BUTTON}>
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <path
            d="M1 8h3l2-4.5L9.5 13 12 8h3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </Tooltip>
  )
}

function SprintEnginesAsideToggle({ open, onToggle }: SprintEnginesToggle) {
  return (
    <Tooltip content="Sprints" placement="bottom">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={open}
        aria-label="Toggle Sprints"
        className={`app-no-drag interactive inline-flex h-7 w-7 items-center justify-center bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] ${
          open ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-subtle)] hover:text-[color:var(--text-default)]'
        }`}
      >
        {/* `panel-right` mirror of the sidebar's panel-left collapse glyph. */}
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 3V13" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
    </Tooltip>
  )
}

// Open-sidebar toggle for the collapsed launcher (panel-left glyph).
function OpenSidebarButton({ onToggle }: { onToggle: () => void }) {
  return (
    <Tooltip content="Open sidebar" placement="bottom">
      <button type="button" onClick={onToggle} aria-label="Open sidebar" aria-pressed={false} className={STRIP_BUTTON}>
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 3V13" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
    </Tooltip>
  )
}

function LauncherSearchButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip content="Search" placement="bottom">
      <button type="button" onClick={onOpen} aria-label="Search" className={STRIP_BUTTON}>
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </Tooltip>
  )
}

// New Agent "+" — the collapsed launcher's creation entry (Cursor keeps this when
// the sidebar is hidden), opening the same New Agent flow as the sidebar row.
function NewAgentButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip content="New Agent" placement="bottom">
      <button type="button" onClick={onClick} aria-label="New Agent" className={STRIP_BUTTON}>
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <path d="M8 3.5V12.5M3.5 8H12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
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
  onNewAgent,
  menuItems,
  onShowMenu,
  identitySlot,
  actionsSlot,
  attentionQueue,
  sprintEnginesToggle,
  onOpenDiagnostics,
}: WorkspaceHeaderProps<MenuItem>) {
  // With the sidebar hidden, the window's top-left is this header — so the
  // traffic-light inset (mac) / app-menu (win-linux) and the open-sidebar /
  // search / New Agent launcher relocate to the header's left.
  const reserveTrafficLights = sidebarCollapsed && isMac && !isFullScreen
  return (
    <div className="app-drag flex h-[36px] shrink-0 items-center border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
      {reserveTrafficLights ? <div aria-hidden="true" className={TRAFFIC_LIGHT_INSET} /> : null}
      {/* Left: (collapsed) window launcher, then panel switches + identity. */}
      <div className="flex min-w-0 flex-1 items-center">
        {sidebarCollapsed ? (
          <div className="flex shrink-0 items-center gap-0.5 pl-1.5">
            {!isMac ? <AppMenuButton menuItems={menuItems} onShowMenu={onShowMenu} /> : null}
            <OpenSidebarButton onToggle={onToggleSidebar} />
            <LauncherSearchButton onOpen={onOpenSearch} />
            <NewAgentButton onClick={onNewAgent} />
          </div>
        ) : null}
        <div className={`flex shrink-0 items-center gap-0.5 ${sidebarCollapsed ? '' : 'pl-1.5'}`}>
          <PanelSwitches activeWorkspaceId={activeWorkspaceId} leadingDivider={sidebarCollapsed} />
        </div>
        <div className="flex min-w-0 items-center pl-1.5 pr-2">{identitySlot}</div>
      </div>

      {/* Right: workspace controls, then the cross-workspace surfaces. */}
      <div className="flex shrink-0 items-center">
        {actionsSlot}
        <div className="flex items-center gap-0.5 px-1.5">
          {onOpenDiagnostics ? <DiagnosticsButton onOpen={onOpenDiagnostics} /> : null}
          <AttentionQueuePopover {...attentionQueue} />
          {sprintEnginesToggle ? <SprintEnginesAsideToggle {...sprintEnginesToggle} /> : null}
        </div>
      </div>
    </div>
  )
}
