import React, { useCallback, useMemo, useState } from 'react'

import { EmptyState, GhostButton, InlineNotice, OverflowMenu } from '../ui'
import type { OverflowMenuItem } from '../ui'
import { McpBrandIcon, mcpIconSlug } from './McpCatalog'
import {
  ConnectorRow,
  ConnectorSectionHeading,
} from '../panels/ConnectorsPanel/ConnectorRow'
import { getExtensionsSurfaceHost } from '../workspace/globalSurface/extensions/extensionsSurfaceHost'
import { useConnectorSources } from '../panels/ConnectorsPanel/useConnectorSources'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { partitionTicketTrackers, type TicketTrackerEntry } from './ticketTrackerConnectors'

// Settings → Ticket trackers (MC-2362, narrowed by MC-2363).
//
// Installing a tracker here installs its MCP, so an agent can read and update
// tickets during a run. That is the whole integration: Multicode itself does not
// talk to trackers, because browsing tickets in an IDE competes with the
// tracker's own UI and loses.
//
// The rows are `ConnectorRow` — the same card the Connectors surface uses for
// every MCP and extension — so a tracker looks like what it is rather than
// getting a bespoke row of its own. Which band a tracker sits in already says
// whether it is installed, so the row carries no status line repeating it.
//
// One column, not the Connectors grid's two: this pane is roughly half the width
// of that panel, and at two columns the catalogue description truncates to three
// words, which is worse than not showing it.

export function TicketTrackerSection({ workspaceRoot }: { workspaceRoot: string | null }): JSX.Element {
  const sources = useConnectorSources(workspaceRoot)
  const { catalogLoad, installedServerIds, toggleCatalogServer, loadCatalog } = sources
  const openExtensionsSurface = useWorkspaceStore((s) => s.openExtensionsSurface)
  const [busyId, setBusyId] = useState<string | null>(null)

  const servers = catalogLoad.status === 'ready' ? catalogLoad.data : []
  const bands = useMemo(
    () => partitionTicketTrackers(servers, installedServerIds),
    [servers, installedServerIds],
  )
  const summaryById = useMemo(
    () => new Map(servers.map((server) => [server.id, server.description])),
    [servers],
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
  // started here is byte-identical to one started from Connectors.
  const startTerminal = useCallback((entry: TicketTrackerEntry) => {
    getExtensionsSurfaceHost()?.onLaunchConnector({
      id: entry.id,
      name: entry.name,
      ...(entry.icon ? { icon: entry.icon } : {}),
    })
  }, [])
  const useInAutomation = useCallback((entry: TicketTrackerEntry) => {
    getExtensionsSurfaceHost()?.onUseInAutomation(entry.id)
  }, [])

  const total = bands.installed.length + bands.available.length

  const card = (entry: TicketTrackerEntry): JSX.Element => (
    <ConnectorRow
      key={entry.id}
      icon={<McpBrandIcon slug={mcpIconSlug(entry.id)} name={entry.name} icon={entry.icon} size={36} />}
      name={entry.name}
      summary={summaryById.get(entry.id)}
      actions={
        entry.installed ? (
          <>
            <GhostButton
              size="sm"
              onClick={() => startTerminal(entry)}
              className="border border-[color:var(--border-default)]"
            >
              Start a terminal
            </GhostButton>
            <OverflowMenu
              ariaLabel={`${entry.name} actions`}
              items={
                [
                  {
                    id: 'use-in-automation',
                    label: 'Use in an automation',
                    onSelect: () => useInAutomation(entry),
                  },
                  {
                    id: 'remove',
                    label: 'Remove',
                    onSelect: () => toggle(entry.id),
                    disabled: busyId === entry.id,
                    destructive: true,
                  },
                ] satisfies OverflowMenuItem[]
              }
            />
          </>
        ) : (
          <GhostButton
            size="sm"
            onClick={() => toggle(entry.id)}
            disabled={busyId === entry.id}
            className="border border-[color:var(--border-default)]"
            aria-label={`Install ${entry.name}`}
          >
            Install
          </GhostButton>
        )
      }
    />
  )

  if (catalogLoad.status === 'error') {
    return (
      <section className="space-y-3">
        <ConnectorSectionHeading label="Ticket trackers" />
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
      </section>
    )
  }

  if (catalogLoad.status === 'loading') {
    return (
      <section className="space-y-3">
        <ConnectorSectionHeading label="Ticket trackers" />
        <p className="py-3 text-body text-[color:var(--text-subtle)]">Loading ticket trackers…</p>
      </section>
    )
  }

  // Empty since the frozen-snapshots retirement (2026-09-06): all four trackers
  // this pane listed — Jira/Confluence, Linear, GitHub and GitLab — are plugins
  // in `anthropics/claude-plugins-official`, so their connector-catalogue rows
  // went, because nobody should be offered two routes to one server. The
  // capability did not go with them; the route did, and saying "none in the
  // catalog" would be a dead end where the answer is one click away. Reading
  // installed plugin servers back into these bands is the fuller fix and is
  // recorded in backlog/2026-09-06-the-frozen-snapshots-retire.md.
  if (total === 0) {
    return (
      <section className="space-y-3">
        <ConnectorSectionHeading label="Ticket trackers" />
        <EmptyState
          density="list"
          title="Ticket trackers are plugins now."
          body="Jira, Linear, GitHub and GitLab each ship as a plugin with the skills that drive it. Install one from the Anthropic tab and its MCP server is written for this workspace’s agents."
          action={
            <GhostButton
              size="md"
              onClick={() => openExtensionsSurface({ view: 'plugins' })}
              className="h-control-md"
            >
              Browse plugins
            </GhostButton>
          }
        />
      </section>
    )
  }

  return (
    <div className="space-y-5">
      {bands.installed.length > 0 ? (
        <section className="space-y-2">
          <ConnectorSectionHeading label="Installed" count={bands.installed.length} />
          <div className="grid grid-cols-1 gap-1">{bands.installed.map(card)}</div>
        </section>
      ) : null}
      <section className="space-y-2">
        <ConnectorSectionHeading label="Available" count={bands.available.length} />
        <div className="grid grid-cols-1 gap-1">{bands.available.map(card)}</div>
      </section>
    </div>
  )
}
