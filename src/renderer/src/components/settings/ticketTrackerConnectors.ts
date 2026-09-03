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
  installed: boolean
}

export type TicketTrackerBands = {
  installed: TicketTrackerEntry[]
  available: TicketTrackerEntry[]
}

export function isTicketTracker(server: McpCatalogServer): boolean {
  return server.ticketTracker === true
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
    installed: installedServerIds.has(server.id),
  }))
  const byName = (a: TicketTrackerEntry, b: TicketTrackerEntry): number => a.name.localeCompare(b.name)
  return {
    installed: entries.filter((entry) => entry.installed).sort(byName),
    available: entries.filter((entry) => !entry.installed).sort(byName),
  }
}

