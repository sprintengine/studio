// The sidebar's own top strip — the left half of the split top chrome. It runs
// to the very top of the window (the full-height sidebar desktop editors use), so the
// window's leftmost controls live here rather than in a full-width title bar:
//
//   macOS   : [native traffic lights] collapse · search ····· back/forward
//   win/lin : [app-menu hamburger]     collapse · search ····· back/forward
//
// The whole strip is an `app-drag` region; every interactive control opts back
// out with `app-no-drag`. On macOS the leftmost slice is reserved for the native
// traffic lights inset by the hiddenInset frame (window-factory.ts); the reserve
// collapses in fullscreen where the lights are hidden. The right-side window
// controls (min/max/close) are NOT here on win/linux — they pin to the window's
// top-right corner over the content, since the aside can own that corner.

import React from 'react'
import { Popover, Tooltip } from '../ui'
import { TRAFFIC_LIGHT_INSET } from './AppTitleBar'

// Same transparent-strip idiom as AppTitleBar's STRIP_BUTTON: no fill at rest or
// on hover, only a subtle→default ink shift, opts out of the drag region.
const STRIP_BUTTON =
  'app-no-drag interactive inline-flex h-7 w-7 items-center justify-center bg-transparent text-[color:var(--text-subtle)] transition-colors hover:text-[color:var(--text-default)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]'

type SidebarChromeProps<MenuItem extends string> = {
  isMac: boolean
  isFullScreen: boolean
  onToggleSidebar: () => void
  onNavigateBack: () => void
  onNavigateForward: () => void
  onOpenSearch: () => void
  // Win/linux only: the app menu, rendered as a single hamburger at all widths
  // (the inline File/Edit/… label bar is dropped here — the ~sidebar-width strip
  // has no room for it). macOS passes an empty list; those menus are the native
  // system menu bar.
  menuItems: readonly MenuItem[]
  onShowMenu: (event: React.MouseEvent<HTMLButtonElement>, label: MenuItem) => void
}

// Sidebar toggle. Mirrors the Sprints aside toggle: white (text-strong) while its
// panel — the sidebar — is open. This button only renders in the expanded strip,
// so it's always the open state here; the collapsed-state open button lives in
// WorkspaceHeader's launcher and stays muted.
function CollapseButton({ onToggle }: { onToggle: () => void }) {
  return (
    <Tooltip content="Collapse sidebar" placement="bottom">
      <button
        type="button"
        onClick={onToggle}
        aria-label="Collapse sidebar"
        aria-pressed={true}
        className="app-no-drag interactive inline-flex h-7 w-7 items-center justify-center bg-transparent text-[color:var(--text-strong)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
      >
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 3V13" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
    </Tooltip>
  )
}

function SearchButton({ onOpen }: { onOpen: () => void }) {
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

function NavHistoryButton({ direction, onClick }: { direction: 'back' | 'forward'; onClick: () => void }) {
  const label = direction === 'back' ? 'Back' : 'Forward'
  return (
    <Tooltip content={label} placement="bottom">
      <button type="button" onClick={onClick} aria-label={label} className={STRIP_BUTTON}>
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <path
            d={direction === 'back' ? 'M10 3.5L5.5 8L10 12.5' : 'M6 3.5L10.5 8L6 12.5'}
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

// The win/linux app menu, always a single hamburger here (no inline label bar).
// Exported so the collapsed-sidebar launcher (WorkspaceHeader) can host the same
// menu when the sidebar is hidden and this strip is gone.
export function AppMenuButton<MenuItem extends string>({
  menuItems,
  onShowMenu,
}: {
  menuItems: readonly MenuItem[]
  onShowMenu: (event: React.MouseEvent<HTMLButtonElement>, label: MenuItem) => void
}) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  return (
    <Popover
      open={menuOpen}
      onOpenChange={setMenuOpen}
      ariaLabel="Application menu"
      popupRole="menu"
      placement="bottom-start"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <Tooltip content="Menu" placement="bottom">
          <button
            ref={ref}
            type="button"
            onClick={togglePopover}
            aria-label="Application menu"
            className="app-no-drag inline-flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
            {...triggerProps}
          >
            <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
              <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </Tooltip>
      )}
    >
      <div className="w-44 p-1">
        {menuItems.map((label) => (
          <button
            key={label}
            type="button"
            role="menuitem"
            onClick={(event) => {
              setMenuOpen(false)
              onShowMenu(event, label)
            }}
            className="flex w-full items-center rounded px-2.5 py-1.5 text-left text-[13px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
          >
            {label}
          </button>
        ))}
      </div>
    </Popover>
  )
}

export function SidebarChrome<MenuItem extends string>({
  isMac,
  isFullScreen,
  onToggleSidebar,
  onNavigateBack,
  onNavigateForward,
  onOpenSearch,
  menuItems,
  onShowMenu,
}: SidebarChromeProps<MenuItem>) {
  // Only rendered while the sidebar is expanded (the whole sidebar is hidden when
  // collapsed — the collapsed launcher lives in WorkspaceHeader instead).
  const reserveTrafficLights = isMac && !isFullScreen

  return (
    <div className="app-drag flex h-[36px] shrink-0 items-center">
      {reserveTrafficLights ? <div aria-hidden="true" className={TRAFFIC_LIGHT_INSET} /> : null}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 pl-1.5">
        {!isMac ? <AppMenuButton menuItems={menuItems} onShowMenu={onShowMenu} /> : null}
        <CollapseButton onToggle={onToggleSidebar} />
        <SearchButton onOpen={onOpenSearch} />
      </div>
      <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
        <NavHistoryButton direction="back" onClick={onNavigateBack} />
        <NavHistoryButton direction="forward" onClick={onNavigateForward} />
      </div>
    </div>
  )
}
