import React, { useCallback, useMemo, useState } from 'react'

import { GhostButton, InlineNotice, OutlineButton, OverflowMenu, StatusDot } from '../ui'
import type { OverflowMenuItem } from '../ui'
import { SettingsSectionTitle } from './SettingsAtoms'
import { getExtensionsSurfaceHost } from '../workspace/globalSurface/extensions/extensionsSurfaceHost'
import { useConnectorSources } from '../panels/ConnectorsPanel/useConnectorSources'
import {
  partitionTicketTrackers,
  ticketTrackerStateLine,
  type TicketTrackerEntry,
} from './ticketTrackerConnectors'

// Settings → Ticket trackers (MC-2362, narrowed by MC-2363).
//
// Installing a tracker here installs its MCP, so an agent can read and update
// tickets during a run. That is the whole integration now: Multicode itself does
// not talk to trackers, because browsing tickets in an IDE competes with the
// tracker's own UI and loses.
//
// Everything here composes machinery that already exists: `useConnectorSources`
// reads the MCP catalogue, owns the installed set, and keeps the workspace
// `.mcp.json` in step. Membership comes from the catalogue's `ticketTracker`
// flag, so adding a fifth tracker never touches this file.

export function TicketTrackerSection({ workspaceRoot }: { workspaceRoot: string | null }): JSX.Element {
  const sources = useConnectorSources(workspaceRoot)
  const { catalogLoad, installedServerIds, toggleCatalogServer, loadCatalog } = sources
  const [busyId, setBusyId] = useState<string | null>(null)

  const servers = catalogLoad.status === 'ready' ? catalogLoad.data : []
  const bands = useMemo(
    () => partitionTicketTrackers(servers, installedServerIds),
    [servers, installedServerIds],
  )

  const toggle = useCallback(
    (id: string) => {
      const server = servers.find((entry) => entry.id === id)
      if (!server) return
      setBusyId(id)
      try {
        toggleCatalogServer(server)
      } finally {
        setBusyId(null)
      }
    },
    [servers, toggleCatalogServer],
  )

  // The two things a user wants next, routed through the host WorkspaceManager
  // already registers for the Extensions door — the same seam, so a terminal
  // started here is byte-identical to one started from Connectors. Both close
  // Settings on their way, which is why they are fire-and-forget.
  const startTerminal = useCallback(
    (entry: TicketTrackerEntry) => {
      getExtensionsSurfaceHost()?.onLaunchConnector({
        id: entry.id,
        name: entry.name,
        ...(entry.icon ? { icon: entry.icon } : {}),
      })
    },
    [],
  )
  const useInAutomation = useCallback((entry: TicketTrackerEntry) => {
    getExtensionsSurfaceHost()?.onUseInAutomation(entry.id)
  }, [])

  const total = bands.installed.length + bands.available.length

  return (
    <section className="space-y-3">
      <SettingsSectionTitle count={total || undefined}>Trackers</SettingsSectionTitle>
      <p className="max-w-[68ch] text-body leading-5 text-[color:var(--text-muted)]">
        Install a tracker to give your agents its tools — reading a ticket, leaving a comment, moving a status,
        during a run. Each one signs you in the first time an agent uses it; Multicode never holds the credential.
      </p>

      {catalogLoad.status === 'error' ? (
        <InlineNotice
          tone="error"
          title="Could not read the connector catalog."
          action={
            <GhostButton size="xs" onClick={() => void loadCatalog()}>
              Try again
            </GhostButton>
          }
        >
          {catalogLoad.message}
        </InlineNotice>
      ) : catalogLoad.status === 'loading' ? (
        <p className="py-3 text-body text-[color:var(--text-subtle)]">Loading ticket trackers…</p>
      ) : total === 0 ? (
        <p className="rounded-md border border-dashed border-[color:var(--border-subtle)] px-4 py-6 text-body text-[color:var(--text-subtle)]">
          No ticket trackers in the connector catalog.
        </p>
      ) : (
        <div className="space-y-4">
          <Band
            label="Installed"
            entries={bands.installed}
            emptyHint="None yet — install one below and your agents can work its tickets."
            busyId={busyId}
            onToggle={toggle}
            onStartTerminal={startTerminal}
            onUseInAutomation={useInAutomation}
          />
          <Band label="Available" entries={bands.available} busyId={busyId} onToggle={toggle} />
        </div>
      )}
    </section>
  )
}

function Band({
  label,
  entries,
  emptyHint,
  busyId,
  onToggle,
  onStartTerminal,
  onUseInAutomation,
}: {
  label: string
  entries: readonly TicketTrackerEntry[]
  emptyHint?: string
  busyId: string | null
  onToggle: (id: string) => void
  onStartTerminal?: (entry: TicketTrackerEntry) => void
  onUseInAutomation?: (entry: TicketTrackerEntry) => void
}): JSX.Element | null {
  if (entries.length === 0 && !emptyHint) return null
  return (
    <div className="space-y-1">
      {/* Sentence case, hierarchy from weight and size — the system rules out
          uppercase letter-spaced labels. */}
      <h4 className="text-meta font-semibold text-[color:var(--text-muted)]">{label}</h4>
      {entries.length === 0 ? (
        <p className="py-2 text-body text-[color:var(--text-subtle)]">{emptyHint}</p>
      ) : (
        <div>
          {entries.map((entry) => (
            <TrackerRow
              key={entry.id}
              entry={entry}
              busy={busyId === entry.id}
              onToggle={() => onToggle(entry.id)}
              {...(onStartTerminal ? { onStartTerminal: () => onStartTerminal(entry) } : {})}
              {...(onUseInAutomation ? { onUseInAutomation: () => onUseInAutomation(entry) } : {})}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function TrackerRow({
  entry,
  busy,
  onToggle,
  onStartTerminal,
  onUseInAutomation,
}: {
  entry: TicketTrackerEntry
  busy: boolean
  onToggle: () => void
  onStartTerminal?: () => void
  onUseInAutomation?: () => void
}): JSX.Element {
  const overflowItems: OverflowMenuItem[] = [
    ...(onUseInAutomation
      ? [{ id: 'use-in-automation', label: 'Use in an automation', onSelect: onUseInAutomation }]
      : []),
    { id: 'remove', label: 'Remove', onSelect: onToggle, disabled: busy, destructive: true },
  ]
  return (
    <div className="flex items-center gap-3 border-b border-[color:var(--border-subtle)] py-3 last:border-b-0">
      <span className="relative flex h-[22px] w-[22px] shrink-0 items-center justify-center" aria-hidden="true">
        {entry.icon ? (
          <img src={entry.icon} alt="" className="h-[22px] w-[22px] rounded-[3px]" />
        ) : (
          <span className="flex h-[22px] w-[22px] items-center justify-center rounded-[3px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-app)] font-mono text-meta font-semibold text-[color:var(--text-muted)]">
            {entry.name.slice(0, 1).toUpperCase()}
          </span>
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <StatusDot tone={entry.installed ? 'good' : 'neutral'} />
          <span className="truncate text-body font-medium text-[color:var(--text-strong)]">{entry.name}</span>
        </div>
        {/* One state line, and it says what happens next — never "connected",
            which would claim a credential Multicode does not hold. */}
        <div className="truncate text-meta text-[color:var(--text-subtle)]">{ticketTrackerStateLine(entry)}</div>
      </div>

      {/* One visible action, the rest in the overflow — three buttons plus a
          state line does not fit the row, and the state line is the part that
          loses. Same shape as the Backlog panel's header: the action the row
          exists for stays, everything else is one click away. */}
      <div className="flex shrink-0 items-center gap-2">
        {entry.installed && onStartTerminal ? (
          <GhostButton size="xs" onClick={onStartTerminal}>
            Start a terminal
          </GhostButton>
        ) : null}
        {entry.installed ? (
          <OverflowMenu ariaLabel={`${entry.name} actions`} items={overflowItems} />
        ) : (
          <OutlineButton size="xs" disabled={busy} onClick={onToggle}>
            Install
          </OutlineButton>
        )}
      </div>
    </div>
  )
}
