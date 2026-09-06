import React from 'react'

import type { RegisteredGlobalSurface, SurfaceIconComponent } from '../../modules/renderer-host'
import type { SidebarSection } from '../../store/slices/settingsSlice'
import { FOCUS_RING_CLASS } from '../ui/tokens'
import { Tooltip } from '../ui/Tooltip'
import { TITLE_BAR_HEIGHT, TITLE_BAR_HEIGHT_PX } from './AppTitleBar'

// The app rail (app shell, 2026-09-05): the narrow column of glyphs at
// the window's far left that decides what the sidebar column beside it shows,
// and holds the product's standing tools. The rail sits outside the sidebar — the rail names AREAS of the
// product, the sidebar lists the THINGS inside the chosen area, and the two
// never share a column.
//
// Glyphs only (owner ruling, 2026-09-05, revising the captioned first cut): a
// house and a tile grid do not need the words "Home" and "Extensions" under
// them, and the caption was what made the rail 76px wide. One glyph column
// keeps the name on hover and in the accessible name — the same idiom the
// sidebar's collapsed rows already use.
//
// THREE glyphs, top to bottom (Extensions drawer ruling, 2026-09-05, revising
// the four-glyph cut of the same day):
//   Home        — the sidebar shows New chat and the workspaces tree.
//   Automations — the Automations surface takes the card region, with its own
//                 list of automations in the sidebar column beside it.
//   Extensions  — the sidebar becomes the Extensions drawer (Sprints, Design,
//                 Plugins, Skills, Agent CLIs) and the Extensions home takes
//                 the card region.
// Plugins left the rail: it is one of the five things UNDER Extensions, and a
// glyph of its own said it stood beside them. Automations stays because it is
// what the product does rather than something added to it — and it is still
// the automations module's own registered surface, glyph and label taken from
// the registry and gated on the module's enablement, so a disabled module's
// glyph is simply not there.
//
// This is window chrome, not a rail in the context-rail sense
// (`design-system/patterns/context-rail.html`, "one rail, ever"). That ruling is
// about NAVIGATION columns — a list a person walks — and it still holds for the
// sidebar column: a door's rail replaces the sidebar's content, never sits
// beside it. The app rail holds no list. It is a fixed set of glyphs, the way
// the title strip is a fixed set of window controls, and it stays put while
// everything to its right swaps.
//
// Geometry. The rail is a layout measure like SIDEBAR_DEFAULT_WIDTH, not a
// token: a `size.control.md` square plus a `space.xs` gutter each side, which
// is also the narrowest the collapsed account cluster at its foot fits in. Its
// top reserves the title strip's height on every platform so the first glyph
// sits below the chrome row beside it. On macOS the native traffic lights,
// which the hiddenInset frame pins at x:12 (window-factory.ts), start in that
// reserve and run past the rail's edge — the sidebar's chrome row insets for
// the remainder (SidebarChrome, TRAFFIC_LIGHT_RESERVE − APP_RAIL_WIDTH).
export const APP_RAIL_WIDTH = 46
// Where the three lights end, as AppTitleBar's own reserve measures it.
export const TRAFFIC_LIGHT_RESERVE = 78

// The registered surfaces that stand on the rail, in rail order. Ids, not
// modules. One of them today: the ruling promotes only Automations. The
// mechanism stays a LIST because what the rail holds is a ruling rather than a
// constant of the code — a second standing tool would join it here rather than
// be hand-placed in the JSX.
export const RAIL_SURFACE_IDS = ['automations'] as const

// A rail square needs a name and a glyph, and a door declares both optionally
// (Sprints names itself through its own nav-entry row instead). Narrowing here
// rather than at the call site keeps the rail from ever having to render a
// nameless square.
export type RailSurface = RegisteredGlobalSurface & { label: string; Icon: SurfaceIconComponent }

/** The rail's surfaces, picked from the host's enablement-filtered list and put in rail order. */
export function railSurfacesOf(surfaces: readonly RegisteredGlobalSurface[]): RailSurface[] {
  return RAIL_SURFACE_IDS.flatMap((id) => {
    const surface = surfaces.find((candidate) => candidate.id === id)
    return surface?.label && surface.Icon ? [surface as RailSurface] : []
  })
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
export function ExtensionsGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2.5" y="2.5" width="4.6" height="4.6" rx="1.1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="8.9" y="2.5" width="4.6" height="4.6" rx="1.1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2.5" y="8.9" width="4.6" height="4.6" rx="1.1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="8.9" y="8.9" width="4.6" height="4.6" rx="1.1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

type AppRailProps = {
  section: SidebarSection
  onSelectSection: (section: SidebarSection) => void
  // The module surfaces promoted onto the rail (railSurfacesOf), already
  // enablement-filtered by the host.
  surfaces: readonly RailSurface[]
  activeGlobalSurface: string | null
  onOpenSurface: (surface: RailSurface) => void
  // The account + Settings cluster stays at the rail's foot across sections.
  // Owned by the host; the rail only places it.
  accountSlot?: React.ReactNode
}

// One rail glyph on a control-md square, named by its tooltip and accessible
// name. Selection is the neutral `bg-selected` fill — never the accent, never a
// bar on the window's edge (principles, "Selection is neutral"). A section
// glyph is `aria-current` while its section shows; a surface glyph is
// `aria-pressed` while its surface holds the card region — the two can light
// together, and they say different things: which column, and what is in the
// region beside it.
function RailGlyph({
  label,
  active,
  current,
  onClick,
  children,
}: {
  label: string
  active: boolean
  current: 'section' | 'surface'
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip content={label} placement="right" wrapperClassName="flex">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-current={current === 'section' && active ? 'page' : undefined}
        aria-pressed={current === 'surface' ? active : undefined}
        className={`app-no-drag flex size-control-md items-center justify-center rounded-md transition-colors ${FOCUS_RING_CLASS} ${
          active
            ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
            : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
        }`}
      >
        {children}
      </button>
    </Tooltip>
  )
}

export function AppRail({ section, onSelectSection, surfaces, activeGlobalSurface, onOpenSurface, accountSlot }: AppRailProps) {
  return (
    <nav
      aria-label="App rail"
      style={{ width: APP_RAIL_WIDTH }}
      // The whole column is a drag region — it is window chrome — and each
      // control opts back out, exactly as the title strip does.
      className="app-drag relative flex shrink-0 flex-col items-stretch bg-[color:var(--bg-canvas)]"
    >
      {/* The title strip's height, reserved: the first glyph sits below the
          chrome row beside it, and on macOS the native traffic lights start here. */}
      <div aria-hidden="true" className={`${TITLE_BAR_HEIGHT} shrink-0`} />
      {/* The divider starts BELOW that reserve (owner, 2026-09-05), which is why
          it is a positioned hairline and not the nav's `border-r`. The macOS
          traffic lights are pinned at x:12 by the hiddenInset frame and their
          78px span runs past this 46px column, so a full-height edge drew a line
          straight through the green light. Below the title row the rail and the
          sidebar's chrome share one unbroken band, and the rule picks up where
          the window controls end. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 right-0 w-px bg-[color:var(--border-subtle)]"
        style={{ top: TITLE_BAR_HEIGHT_PX }}
      />
      <div className="flex flex-col items-center gap-1.5 px-1.5 pt-1">
        <RailGlyph label="Home" current="section" active={section === 'home'} onClick={() => onSelectSection('home')}>
          <HomeGlyph className="icon-md" />
        </RailGlyph>
        {surfaces.map((surface) => (
          <RailGlyph
            key={surface.id}
            label={surface.label}
            current="surface"
            active={activeGlobalSurface === surface.id}
            onClick={() => onOpenSurface(surface)}
          >
            <surface.Icon className="icon-md" />
          </RailGlyph>
        ))}
        <RailGlyph
          label="Extensions"
          current="section"
          active={section === 'extensions'}
          onClick={() => onSelectSection('extensions')}
        >
          <ExtensionsGlyph className="icon-md" />
        </RailGlyph>
      </div>
      <div className="flex-1" />
      {accountSlot}
    </nav>
  )
}
