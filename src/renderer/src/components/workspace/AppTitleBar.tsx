// The app-wide title strip across the top of the window. Cursor-parity chrome:
// a slim strip that carries window navigation on the left (sidebar-collapse
// toggle + workspace back/forward + the Files/Git/Backlog panel switches, the
// single nav toolbar) and app-level surface toggles on the right (global search
// + the Sprint Engines aside, the "secondary side bar" idiom).
// The whole strip is a drag region; only the control clusters opt back out with
// `app-no-drag`, and on macOS the leftmost slice is reserved for the native
// traffic lights inset by the hiddenInset window frame.
//
// The right edge is the home for app-level (cross-workspace) surface toggles —
// matching the common "secondary side bar" idiom: a global panel gets
// a global toggle here, distinct from the per-workspace panel switches (Files /
// Git / Backlog) that sit on the left with the window nav.

import React from 'react'
import { FOCUS_RING_CLASS, IconButton, Popover, Tooltip } from '../ui'
import { MENU_ITEM_CLASS, MENU_LIST_CLASS } from '../ui/menuClasses'
import { AttentionQueuePopover, type AttentionQueueSurface } from './AttentionQueuePopover'
import { PanelSwitches } from './PanelSwitches'
import { TitleBarFoldProvider, useMeasuredTitleBarFold } from './titleBarFold'
import { WindowControls } from './WindowControls'
import type { WorkspaceId } from '../../types/workspace'

// The native traffic lights are pinned at y:11 by the hiddenInset frame
// (window-factory.ts), so the strip stays 36px to keep them vertically
// centered; the slimming comes from dropping the brand, not the height.
// Exported so the aux-window strips (ExternalEditorWindow / DiffViewerWindow)
// share the exact height/inset instead of re-hardcoding the literals.
export const TITLE_BAR_HEIGHT = 'h-[36px]'

// macOS reserves the leftmost slice for the native traffic lights; pad the nav
// flow past them so nothing sits under the close/zoom buttons. Dropped when the
// window is fullscreen on macOS, where the lights are hidden.
export const TRAFFIC_LIGHT_INSET = 'pl-[78px]'

// The strip's icon buttons are the kit's `IconButton` (26px on the control ramp,
// radius, hover fill and the shared focus ring) with `app-no-drag` so they opt
// out of the title strip's drag region. The private 28px `STRIP_BUTTON` was
// the drift MC-2119 named and this retires (audit, icon-buttons-off-the-ramp).

type AppTitleBarProps<MenuItem extends string> = {
  isMac: boolean
  isMaximized: boolean
  // macOS fullscreen hides the native traffic lights, so their reserved gutter
  // must collapse — otherwise the merged strip carries 78px of dead inset.
  isFullScreen: boolean
  menuItems: readonly MenuItem[]
  onShowMenu: (event: React.MouseEvent<HTMLButtonElement>, label: MenuItem) => void
  // Sidebar-collapse toggle: the strip mirrors the workspace.sidebar.toggle
  // command so the collapse control leads the frame, as in most desktop editors.
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  // Window-scoped active workspace: the panel switches derive their active
  // accent + git badge from it (null while no workspace is active). Passed in
  // rather than read from the store because "active" is per-window.
  activeWorkspaceId: WorkspaceId | null
  // Workspace back/forward, wired to the workspaceNavigationHistory commands
  // (workspace.history.back / .forward) that mouse buttons and shortcuts share.
  onNavigateBack: () => void
  onNavigateForward: () => void
  // Global search: dispatches the command-palette open command.
  onOpenSearch: () => void
  // Cross-workspace "agents awaiting you" surface. Core shell chrome (no module
  // gate), so always present; WorkspaceManager owns its data + open state and the
  // title bar only places it — it adds no session/workspace subscription itself.
  attentionQueue: AttentionQueueSurface
  // Null outside dev/diagnostics builds — the performance panel is an
  // engineering tool, so its title-bar entry only exists when diagnostics are on.
  onOpenDiagnostics: (() => void) | null
  // The active workspace's identity cluster (WorkspaceIdentity), filled by
  // WorkspaceManager. Rides in the centre of the strip, immediately after the
  // window-nav cluster, and truncates as the window narrows.
  centerSlot: React.ReactNode
  // The active workspace's control groups (WorkspaceActions), filled by
  // WorkspaceManager. Sits at the head of the right cluster, ahead of the
  // app-level toggles. Both slots stay generic ReactNodes so AppTitleBar never
  // threads the ~50 workspace/agent props the merged controls need.
  rightClusterPrefix: React.ReactNode
}

function SidebarCollapseButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? 'Open sidebar' : 'Collapse sidebar'
  return (
    <Tooltip content={label} placement="bottom">
      <IconButton onClick={onToggle} aria-label={label} className="app-no-drag">
        {/* Standard `panel-left` sidebar glyph — the sole collapse toggle now
            that the rail's second one is gone; one glyph for both states. */}
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 3V13" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </IconButton>
    </Tooltip>
  )
}

function NavHistoryButton({ direction, onClick }: { direction: 'back' | 'forward'; onClick: () => void }) {
  const label = direction === 'back' ? 'Back' : 'Forward'
  return (
    <Tooltip content={label} placement="bottom">
      <IconButton onClick={onClick} aria-label={label} className="app-no-drag">
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <path
            d={direction === 'back' ? 'M10 3.5L5.5 8L10 12.5' : 'M6 3.5L10.5 8L6 12.5'}
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

function GlobalSearchButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip content="Search" placement="bottom">
      <IconButton onClick={onOpen} aria-label="Search" className="app-no-drag">
        {/* Magnifier glyph. */}
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </IconButton>
    </Tooltip>
  )
}

function DiagnosticsTitleBarButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip content="Performance diagnostics" placement="bottom">
      <IconButton onClick={onOpen} aria-label="Open performance diagnostics" className="app-no-drag">
        {/* Activity / pulse glyph. */}
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

// The win/linux menu bar. At >= 900px it renders the five top-level labels
// inline (File / Edit / … idiom); below 900px it collapses to a single hamburger
// that opens a popover of the same labels — the usual narrow-window
// idiom — so the menu bar can never over-subscribe the 800px minimum width and
// clip. Both variants are always in the DOM and CSS-toggled by the media query,
// and both call the same `onShowMenu(label)` that pops the native submenu, so
// every menu stays reachable with its behavior intact.
function WindowsMenuBar<MenuItem extends string>({
  menuItems,
  onShowMenu,
}: {
  menuItems: readonly MenuItem[]
  onShowMenu: (event: React.MouseEvent<HTMLButtonElement>, label: MenuItem) => void
}) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  return (
    <>
      <div className="hidden shrink-0 items-center gap-1 pl-1 min-[900px]:flex">
        {menuItems.map((label) => (
          <button
            key={label}
            type="button"
            onClick={(event) => onShowMenu(event, label)}
            className={`app-no-drag interactive inline-flex h-control-xs items-center rounded-sm px-2.5 text-meta text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex shrink-0 items-center pl-1 min-[900px]:hidden">
        <Popover
          open={menuOpen}
          onOpenChange={setMenuOpen}
          ariaLabel="Application menu"
          popupRole="menu"
          placement="bottom-start"
          surfaceClassName={`w-44 ${MENU_LIST_CLASS}`}
          renderTrigger={({ ref, triggerProps, togglePopover }) => (
            <Tooltip content="Menu" placement="bottom">
              <IconButton
                ref={ref}
                onClick={togglePopover}
                aria-label="Application menu"
                className="app-no-drag"
                {...triggerProps}
              >
                <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
                  <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </IconButton>
            </Tooltip>
          )}
        >
          {menuItems.map((label) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              onClick={(event) => {
                setMenuOpen(false)
                onShowMenu(event, label)
              }}
              // The in-app menubar fallback opens the SAME menus the native menu
              // bar does, so its rows are the shared menu row (MC-2103) rather
              // than a `text-body` lookalike with an inset fill.
              className={`${MENU_ITEM_CLASS} text-[color:var(--text-default)] hover:text-[color:var(--text-strong)]`}
            >
              {label}
            </button>
          ))}
        </Popover>
      </div>
    </>
  )
}

export function AppTitleBar<MenuItem extends string>({
  isMac,
  isMaximized,
  isFullScreen,
  menuItems,
  onShowMenu,
  sidebarCollapsed,
  onToggleSidebar,
  activeWorkspaceId,
  onNavigateBack,
  onNavigateForward,
  onOpenSearch,
  attentionQueue,
  onOpenDiagnostics,
  centerSlot,
  rightClusterPrefix,
}: AppTitleBarProps<MenuItem>) {
  // macOS keeps the traffic lights in the strip except in fullscreen, where
  // they vanish and the reserved gutter must collapse with them.
  const reserveTrafficLights = isMac && !isFullScreen
  // How much room the left+centre block actually has. The identity cluster reads
  // this to decide how much of itself to fold into its overflow menu — measured
  // here rather than off the window because THIS block is what narrows when the
  // sidebar opens, and the identity cluster is the only thing that can give.
  const [fold, foldRef] = useMeasuredTitleBarFold()
  return (
    <div
      className={`app-drag flex ${TITLE_BAR_HEIGHT} shrink-0 items-stretch border-b border-[color:var(--border-default)] bg-[color:var(--bg-title-strip)]`}
    >
      {/* Left + centre: window navigation then the workspace identity cluster.
          The block flex-grows so its unused tail is the strip's drag spacer;
          on macOS the traffic-light gutter leads. */}
      <div ref={foldRef} className="flex min-w-0 flex-1 items-center">
        {reserveTrafficLights ? <div aria-hidden="true" className={TRAFFIC_LIGHT_INSET} /> : null}
        <div className="flex shrink-0 items-center gap-0.5 px-1.5">
          <SidebarCollapseButton collapsed={sidebarCollapsed} onToggle={onToggleSidebar} />
          <NavHistoryButton direction="back" onClick={onNavigateBack} />
          <NavHistoryButton direction="forward" onClick={onNavigateForward} />
          <PanelSwitches activeWorkspaceId={activeWorkspaceId} />
        </div>
        {!isMac ? <WindowsMenuBar menuItems={menuItems} onShowMenu={onShowMenu} /> : null}
        {/* Workspace identity cluster (min-w-0 so it truncates before the
            right-side controls are reached). */}
        <div className="flex min-w-0 items-center pl-1 pr-2">
          <TitleBarFoldProvider fold={fold}>{centerSlot}</TitleBarFoldProvider>
        </div>
      </div>

      {/* Right: workspace controls, then global search + app-level surface
          toggles, then (win/linux) the window controls. */}
      <div className="flex shrink-0 items-center">
        {rightClusterPrefix}
        <div className="flex items-center gap-0.5 px-1.5">
          <GlobalSearchButton onOpen={onOpenSearch} />
          {onOpenDiagnostics ? <DiagnosticsTitleBarButton onOpen={onOpenDiagnostics} /> : null}
          <AttentionQueuePopover {...attentionQueue} />
        </div>
        {!isMac ? <WindowControls isMaximized={isMaximized} /> : null}
      </div>
    </div>
  )
}
