import type { McpCatalogServer, McpServerConfig, McpSettings } from '../types/workspace'
import { mcpServerFromCatalog } from '../components/settings/McpCatalog'
import { connectorCanLaunch } from '../components/panels/ConnectorsPanel/connectorsFacets'
import { connectorMcpSettings } from './workspaceWorktree'

export type ResolvedConnectorLaunch = {
  // Identity for naming the launched chat (workspace title, kickoff prompt).
  server: { id: string; name: string }
  // The driving builtin skill when the catalog pairs one (e.g. railway →
  // use-railway). Undefined for a plain MCP launch: no skill install and no
  // seeded skill invocation — the chat still gets the isolated single-server
  // MCP config below.
  skillId?: string
  mcpSettings: McpSettings
}

export type ConnectorLaunchResolution =
  | { ok: true; resolved: ResolvedConnectorLaunch }
  | { ok: false; title: string; message: string }

/**
 * Resolve a connector id to the runtime pieces a connector launch needs: the
 * server's identity, its driving skill when the catalog pairs one, and the
 * single-server {@link McpSettings} the spawn writes into the worktree
 * `.mcp.json`. Shared by the connector chat launch (WorkspaceManager) and the
 * connector automation spawn (useAutomationRequests) so both resolve the same
 * way.
 *
 * Launchability is {@link connectorCanLaunch} — the same rule every UI surface
 * gates on: a catalog entry with a driving skill, or an installed+enabled
 * server (including custom servers with no catalog row). An installed config
 * wins over the catalog template because it carries the user's own env/header
 * edits. Everything else is refused loudly — never a silent launch on the
 * bare catalog template of a server the user disabled or never installed.
 */
export async function resolveConnectorLaunch(
  connectorId: string,
  installedServers?: Record<string, McpServerConfig>,
): Promise<ConnectorLaunchResolution> {
  // A rejected catalog IPC degrades to a failed load; the installed config can
  // still carry the launch below.
  const catalog = await window.api.mcpListCatalog().catch(
    (error): { ok: false; message: string } => ({
      ok: false,
      message: error instanceof Error ? error.message : 'Unable to load the connector catalog.',
    }),
  )
  const catalogServer: McpCatalogServer | undefined = catalog.ok
    ? catalog.servers.find((entry) => entry.id === connectorId)
    : undefined
  const installedEntry = installedServers?.[connectorId]
  const installed = installedEntry?.enabled ? installedEntry : undefined

  if (!connectorCanLaunch(catalogServer?.skill, installed != null)) {
    const name = catalogServer?.name ?? installedEntry?.name ?? connectorId
    if (installedEntry && !installedEntry.enabled) {
      return {
        ok: false,
        title: `${name} is disabled`,
        message: `${name} is disabled in MCP settings. Enable it to launch a connector chat.`,
      }
    }
    if (catalogServer) {
      return {
        ok: false,
        title: `${name} is not installed`,
        message: `${name} isn’t installed. Add it from the Connectors browse list to launch a chat.`,
      }
    }
    if (!catalog.ok) {
      return { ok: false, title: 'Connector catalog unavailable', message: catalog.message }
    }
    return {
      ok: false,
      title: 'Connector unavailable',
      message: `The ${connectorId} MCP is not in the connector catalog or MCP settings. Add it from the Connectors surface to launch it.`,
    }
  }

  const config = installed ?? mcpServerFromCatalog(catalogServer!)
  return {
    ok: true,
    resolved: {
      server: { id: connectorId, name: catalogServer?.name ?? config.name },
      ...(catalogServer?.skill ? { skillId: catalogServer.skill } : {}),
      mcpSettings: connectorMcpSettings(config),
    },
  }
}
