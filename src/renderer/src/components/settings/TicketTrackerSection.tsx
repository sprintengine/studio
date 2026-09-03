import React, { useCallback, useMemo, useState } from 'react'

import { GhostButton, InlineNotice, OutlineButton, StatusDot } from '../ui'
import { SettingsSectionTitle } from './SettingsAtoms'
import { useConnectorSources } from '../panels/ConnectorsPanel/useConnectorSources'
import {
  partitionTicketTrackers,
  ticketTrackerStateLine,
  type TicketTrackerEntry,
} from './ticketTrackerConnectors'

// Settings → Ticket trackers, the "for your agents" half (MC-2362).
//
// Installing a tracker here installs its MCP, so an agent can read and update
// tickets during a run. It is deliberately separate from the Connections list
// below it, which is the "for Multicode" half — an API credential the app uses
// with no agent running, for browsing issues and posting run lifecycle comments.
// The two are complements, not alternatives, and the copy says which is which
// because that distinction is the thing users get wrong.
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

  const total = bands.installed.length + bands.available.length

  return (
    <section className="space-y-3">
      <SettingsSectionTitle count={total || undefined}>For your agents</SettingsSectionTitle>
      <p className="max-w-[68ch] text-body leading-5 text-[color:var(--text-muted)]">
        Install a tracker to give your agents its tools — reading a ticket, leaving a comment, moving a status,
        during a run. Each one signs you in the first time an agent uses it; Multicode never holds the credential.
        An installed tracker becomes launchable in Connectors, where you can start a chat or an automation on it.
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
}: {
  label: string
  entries: readonly TicketTrackerEntry[]
  emptyHint?: string
  busyId: string | null
  onToggle: (id: string) => void
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
}: {
  entry: TicketTrackerEntry
  busy: boolean
  onToggle: () => void
}): JSX.Element {
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

      <div className="flex shrink-0 items-center gap-2">
        <OutlineButton size="xs" disabled={busy} onClick={onToggle}>
          {entry.installed ? 'Remove' : 'Install'}
        </OutlineButton>
      </div>
    </div>
  )
}
