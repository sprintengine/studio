// The sidebar's own top chrome — the left half of the split top chrome. It runs
// to the very top of the window (the full-height sidebar desktop editors use), so the
// window's leftmost controls live here rather than in a full-width title bar.
// Two rows, and the split is by owner rather than by taste: the first row
// belongs to the WINDOW, the second to the PRODUCT.
//
//   window : [native traffic lights | app-menu hamburger] ····· back/forward
//   brand  : sprintengine ································ search · collapse
//
// Both rows are `app-drag` regions; every interactive control opts back out with
// `app-no-drag`. On macOS the window row's leftmost slice is reserved for the
// native traffic lights inset by the hiddenInset frame (window-factory.ts); the
// reserve collapses in fullscreen where the lights are hidden. The right-side
// window controls (min/max/close) are NOT here on win/linux — they pin to the
// window's top-right corner over the content, since the aside can own that
// corner.
//
// The brand row is chrome, not rail content (item 1991): WorkspaceSidebar mounts
// this above both the workspaces rail and a door's context rail, and outside the
// tree's scroll container — so a drill-in that swaps the rail underneath leaves
// the row untouched, and the row never scrolls away. Collapsed, the whole
// sidebar is hidden and the expand control moves to WorkspaceHeader's launcher;
// there is no wordmark and no glyph standing in for it there.

import React from 'react'
import SprintEngineWordmark from '../brand/SprintEngineWordmark'
import { Popover, Tooltip } from '../ui'
import { FOCUS_RING_CLASS } from '../ui/tokens'
import { TRAFFIC_LIGHT_INSET } from './AppTitleBar'

// Same transparent-strip idiom as AppTitleBar's STRIP_BUTTON: no fill at rest or
// on hover, only a subtle→default ink shift, opts out of the drag region.
const STRIP_BUTTON = `app-no-drag interactive inline-flex size-control-sm items-center justify-center bg-transparent text-[color:var(--text-subtle)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`

// The brand row's own trailing controls. `control-xs` is the system's icon-button
// step (principles.md, "Space and size"), one notch under the window row's
// labelled-control step, so the two rows read as chrome of different weight
// rather than one 72px slab of buttons.
//
// The ink lives on the two variants, never layered over a shared default: two
// `text-[color:…]` utilities on one element are resolved by Tailwind's own
// stylesheet order, not by the order they appear in the attribute, so appending
// `text-strong` to a base that already says `text-subtle` silently loses. The
// base therefore sets no colour at all.
const BRAND_ROW_BUTTON_BASE = `app-no-drag interactive inline-flex size-control-xs items-center justify-center rounded-md bg-transparent transition-colors hover:bg-[color:var(--bg-hover)] ${FOCUS_RING_CLASS}`
const BRAND_ROW_BUTTON = `${BRAND_ROW_BUTTON_BASE} text-[color:var(--text-subtle)] hover:text-[color:var(--text-default)]`
// For a control whose panel is open: strong at rest and on hover, so hovering
// the open state never reads as dimming it.
const BRAND_ROW_BUTTON_STRONG = `${BRAND_ROW_BUTTON_BASE} text-[color:var(--text-strong)]`

type SidebarChromeProps<MenuItem extends string> = {
  isMac: boolean
  isFullScreen: boolean
  onToggleSidebar: () => void
  onNavigateBack: () => void
  onNavigateForward: () => void
  onOpenSearch: () => void
  onNewChat: () => void
  // Win/linux only: the app menu, rendered as a single hamburger at all widths
  // (the inline File/Edit/… label bar is dropped here — the ~sidebar-width strip
  // has no room for it). macOS passes an empty list; those menus are the native
  // system menu bar.
  menuItems: readonly MenuItem[]
  onShowMenu: (event: React.MouseEvent<HTMLButtonElement>, label: MenuItem) => void
}

// Sidebar toggle. Mirrors the Sprints aside toggle: white (text-strong) while its
// panel — the sidebar — is open. This button only renders in the expanded brand
// row, so it's always the open state here; the collapsed-state open button lives
// in WorkspaceHeader's launcher and stays muted.
function CollapseButton({ onToggle }: { onToggle: () => void }) {
  return (
    <Tooltip content="Collapse sidebar" placement="bottom">
      <button
        type="button"
        onClick={onToggle}
        aria-label="Collapse sidebar"
        aria-pressed={true}
        className={BRAND_ROW_BUTTON_STRONG}
      >
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 3V13" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
    </Tooltip>
  )
}

// Opens the command palette's search. The rail's own filter field is a different
// control with a different reach — it narrows the list below it and stays down
// there in the list anatomy.
function SearchButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip content="Search" placement="bottom">
      <button type="button" onClick={onOpen} aria-label="Search" className={BRAND_ROW_BUTTON}>
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </Tooltip>
  )
}

// The wordmark IS the New chat button — the row spends no width on a second
// control for the app's most common action, and the mark gets a reason to be
// clickable beyond decoration. Its accessible name is the action, not the brand:
// a screen-reader user needs to know what the control does, and the product name
// is not information they are missing.
//
// `px-2` inside the row's own `px-2` puts the first letterform at x=16 — the
// same left edge the rail rows below put their first glyph on, and the same edge
// their hover pill starts at. Measured, not eyeballed: at `px-1.5` the mark sat
// 4px inboard of the column's text edge and the left side read crooked.
function BrandButton({ onNewChat }: { onNewChat: () => void }) {
  return (
    <Tooltip content="New chat" placement="bottom">
      <button
        type="button"
        onClick={onNewChat}
        aria-label="New chat"
        className={`app-no-drag interactive inline-flex h-control-xs items-center rounded-md bg-transparent px-2 transition-colors hover:bg-[color:var(--bg-hover)] ${FOCUS_RING_CLASS}`}
      >
        <SprintEngineWordmark />
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
            className="app-no-drag inline-flex size-control-sm items-center justify-center rounded-md text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
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
            className="flex w-full items-center rounded px-2.5 py-1.5 text-left text-heading text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
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
  onNewChat,
  menuItems,
  onShowMenu,
}: SidebarChromeProps<MenuItem>) {
  // Only rendered while the sidebar is expanded (the whole sidebar is hidden when
  // collapsed — the collapsed launcher lives in WorkspaceHeader instead).
  const reserveTrafficLights = isMac && !isFullScreen

  return (
    <>
      {/* Window row. Height-locked to WorkspaceHeader's 36px so the two halves of
          the split chrome meet at the same line across the column seam. */}
      <div className="app-drag flex h-[36px] shrink-0 items-center">
        {reserveTrafficLights ? <div aria-hidden="true" className={TRAFFIC_LIGHT_INSET} /> : null}
        {!isMac ? (
          <div className="flex shrink-0 items-center pl-1.5">
            <AppMenuButton menuItems={menuItems} onShowMenu={onShowMenu} />
          </div>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5 pr-1.5">
          <NavHistoryButton direction="back" onClick={onNavigateBack} />
          <NavHistoryButton direction="forward" onClick={onNavigateForward} />
        </div>
      </div>
      {/* Brand row. No divider under it: the rail below already owns the one
          "the list starts here" rule (principles.md, Composition), and a second
          hairline 34px above it would only stripe the chrome.

          `px-2` matches the rail cluster's own `mx-2`, so the row's leading and
          trailing edges land on the column's text edges rather than 4px inboard
          and 2px outboard of them. */}
      <div className="app-drag flex shrink-0 items-center gap-0.5 px-2 py-1">
        <BrandButton onNewChat={onNewChat} />
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <SearchButton onOpen={onOpenSearch} />
          <CollapseButton onToggle={onToggleSidebar} />
        </div>
      </div>
    </>
  )
}
