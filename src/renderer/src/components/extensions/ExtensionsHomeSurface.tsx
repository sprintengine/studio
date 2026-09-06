import React, { useEffect, useMemo, useRef, useState } from 'react'

import type { DesignSystemLibraryEntry } from '../../../../shared/design-system/library'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { InboxSearchInput } from '../ui/InboxSearchInput'
import { Skeleton } from '../ui/Skeleton'
import { FOCUS_RING_CLASS } from '../ui/tokens'
import { useExtensionsDrawerRows } from '../workspace/extensionsDrawerRows'
import { GlobalSurfaceShell } from '../workspace/globalSurface/GlobalSurfaceShell'
import { useSurfaceBackNav } from '../workspace/globalSurface/surfaceBackNav'
import { CardPoster } from '../workspace/globalSurface/extensions/home/CardPoster'
import { useSkillSources } from '../workspace/globalSurface/extensions/skills/useSkillSources'
import { skillsTotal } from '../workspace/globalSurface/extensions/skills/skillsSurfaceModel'
import { useSprintRunIndex } from '../workspace/globalSurface/sprints/useSprintRunIndex'
import type { SurfaceIconComponent } from '../../modules/renderer-host'
import {
  agentCliCountLine,
  designLibraryCountLine,
  EXTENSIONS_HOME_TILE_SUMMARIES,
  mcpServerCountLine,
  skillsCountLine,
  sprintRunCountLine,
} from './extensionsHomeTiles'
import { homeCardCount, homeCardGrid } from './homeCards'

// The Extensions home (the app rail's Extensions glyph, 2026-09-05): the page
// the glyph opens, in the card region, with the Extensions drawer standing
// beside it as the navigation.
//
// A DOOR, not a modal (Extensions drawer ruling, 2026-09-05, Stage 2). It was
// the `marketplace` modal for a few hours on the same day; the modal floated
// over the card region with a scrim, which put a dialog between the person and
// the drawer they had just used. Its id changed with its shape — `marketplace`
// named a browse that does not exist yet, `extensions-home` names the page.
//
// Core, like Settings: this is where the product's own parts are offered, so no
// module may gate it (renderer-host reserves the id; WorkspaceManager resolves
// it from the app itself).
//
// **The body is the card feed, and the tiles are the foot of the page**
// (2026-09-06, epic "Extensions opens on a home page", item 2468). The page's
// first body was the drawer said again as five tiles, and that answered *what
// is the studio made of* — which is a question nobody arrives with. The cards
// answer *what could I do*, which is the one they do. So the cards are the
// reason to be here and the tiles are the way off: a search field on the chrome
// row, the grid, then the five tiles under a quiet heading.
//
// The tiles themselves are untouched by that move. Same five destinations, same
// order, same click — the tiles and the drawer rows are still resolved by ONE
// function (`extensionsDrawerRows.ts`), so a tile cannot open something its row
// does not, and each still carries the sentence saying what that part is for
// and the live count saying how much of it you have.
//
// Three states, and the quiet one is the important one. Loading is a skeleton
// grid. A feed that yields no card this build can draw — no network on a fresh
// profile, or a feed of cards whose artwork ships in a later release — falls
// back to **the tiles alone, with no apology and no notice**: the page is
// simply the page it was yesterday (epic rulings R5 and R6 — no version gating,
// and the page never reports on its own network). The heading over the tiles
// goes with the cards for the same reason, because a heading separates
// something from something else and with no cards there is nothing to separate
// them from.
//
// The Community "coming soon" block that stood here went with that change. It
// promised a browse of extensions other people had published, and the card feed
// is that promise kept — a coming-soon placeholder under seven live cards from
// a hosted feed is the app contradicting itself, and Frame 1 of the mockup
// draws the page without it.
//
// What this page deliberately does NOT carry is the module list: module
// switches live in Settings → Modules, and having them here too put the same
// choice in two shapes on two surfaces (principles, Composition).

// The one glyph that is not a module's: a chevron saying the tile leads
// somewhere. Local because it is this page's own punctuation rather than a
// surface's identity, which is what surfaceGlyphs.tsx holds.
function TileChevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ExtensionsHomeTile({
  label,
  summary,
  count,
  Icon,
  onClick,
}: {
  label: string
  summary?: string
  count?: string | null
  Icon: SurfaceIconComponent
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      // One object, five times: the same edges, the same padding, the glyph in
      // the same corner, so the row of them reads as one control repeated
      // rather than five cards that happen to be adjacent. A hairline and the
      // raised surface do the containing — no shadow, because nothing in the
      // document flow takes one (principles, "Hairlines carry the structure").
      //
      // Full height with the count pushed to the foot, so the five count lines
      // sit on one line however many lines each summary takes. A tile whose
      // number floated up under a one-line summary while its neighbour's sat
      // lower would read as five different objects.
      //
      // The name is the accessible name and it is real text, so the tile needs
      // no aria-label; the glyph and the chevron are decorative and say so.
      className={`flex h-full flex-col rounded-sm border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 pb-2.5 pt-3 text-left transition-colors hover:bg-[color:var(--bg-hover)] ${FOCUS_RING_CLASS}`}
    >
      <span aria-hidden="true" className="mb-1.5 flex items-start justify-between">
        {/* Neutral ink, not the accent: five accented glyphs on one page would
            be a category code in the strongest colour the system has
            (principles, "The accent budget"). */}
        <span className="flex text-[color:var(--text-muted)]">
          <Icon className="icon-md" />
        </span>
        <span className="flex text-[color:var(--text-subtle)]">
          <TileChevron className="icon-sm" />
        </span>
      </span>
      <span className="text-body font-semibold text-[color:var(--text-strong)]">{label}</span>
      {summary ? (
        <span className="mt-0.5 text-meta text-[color:var(--text-muted)]">{summary}</span>
      ) : null}
      {/* A count that is not known yet is absent, never zero — the line simply
          is not there until the read lands. */}
      {count ? (
        <span className="mt-auto pt-2 text-micro tabular-nums text-[color:var(--text-subtle)]">
          {count}
        </span>
      ) : null}
    </button>
  )
}

/**
 * The count line under each tile, from the stores and readers that already hold
 * the numbers — never a second source of truth, so a tile and the surface it
 * opens cannot state different totals.
 *
 * Every read here is a mount read or a store subscription; nothing polls and
 * nothing re-fetches on render. Three of the five come free (MCP servers and
 * both CLI facts are in the workspace store, populated before any door opens);
 * the other two cost the same reads their own surface makes, once, on the way
 * in — which is the price of the page saying something true rather than
 * something decorative.
 */
function useExtensionsHomeCounts(): Readonly<Record<string, string | null>> {
  const sprintRuns = useSprintRunIndex()
  const mcpServers = useWorkspaceStore((s) => s.appSettings.mcp?.servers)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
  const cliVersionAdvisories = useWorkspaceStore((s) => s.cliVersionAdvisories)
  // App-level sources, so no workspace: `null` skips the per-workspace
  // installed read this page has no use for.
  //
  // It costs a source list and one scan read per source, on every open of this
  // page — deliberately, and documented rather than cached: the alternative is
  // a door-level cache that this page and the Extensions door would both write
  // to, and the tile would then be showing whatever the door last read rather
  // than what is there. The reads are the main process's own cached scans, so
  // they are IPC round-trips, not repository walks.
  const skills = useSkillSources(null)
  const designLibrary = useDesignSystemLibraryCount()

  return useMemo(() => {
    const runs = sprintRuns.runs
    const servers = Object.values(mcpServers ?? {})
    const installedClis = Object.values(cliAvailability ?? {}).filter((entry) => entry?.installed)
    const updates = Object.entries(cliVersionAdvisories ?? {}).filter(
      ([cli, advisory]) =>
        cliAvailability?.[cli as keyof typeof cliAvailability]?.installed &&
        advisory?.status === 'behind_latest' &&
        Boolean(advisory.latestVersion),
    )
    // The Skills total is the Skills surface's own derivation (skillsTotal),
    // not a second sum: the same fact derived twice is a pair of numbers that
    // eventually disagree.
    const skillTotals = skillsTotal(skills.sourcesLoad, skills.sources, skills.scans)
    return {
      sprints: sprintRunCountLine({
        ready: sprintRuns.loadState === 'ready',
        total: runs.length,
        running: runs.filter((run) => run.runtimeState === 'running').length,
      }),
      design: designLibraryCountLine(designLibrary),
      // Enabled servers, which is the number the Plugins surface's Installed
      // row states ("N active MCP servers") — the same count in two places has
      // to be the same count.
      plugins: mcpServerCountLine(servers.filter((server) => server?.enabled).length),
      skills: skillsCountLine({
        ready: skillTotals.ready,
        sourceCount: skillTotals.sourceCount,
        skillCount: skillTotals.skillCount,
      }),
      'agent-clis': agentCliCountLine({
        ready: cliAvailabilityStatus === 'ready',
        installed: installedClis.length,
        updates: updates.length,
      }),
    }
  }, [
    cliAvailability,
    cliAvailabilityStatus,
    cliVersionAdvisories,
    designLibrary,
    mcpServers,
    skills.scans,
    skills.sources,
    skills.sourcesLoad,
    sprintRuns.loadState,
    sprintRuns.runs,
  ])
}

/**
 * How many design systems the library holds. Read once, on mount: the library
 * is a registry file nothing in this window writes while the page is up, and
 * the Design door re-reads it for itself when it opens.
 */
function useDesignSystemLibraryCount(): { ready: boolean; count: number } {
  const [state, setState] = useState<{ ready: boolean; count: number }>({ ready: false, count: 0 })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    if (typeof window.api?.listDesignSystemLibrary !== 'function') return () => {}
    void window.api
      .listDesignSystemLibrary()
      .then((result: { entries: DesignSystemLibraryEntry[] }) => {
        if (!mounted.current) return
        setState({ ready: true, count: result.entries.length })
      })
      // A library that cannot be listed leaves the tile with no count line
      // rather than with a zero it did not measure.
      .catch(() => {})
    return () => {
      mounted.current = false
    }
  }, [])
  return state
}

/** The id the search field says it filters, and the grid it filters. */
const CARD_GRID_ID = 'extensions-home-cards'

/**
 * The grid, in one shape for every state that has cards in it.
 *
 * Two columns, and the breakpoint is the CARD REGION rather than the window: a
 * container query, because this page sits in whatever the sidebar and the
 * window leave it and a viewport breakpoint would put two half-width cards side
 * by side in a narrow region on a wide screen. It is the same reasoning the
 * tile row's `auto-fit` already follows, expressed exactly rather than
 * approximately — `auto-fit` cannot be told to stop at two, and three even
 * columns is the layout Frame 3 rejected (variant B: nothing ranked).
 *
 * The hero takes both columns. It is a 2.7:1 plate and nothing else on the page
 * is, which is the whole of what "hero" means here.
 */
function CardGrid({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div id={CARD_GRID_ID} className="@container">
      <div className="grid grid-cols-1 gap-5 @min-[46rem]:grid-cols-2">{children}</div>
    </div>
  )
}

/**
 * The loading state: the grid's own shape, drawn empty.
 *
 * A skeleton and not a spinner, because the page knows exactly what is coming —
 * a wide plate and a row of 16:9 ones — and a layout that appears at the size
 * it will be does not shift when the feed lands. Hidden from readers, like
 * every skeleton: there is nothing here to announce, and the cards will
 * announce themselves.
 *
 * Four followers rather than the feed's own count, because the count is the
 * thing not known yet. It is a placeholder for a grid, not a promise about how
 * many cards there are.
 */
function CardGridSkeleton(): JSX.Element {
  return (
    <CardGrid>
      <div className="@min-[46rem]:col-span-2">
        <Skeleton className="aspect-[2.7/1] max-h-[330px] w-full rounded-lg" />
      </div>
      {[0, 1, 2, 3].map((slot) => (
        <Skeleton key={slot} className="aspect-[16/9] w-full rounded-lg" />
      ))}
    </CardGrid>
  )
}

export default function ExtensionsHomeSurface(): JSX.Element {
  const back = useSurfaceBackNav()
  // No nav entries handed in: this page is not the sidebar, so the rows resolve
  // against the host's own enablement-filtered list. A row whose module is off
  // is absent here exactly as it is in the drawer.
  const rows = useExtensionsDrawerRows()
  const counts = useExtensionsHomeCounts()
  // The feed is read, never fetched, here. WorkspaceManager loads it once at
  // boot and subscribes to the main process's push, so a page that fetched on
  // mount would be a second reader of one file — and the one whose copy the
  // person sees would depend on which of them answered last.
  const cards = useWorkspaceStore((state) => state.cards)
  const cardFeedStatus = useWorkspaceStore((state) => state.cardFeedStatus)
  const [query, setQuery] = useState('')

  // What this build can draw at all, and what survives the search. The first is
  // what decides whether there is a card region; the second is what goes in it.
  const drawable = useMemo(() => homeCardCount(cards), [cards])
  const grid = useMemo(() => homeCardGrid(cards, query), [cards, query])
  const matched = (grid.hero ? 1 : 0) + grid.rest.length
  // Only a page with nothing to draw is loading — the slice says the same thing
  // on its own side, and a re-read behind cards that are already up must never
  // replace them with a skeleton.
  const loading = cardFeedStatus === 'loading' && drawable === 0
  const hasCardRegion = loading || drawable > 0

  // 2469 owns what Go does: it installs what the card names, points the CLI at
  // it, opens the chat and sends the prompt. Until then the button is drawn and
  // pressing it does nothing — a card that half-ran its actions would be worse
  // than a card that waits for the item that owns them.
  const onGo = () => {}

  return (
    <GlobalSurfaceShell
      ariaLabel="Extensions"
      // The door's name rides the app's one top strip, where the workspace name
      // would be — a surface owns its whole region including its top row.
      //
      // The search field rides it too, where every other door in this family
      // puts one (`catalogue/CatalogueSurface.tsx`), at the same width — a
      // field that changed size from door to door would read as a different
      // control. It is absent when there is nothing to search: a page that has
      // fallen back to its tiles offers no filter over cards it is not showing.
      bar={{
        title: 'Extensions',
        actions:
          drawable > 0 ? (
            <div className="w-[260px]">
              <InboxSearchInput
                value={query}
                onChange={setQuery}
                ariaLabel="Search the Extensions home"
                placeholder="Search"
                controlsId={CARD_GRID_ID}
              />
            </div>
          ) : undefined,
      }}
      onBack={back.onBack}
      canGoBack={back.canGoBack}
    >
      <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto px-5 py-4">
        {loading ? <CardGridSkeleton /> : null}
        {!loading && drawable > 0 ? (
          <CardGrid>
            {grid.hero ? (
              <div className="@min-[46rem]:col-span-2">
                <CardPoster card={grid.hero} shape="hero" onGo={onGo} />
              </div>
            ) : null}
            {grid.rest.map((card) => (
              <CardPoster key={card.slug} card={card} onGo={onGo} />
            ))}
          </CardGrid>
        ) : null}
        {/* A search that matches nothing gets an answer, and it is the one
            state on this page that says anything at all. It is not the notice
            R6 forbids — that rule is about the page apologising for its own
            network, and this is the app answering a question the person just
            asked. An empty grid under a field with text in it would read as a
            page that had broken. */}
        {!loading && drawable > 0 && matched === 0 ? (
          <p className="m-0 text-meta text-[color:var(--text-muted)]">
            No cards match this search.
          </p>
        ) : null}
        {/* The heading arrives with the cards and leaves with them. With cards
            above it, it is what turns the tiles from the page into the way off
            the page ("Or go straight to the parts", Frame 1); with no cards
            above it, the tiles ARE the page again and a heading would be the
            door's own name said twice (principles, Composition). */}
        <div className="space-y-2.5">
          {hasCardRegion ? (
            <div className="flex items-baseline gap-2.5">
              {/* h3, under the door's own h2 and beside the card titles: this
                  is a section of the page, not a peer of the page's name. */}
              <h3 className="m-0 text-meta font-semibold text-[color:var(--text-strong)]">
                Or go straight to the parts
              </h3>
              <p className="m-0 text-meta text-[color:var(--text-muted)]">
                The five things the studio is made of.
              </p>
            </div>
          ) : null}
          {/* `auto-fit` rather than a fixed five columns, because the card region
            is whatever the sidebar and the window leave it: five across at
            workbench width, fewer as it narrows, and never a tile squeezed
            below its own copy. */}
          <ul className="grid list-none grid-cols-[repeat(auto-fit,minmax(176px,1fr))] gap-2.5">
            {rows.map((row) =>
              row.label && row.Icon ? (
                <li key={row.key} className="flex flex-col">
                  <ExtensionsHomeTile
                    label={row.label}
                    summary={EXTENSIONS_HOME_TILE_SUMMARIES[row.viewId ?? row.surfaceId]}
                    count={counts[row.viewId ?? row.surfaceId]}
                    Icon={row.Icon}
                    onClick={row.open}
                  />
                </li>
              ) : null,
            )}
          </ul>
        </div>
      </div>
    </GlobalSurfaceShell>
  )
}
