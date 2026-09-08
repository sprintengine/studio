import { useCallback, useMemo } from 'react'

import { RowButton } from '../ui'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { buildAgentCliCatalog, installableCliSummary } from './newWorkspace/cliRuntimeOptions'

// The app's one CLI install surface: Settings → Agents, the same ProviderRow
// install rows the first-run card shows. Every "there is no agent CLI here"
// state routes through this module — the empty launcher, the agent pickers and
// the first-run card all end up in the same place, so a user who lands on any
// of them installs from the same list (MC-2093).
//
// **Extensions → Agent CLIs does not change that** (decided 2026-09-06,
// backlog/2026-09-06-the-seams-that-lead-nowhere.md §3). The Extensions door
// grew a CLI view, and for a while the card path pointed at it: the seeded hero
// card's `open.surface` opened it, and the executor's `require.cli` refusal told
// people to install from there — while `CliInstallRosterRow`, rendered by that
// same card's Go picker, opened Settings → Agents. Two doors from one surface is
// exactly what MC-2093 was written to stop, so the card path was moved onto this
// one and not the other way round. The reason it went this way rather than that
// is that a card cannot name Settings: `open.surface` speaks only the Extensions
// views (CardSurfaceView in src/shared/hosted-card-feed.ts), so making the
// Extensions view canonical would have meant the pickers and the launcher
// leaving this module while WorkspaceManager's two rescues stayed — a third
// state, not one fewer.
//
// So: Extensions → Agent CLIs is a catalogue you browse, and this is the answer
// to "you have none". A card that needs a CLI says so with `require.cli` and
// lets the Go picker offer `CliInstallRosterRow`; it does not build a door of
// its own.
export const AGENTS_SETTINGS_TAB = 'agents'

function useOpenCliInstall(): () => void {
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)
  return useCallback(() => {
    openSettingsOverlay({ initialTab: AGENTS_SETTINGS_TAB })
  }, [openSettingsOverlay])
}

function useInstallableCliSummary(): string {
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  return useMemo(
    // The unfiltered registry catalog: what can be installed, not what is.
    () => installableCliSummary(buildAgentCliCatalog(pluginCatalogEntries).map((option) => option.label)),
    [pluginCatalogEntries],
  )
}

// The same trailing chevron the launcher's live rows carry, so the install
// route reads as one of them rather than a differently-drawn special case.
function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CliInstallIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2.5v8m0 0L5 7.5M8 10.5l3-3M3 13h10"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// The launcher's zero-CLI call to action: the one thing that works on this
// machine, so it carries the accent the CLI grid it replaces never needed.
export function CliInstallCta() {
  const openInstall = useOpenCliInstall()
  const summary = useInstallableCliSummary()
  return (
    // The kit's row: a full-width, left-aligned control whose CHILDREN are the
    // layout — a glyph, two lines and a trailing chevron. `row` is the inset
    // density, since the call to action sits inside a padded empty state
    // rather than reaching its container's edges.
    <RowButton density="row" onClick={openInstall} className="mt-5">
      <CliInstallIcon className="size-icon-md shrink-0 text-[color:var(--accent-primary)]" />
      <span className="min-w-0">
        <span className="block text-body font-semibold text-[color:var(--text-strong)]">
          Install an agent CLI
        </span>
        {summary ? (
          <span className="mt-0.5 block truncate text-meta text-[color:var(--text-muted)]">{summary}</span>
        ) : null}
      </span>
      <ChevronRightIcon className="ml-auto h-4 w-4 shrink-0 text-[color:var(--text-subtle)]" />
    </RowButton>
  )
}

// The same route as a picker roster row: on a machine with no agent CLI it is
// the only row a picker can honestly offer.
export function CliInstallRosterRow({ onNavigate }: { onNavigate?: () => void }) {
  const openInstall = useOpenCliInstall()
  return (
    // `bleed`: the row reaches the picker list's own edges, so it draws no
    // radius and takes the inset focus ring an edge-touching row needs.
    <RowButton
      density="bleed"
      onClick={() => {
        openInstall()
        onNavigate?.()
      }}
      className="pl-2.5 text-body"
    >
      <CliInstallIcon className="icon-sm shrink-0 text-[color:var(--accent-primary)]" />
      Install an agent CLI
      <ChevronRightIcon className="ml-auto h-3.5 w-3.5 shrink-0 text-[color:var(--text-subtle)]" />
    </RowButton>
  )
}
