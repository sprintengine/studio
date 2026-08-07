import type { McpServerConfig } from '../types/workspace'
import {
  resolveConnectorLaunchFrom,
  type ConnectorLaunchResolution,
  type ResolvedConnectorLaunch,
} from '../../../shared/connector-launch'

export type { ConnectorLaunchResolution, ResolvedConnectorLaunch }

/**
 * Renderer binding of the shared connector resolver
 * (`src/shared/connector-launch.ts`): fetch the catalog over IPC, then apply the
 * rule. The rule itself moved to `src/shared/` with MC-2159 so the main-process
 * AgentLaunchService resolves connectors identically with no window open — a
 * connector automation used to be unreachable headless purely because this
 * lookup lived behind `window.api`.
 *
 * Used by the connector chat launch (WorkspaceManager). A rejected catalog IPC
 * degrades to a failed load; an installed config can still carry the launch.
 */
export async function resolveConnectorLaunch(
  connectorId: string,
  installedServers?: Record<string, McpServerConfig>,
): Promise<ConnectorLaunchResolution> {
  const catalog = await window.api.mcpListCatalog().catch(
    (error): { ok: false; message: string } => ({
      ok: false,
      message: error instanceof Error ? error.message : 'Unable to load the connector catalog.',
    }),
  )
  return resolveConnectorLaunchFrom({ connectorId, catalog, installedServers })
}
