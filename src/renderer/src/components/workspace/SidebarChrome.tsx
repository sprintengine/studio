// The sidebar's own top chrome — the left half of the split top chrome. It runs
// to the very top of the window (the full-height sidebar desktop editors use), so the
// window's leftmost controls live here rather than in a full-width title bar.
//
// ONE 36px row (owner, 2026-07-30: one chrome row per content region). Window
// affordances and product affordances share it rather than stacking into two
// bands — the two-row version read as the mark sitting *below* the top bar
// instead of in it:
//
//   [traffic-light reserve | app-menu] sprintengine ··· back forward search collapse
//
// The row is an `app-drag` region; every interactive control opts back out with
// `app-no-drag`. On macOS its leftmost slice is reserved for the native traffic
// lights inset by the hiddenInset frame (window-factory.ts); the reserve
// collapses in fullscreen where the lights are hidden. The right-side window
// controls (min/max/close) are NOT here on win/linux — they pin to the window's
// top-right corner over the content, since the aside can own that corner.
//
// Because one row has to hold both, width is contended: below the width that
// fits the mark it is the mark that drops (a `@container` query on the row, see
// `wordmarkVisibility`), never one of the four controls.
//
// This row is chrome, not rail content (item 1991): WorkspaceSidebar mounts it
// above both the workspaces rail and a door's context rail, and outside the
// tree's scroll container — so a drill-in that swaps the rail underneath leaves
// the row untouched, and the row never scrolls away. Collapsed, the whole
// sidebar is hidden and the expand control moves to WorkspaceHeader's launcher;
// there is no wordmark and no glyph standing in for it there.

import React from 'react'
import SprintEngineWordmark from '../brand/SprintEngineWordmark'
import { IconButton, Popover, Tooltip } from '../ui'
import { MENU_ITEM_CLASS, MENU_LIST_CLASS } from '../ui/menuClasses'
import { FOCUS_RING_CLASS } from '../ui/tokens'
import { APP_RAIL_WIDTH, TRAFFIC_LIGHT_RESERVE } from './AppRail'

// The row's icon buttons. `control-xs` is the system's icon-button step
// (principles.md, "Space and size"), and with four of them sharing the row with
// the wordmark it is also the only step that fits.
//
// The ink lives on the two variants, never layered over a shared default: two
// `text-[color:…]` utilities on one element are resolved by Tailwind's own
// stylesheet order, not by the order they appear in the attribute, so appending
// `text-strong` to a base that already says `text-subtle` silently loses. The
// base therefore sets no colour at all.
//
// The focus ring is spelled as the literal utility, FIRST, on each variant rather than once on the base: the
// conformance guard reads a template literal from its first literal chunk, so a ring behind an interpolation or two template
// levels deep read as missing to it, and a guard that cannot see the ring is a
// guard that will not notice when it goes.
const BRAND_ROW_BUTTON_BASE =
  'app-no-drag interactive inline-flex size-control-xs items-center justify-center rounded-md bg-transparent transition-colors hover:bg-[color:var(--bg-hover)]'
const BRAND_ROW_BUTTON = `focus-visible:focus-ring ${BRAND_ROW_BUTTON_BASE} text-[color:var(--text-subtle)] hover:text-[color:var(--text-default)]`
// For a control whose panel is open: strong at rest and on hover, so hovering
// the open state never reads as dimming it.
const BRAND_ROW_BUTTON_STRONG = `focus-visible:focus-ring ${BRAND_ROW_BUTTON_BASE} text-[color:var(--text-strong)]`

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
// panel — the sidebar — is open. This button only renders in the expanded chrome
// row, so it's always the open state here; the collapsed-state open button lives
// in WorkspaceHeader's launcher and stays muted. That is why it is the one glyph
// in the row brighter than its neighbours: the pair is a state contrast read
// across the two states, not decoration.
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
// `visibility` is a container query, not a prop: the sidebar is drag-resized, so
// the mark has to appear and disappear as the column crosses the width that fits
// it — continuously, without a re-render per pointer-move.
function BrandButton({ onNewChat, visibility }: { onNewChat: () => void; visibility: string }) {
  return (
    <Tooltip content="New chat" placement="bottom">
      <button
        type="button"
        onClick={onNewChat}
        aria-label="New chat"
        className={`app-no-drag interactive h-control-xs items-center rounded-md bg-transparent px-2 transition-colors hover:bg-[color:var(--bg-hover)] ${FOCUS_RING_CLASS} ${visibility}`}
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
      <button type="button" onClick={onClick} aria-label={label} className={BRAND_ROW_BUTTON}>
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
      surfaceClassName={`w-44 ${MENU_LIST_CLASS}`}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <Tooltip content="Menu" placement="bottom">
          {/* The kit's icon button at `md` (size.control.sm): the neutral ghost
              tone IS this control's ink pair (--text-muted, lifting to
              --bg-hover + --text-strong), and rounded-sm and rounded-md are the
              same 7px step today. It also arrives with the focus ring this
              hand-rolled trigger never drew — the one thing that made it
              unreachable to say where it was from the keyboard. */}
          <IconButton
            ref={ref}
            size="md"
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
          // The same rows AppTitleBar's fallback draws, and they were the same
          // hand-roll — at `text-heading` here and `text-body` there, which is
          // how one menu came in two sizes (MC-2103).
          className={`${MENU_ITEM_CLASS} text-[color:var(--text-default)] hover:text-[color:var(--text-strong)]`}
        >
          {label}
        </button>
      ))}
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
  //
  // The app rail stands between this column and the window's left edge
  // (app shell, 2026-09-05), and the native macOS traffic lights start
  // in its top reserve — but the rail is a glyph column now, narrower than the
  // lights' 78px span, so the remainder of that span is this row's leading
  // inset. In fullscreen the lights are hidden and the inset collapses.
  const trafficLightInset = isMac && !isFullScreen ? TRAFFIC_LIGHT_RESERVE - APP_RAIL_WIDTH : 0

  // The width at which the wordmark still fits beside everything the row must
  // keep. Below it the mark drops out and the four controls stay — the sidebar is
  // drag-resizable down to SIDEBAR_MIN_WIDTH (200), and one row cannot hold all
  // five at that width.
  //
  // The row is: [leading] + mark 100 + (4 × 26 controls + 3 × 2 gaps + 8 pad) 118.
  // Leading is the 34px app-menu cluster on win/linux (4 pad + 30 button), the
  // 22px traffic-light remainder on macOS (78 − the 56px rail), or nothing on
  // macOS in fullscreen.
  //
  // Literal class strings, never interpolated: Tailwind generates a container
  // query only from a variant it can see in the source text.
  const wordmarkVisibility = trafficLightInset > 0
    ? 'hidden @[240px]:inline-flex' // 22 + 100 + 118
    : isMac
      ? 'hidden @[218px]:inline-flex' // 0 + 100 + 118
      : 'hidden @[252px]:inline-flex' // 34 + 100 + 118

  return (
    // ONE row (owner, 2026-07-30): one chrome row per content region. Height-
    // locked to WorkspaceHeader's 36px so the two halves of the split chrome meet
    // at the same line across the column seam, and no divider under it — the rail
    // below owns the single "the list starts here" rule (principles.md,
    // Composition).
    //
    // `@container` so the wordmark can drop out below the width that fits it
    // (owner, 2026-07-30: at narrow widths the mark is the thing to lose, not a
    // control). The four icon buttons are the row's floor — they are the
    // functional controls and never drop.
    <div className="@container app-drag flex h-[36px] shrink-0 items-center">
      {trafficLightInset > 0 ? <div aria-hidden="true" className="shrink-0" style={{ width: trafficLightInset }} /> : null}
      {!isMac ? (
        <div className="flex shrink-0 items-center pl-1">
          <AppMenuButton menuItems={menuItems} onShowMenu={onShowMenu} />
        </div>
      ) : null}
      <BrandButton onNewChat={onNewChat} visibility={wordmarkVisibility} />
      {/* Every control at the `control-xs` step, not the labelled-control step:
          four icon buttons plus the wordmark plus the reserve is what the row has
          to hold, and the wider step does not fit beside the mark. */}
      <div className="ml-auto flex shrink-0 items-center gap-0.5 pr-2">
        <NavHistoryButton direction="back" onClick={onNavigateBack} />
        <NavHistoryButton direction="forward" onClick={onNavigateForward} />
        <SearchButton onOpen={onOpenSearch} />
        <CollapseButton onToggle={onToggleSidebar} />
      </div>
    </div>
  )
}
