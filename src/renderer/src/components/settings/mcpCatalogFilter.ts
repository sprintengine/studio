// mcpCatalogFilter — pure, DOM-free filter for the MCP catalog search toolbar.
// Kept out of McpCatalog.tsx (which imports UI primitives) so the match rules
// have lean node-level unit coverage, mirroring the other settings view-models
// (providerSettings.ts, extensionsInstalled.ts).

import type { McpCatalogServer } from '../../types/workspace'

// Case-insensitive match on the fields a user scans for — name, category, and
// description. An empty or whitespace-only query returns the full list
// unchanged, so search never hides servers until the user actually types.
export function filterMcpCatalog(servers: McpCatalogServer[], query: string): McpCatalogServer[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return servers
  return servers.filter((server) =>
    [server.name, server.category, server.description].some((field) =>
      (field ?? '').toLowerCase().includes(needle),
    ),
  )
}
