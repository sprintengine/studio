/**
 * Connector resolution for an agent launch, as pure data.
 *
 * A connector-backed launch needs two things before a pty exists: the server's
 * identity (for naming) and the single-server {@link McpSettings} the spawn
 * writes into the worktree `.mcp.json`. Resolving them used to require
 * `window.api` — which is why `agent.launch` with a `connectorId` could not be
 * composed headless.
 *
 * Everything here is a lookup over one input the caller supplies: the user's
 * installed MCP servers. The renderer binds it from `appSettings.mcp.servers`
 * (`src/renderer/src/utils/connectorLaunch.ts`); main binds it from the
 * main-owned launch settings store. Neither side re-implements the rule.
 *
 * Launchability is one predicate — the server is installed and enabled — and it
 * is the same rule every UI surface gates on. Until the third-party retirement
 * (2026-09-08) there was a second way in: a row in the bundled MCP
 * catalogue that paired a driving builtin skill with a server, launchable
 * before install because the launch synthesized its config from the catalogue
 * template. The catalogue is gone, the paired skills went with it, and with
 * them the only case where a launch ran on a server the person had not
 * installed. Everything else is refused loudly.
 */
import type { McpServerConfig, McpSettings } from './electron-api'

type ResolvedConnectorLaunch = {
  /** Identity for naming the launched chat (workspace title, kickoff prompt). */
  server: { id: string; name: string }
  mcpSettings: McpSettings
}

export type ConnectorLaunchResolution =
  { ok: true; resolved: ResolvedConnectorLaunch } | { ok: false; title: string; message: string }

/**
 * Can this connector be launched at all? Only an installed, enabled server —
 * the config carries the user's own env and header edits, and there is no
 * template left to launch a server nobody installed.
 */
export function connectorCanLaunch(installed: boolean): boolean {
  return installed
}

/** The isolated single-server MCP config a connector launch writes. */
export function connectorMcpSettings(server: McpServerConfig): McpSettings {
  return { syncEnabled: true, servers: { [server.id]: server } }
}

export function resolveConnectorLaunchFrom(input: {
  connectorId: string
  installedServers?: Record<string, McpServerConfig>
}): ConnectorLaunchResolution {
  const { connectorId, installedServers } = input
  const installedEntry = installedServers?.[connectorId]
  const installed = installedEntry?.enabled ? installedEntry : undefined

  if (!connectorCanLaunch(installed != null)) {
    const name = installedEntry?.name ?? connectorId
    if (installedEntry) {
      return {
        ok: false,
        title: `${name} is disabled`,
        message: `${name} is disabled in MCP settings. Enable it to launch a connector chat.`,
      }
    }
    return {
      ok: false,
      title: 'Connector unavailable',
      message: `The ${connectorId} MCP is not in MCP settings. Install the plugin that carries it to launch a chat.`,
    }
  }

  return {
    ok: true,
    resolved: {
      server: { id: connectorId, name: installed!.name },
      mcpSettings: connectorMcpSettings(installed!),
    },
  }
}
