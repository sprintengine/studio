import React from 'react'

import type { SidebarSection } from '../../store/slices/settingsSlice'
import { FOCUS_RING_CLASS } from '../ui/tokens'
import { TITLE_BAR_HEIGHT } from './AppTitleBar'

// The app rail (app shell, 2026-09-05): the narrow column of big glyphs
// at the window's far left that decides what the sidebar column beside it
// shows. Desktop apps commonly put this rail outside the sidebar rather than
// inside it — the rail names AREAS of the product (Home, Extensions), the
// sidebar lists the THINGS inside the chosen area, and the two never share a
// column. That is what let the top-nav door band leave the workspaces sidebar:
// Sprints, Reviews, Automations and their kin live under the Extensions glyph
// now, and Home is only New chat plus the tree.
//
// This is window chrome, not a rail in the context-rail sense
// (`design-system/patterns/context-rail.html`, "one rail, ever"). That ruling is
// about NAVIGATION columns — a list a person walks — and it still holds for the
// sidebar column: a door's rail replaces the sidebar's content, never sits
// beside it. The app rail holds no list. It is a fixed set of section glyphs,
// the way the title strip is a fixed set of window controls, and it stays put
// while everything to its right swaps.
//
// Geometry. The rail is a layout measure like SIDEBAR_DEFAULT_WIDTH, not a
// token: wide enough for a glyph square and its caption, and on macOS wide
// enough to hold the native traffic lights, which the hiddenInset frame pins at
// x:12 (window-factory.ts) — three 12px lights ending at 64px. The rail's top
// reserves the title strip's height on every platform so its first glyph sits
// below the chrome row beside it, and on macOS that reserve is also where the
// lights land, which is why the sidebar's own chrome row no longer insets for
// them.
export const APP_RAIL_WIDTH = 76

type AppRailItem = {
  section: SidebarSection
  label: string
  Glyph: (props: { className?: string }) => JSX.Element
}

// A house: the workspaces tree, where every chat lives.
function HomeGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M2.5 7.6 8 3l5.5 4.6V13a.5.5 0 0 1-.5.5H9.6V10H6.4v3.5H3a.5.5 0 0 1-.5-.5V7.6Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Four tiles identify additions to the product beyond chat, drawn in the
// icon family's 16-box round-stroke idiom.
function ExtensionsGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2.5" y="2.5" width="4.6" height="4.6" rx="1.1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="8.9" y="2.5" width="4.6" height="4.6" rx="1.1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2.5" y="8.9" width="4.6" height="4.6" rx="1.1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="8.9" y="8.9" width="4.6" height="4.6" rx="1.1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

const RAIL_ITEMS: readonly AppRailItem[] = [
  { section: 'home', label: 'Home', Glyph: HomeGlyph },
  { section: 'extensions', label: 'Extensions', Glyph: ExtensionsGlyph },
]

type AppRailProps = {
  section: SidebarSection
  onSelectSection: (section: SidebarSection) => void
  // The account + Settings cluster stays at the rail's foot across sections.
  // Owned by the host; the rail only places it.
  accountSlot?: React.ReactNode
}

// One rail item: a glyph on a control-md square with its caption beneath.
// Selection is the neutral `bg-selected` fill on the square and an ink lift on
// the caption — never the accent (principles, "Selection is neutral"). The
// caption is always visible: a rail this narrow has no room for the label
// beside the glyph, and a tooltip-only label makes a person hover every glyph
// to learn the product.
function AppRailButton({
  item,
  active,
  onSelect,
}: {
  item: AppRailItem
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'page' : undefined}
      className={`app-no-drag group/rail flex w-full flex-col items-center gap-0.5 rounded-md py-1 text-micro font-medium leading-none ${FOCUS_RING_CLASS} ${
        active
          ? 'text-[color:var(--text-strong)]'
          : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-strong)]'
      }`}
    >
      <span
        className={`flex size-control-md items-center justify-center rounded-md transition-colors ${
          active
            ? 'bg-[color:var(--bg-selected)]'
            : 'group-hover/rail:bg-[color:var(--bg-hover)]'
        }`}
      >
        <item.Glyph className="size-icon-md" />
      </span>
      <span>{item.label}</span>
    </button>
  )
}

export function AppRail({ section, onSelectSection, accountSlot }: AppRailProps) {
  return (
    <nav
      aria-label="App rail"
      style={{ width: APP_RAIL_WIDTH }}
      // The whole column is a drag region — it is window chrome — and each
      // control opts back out, exactly as the title strip does.
      className="app-drag flex shrink-0 flex-col items-stretch border-r border-[color:var(--border-subtle)] bg-[color:var(--bg-canvas)]"
    >
      {/* The title strip's height, reserved: the first glyph sits below the
          chrome row beside it, and on macOS the native traffic lights sit here. */}
      <div aria-hidden="true" className={`${TITLE_BAR_HEIGHT} shrink-0`} />
      <div className="flex flex-col gap-1 px-1.5 pt-1">
        {RAIL_ITEMS.map((item) => (
          <AppRailButton
            key={item.section}
            item={item}
            active={section === item.section}
            onSelect={() => onSelectSection(item.section)}
          />
        ))}
      </div>
      <div className="flex-1" />
      {accountSlot}
    </nav>
  )
}
