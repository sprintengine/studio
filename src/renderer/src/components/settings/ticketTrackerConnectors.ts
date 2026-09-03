// The Ticket trackers surface's pure model (MC-2362).
//
// "Connect my ticket tracker to my agents" is answered by installing that
// tracker's MCP — the CLI does its own OAuth, Multicode injects no credential.
// This module decides what the surface shows; the component renders it and the
// existing connector plumbing (useConnectorSources → toggleCatalogServer,
// resolveConnectorLaunch) does the work.
//
// Membership is catalogue data (`ticketTracker: true`), never a list of ids in a
// component: adding a fifth tracker is then an edit to resources/mcps/catalog.json
// and nothing else.

import type { McpCatalogServer } from '../../../../shared/electron-api'

export type TicketTrackerEntry = {
  id: string
  name: string
  description?: string
  icon?: string
  /** The one server this connector reaches, shown so the row is checkable. */
  endpoint: string
  installed: boolean
}

export type TicketTrackerBands = {
  installed: TicketTrackerEntry[]
  available: TicketTrackerEntry[]
}

export function isTicketTracker(server: McpCatalogServer): boolean {
  return server.ticketTracker === true
}

// Where a connector points, for the state line. A remote MCP has a URL; a stdio
// one has a command. Rendering the host rather than the full URL keeps the line
// short and is the part a user recognises.
export function ticketTrackerEndpointLabel(server: McpCatalogServer): string {
  const url = typeof server.url === 'string' ? server.url.trim() : ''
  if (url) {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  }
  const command = typeof server.command === 'string' ? server.command.trim() : ''
  return command || 'no endpoint declared'
}

/**
 * Split the catalogue's ticket trackers into the two bands the surface shows.
 *
 * Installed first — those are the ones a user acts on. Both bands are sorted by
 * name so the list does not reshuffle when something is installed; only the band
 * changes.
 */
export function partitionTicketTrackers(
  servers: readonly McpCatalogServer[],
  installedServerIds: ReadonlySet<string>,
): TicketTrackerBands {
  const entries = servers.filter(isTicketTracker).map((server) => ({
    id: server.id,
    name: server.name,
    ...(server.description ? { description: server.description } : {}),
    ...(server.icon ? { icon: server.icon } : {}),
    endpoint: ticketTrackerEndpointLabel(server),
    installed: installedServerIds.has(server.id),
  }))
  const byName = (a: TicketTrackerEntry, b: TicketTrackerEntry): number => a.name.localeCompare(b.name)
  return {
    installed: entries.filter((entry) => entry.installed).sort(byName),
    available: entries.filter((entry) => !entry.installed).sort(byName),
  }
}

/**
 * The row's one mandatory state line (provider-row's contract: it is state, and
 * it says what happens next).
 *
 * An installed tracker is deliberately NOT described as "connected": Multicode
 * holds no credential for it — these catalogue entries carry `envVarNames: []`
 * and the agent authenticates on first use. Saying "connected" would claim a
 * relationship the app does not have.
 */
export function ticketTrackerStateLine(entry: TicketTrackerEntry): string {
  return entry.installed
    ? `Installed for your agents · ${entry.endpoint} — the agent signs in on first use`
    : `Not installed · ${entry.endpoint}`
}
