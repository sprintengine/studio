import type { McpCatalogServer, McpSettings } from '../types/workspace'
import { mcpServerFromCatalog } from '../components/settings/McpCatalog'
import { connectorMcpSettings } from './workspaceWorktree'

export type ResolvedConnectorLaunch = {
  server: McpCatalogServer
  skillId: string
  mcpSettings: McpSettings
}

export type ConnectorLaunchResolution =
  | { ok: true; resolved: ResolvedConnectorLaunch }
  | { ok: false; title: string; message: string }

/**
 * Resolve a connector catalog id to the runtime pieces a connector launch needs:
 * the catalog entry, its driving skill, and the single-server {@link McpSettings}
 * the spawn writes into the worktree `.mcp.json`. Shared by the connector chat
 * launch (WorkspaceManager) and the connector automation spawn
 * (useAutomationRequests) so both enforce the same rule — a catalog entry with no
 * `skill` is not a connector and is refused, never silently launched without one.
 */
export async function resolveConnectorLaunch(connectorId: string): Promise<ConnectorLaunchResolution> {
  const catalog = await window.api.mcpListCatalog()
  if (!catalog.ok) {
    return { ok: false, title: 'Connector catalog unavailable', message: catalog.message }
  }
  const server = catalog.servers.find((entry) => entry.id === connectorId)
  if (!server) {
    return { ok: false, title: 'Connector unavailable', message: `The ${connectorId} MCP is missing from the connector catalog.` }
  }
  const skillId = server.skill
  if (!skillId) {
    return {
      ok: false,
      title: `${server.name} is not a connector`,
      message: `${server.name} has no connector skill, so it cannot be launched as a connector chat.`,
    }
  }
  return { ok: true, resolved: { server, skillId, mcpSettings: connectorMcpSettings(mcpServerFromCatalog(server)) } }
}
