import React, { useEffect, useMemo, useRef, useState } from 'react'

import type { DesignSystemLibraryEntry } from '../../../../shared/design-system/library'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { FOCUS_RING_CLASS } from '../ui/tokens'
import { ExtensionsGlyph } from '../workspace/AppRail'
import { useExtensionsDrawerRows } from '../workspace/extensionsDrawerRows'
import { GlobalSurfaceShell } from '../workspace/globalSurface/GlobalSurfaceShell'
import { useSurfaceBackNav } from '../workspace/globalSurface/surfaceBackNav'
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
// **The body is the drawer, said again as five tiles** (Stage 3). Same five
// destinations, same order, same click — the tiles and the drawer rows are
// resolved by ONE function (`extensionsDrawerRows.ts`), so a tile cannot open
// something its row does not. What the tiles add over the column is what a
// column has no room for: a sentence saying what each part is for, and a live
// count saying how much of it you have.
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

export default function ExtensionsHomeSurface(): JSX.Element {
  const back = useSurfaceBackNav()
  // No nav entries handed in: this page is not the sidebar, so the rows resolve
  // against the host's own enablement-filtered list. A row whose module is off
  // is absent here exactly as it is in the drawer.
  const rows = useExtensionsDrawerRows()
  const counts = useExtensionsHomeCounts()

  return (
    <GlobalSurfaceShell
      ariaLabel="Extensions"
      // The door's name rides the app's one top strip, where the workspace name
      // would be — a surface owns its whole region including its top row.
      bar={{ title: 'Extensions' }}
      onBack={back.onBack}
      canGoBack={back.canGoBack}
    >
      <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto px-5 py-4">
        {/* No heading over the tiles, and no name on the list: a heading
            separates something from something else, and these ARE the page
            (principles, Composition) — the door region is already called
            "Extensions", so a list labelled the same would be read twice.

            `auto-fit` rather than a fixed five columns, because the card region
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
        <section aria-labelledby="extensions-community-heading" className="space-y-2">
          <div className="flex items-baseline gap-2.5">
            <h2
              id="extensions-community-heading"
              className="text-heading font-semibold text-[color:var(--text-strong)]"
            >
              Community
            </h2>
            <Badge tone="neutral">Coming soon</Badge>
          </div>
          <EmptyState
            density="list"
            glyph={<ExtensionsGlyph className="icon-lg" />}
            title="Extensions built by the community"
            body="A browse of modules other people have published, with search and one-click install, will be listed here once the registry scan lands."
          />
        </section>
      </div>
    </GlobalSurfaceShell>
  )
}
