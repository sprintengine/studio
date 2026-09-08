/**
 * Connector resolution for an agent launch, as pure data (MC-2159).
 *
 * A connector-backed launch needs three things before a pty exists: the
 * server's identity (for naming), its driving builtin skill when the catalog
 * pairs one, and the single-server {@link McpSettings} the spawn writes into the
 * worktree `.mcp.json`. Resolving them used to require `window.api` — which is
 * why `agent.launch` with a `connectorId` could not be composed headless.
 *
 * Everything here is a lookup over two inputs the caller supplies: the connector
 * catalog and the user's installed MCP servers. The renderer binds them from
 * `window.api.mcpListCatalog()` + `appSettings.mcp.servers`
 * (`src/renderer/src/utils/connectorLaunch.ts`); main binds them from
 * `mcpConfigService.listCatalog()` + the main-owned launch settings store.
 * Neither side re-implements the rule.
 *
 * Launchability is one predicate — a catalog entry with a driving skill, or an
 * installed+enabled server (including a custom server with no catalog row) —
 * and it is the same rule every UI surface gates on. An installed config wins
 * over the catalog template because it carries the user's own env/header edits.
 * Everything else is refused loudly: never a silent launch on the bare catalog
 * template of a server the user disabled or never installed.
 */
import type {
  McpCatalogResult,
  McpCatalogServer,
  McpServerConfig,
  McpSettings,
} from './electron-api'

type ResolvedConnectorLaunch = {
  /** Identity for naming the launched chat (workspace title, kickoff prompt). */
  server: { id: string; name: string }
  /**
   * The driving builtin skill when the catalog pairs one with the server.
   * Undefined for a plain MCP launch — which is every shipped connector since
   * the studio stopped shipping third-party servers and their paired skills
   * (2026-09-08): no skill install and no seeded skill invocation, and the chat
   * still gets the isolated single-server MCP config below.
   */
  skillId?: string
  mcpSettings: McpSettings
}

export type ConnectorLaunchResolution =
  | { ok: true; resolved: ResolvedConnectorLaunch }
  | { ok: false; title: string; message: string }

/**
 * Can this connector be launched at all? A catalog entry with a driving skill
 * is launchable even when nothing is installed (the skill carries the flow);
 * an installed+enabled server is launchable with or without a catalog row.
 */
export function connectorCanLaunch(skill: string | undefined, installed: boolean): boolean {
  return Boolean(skill) || installed
}

/** Present a catalog entry as an installable server config. */
export function mcpServerFromCatalog(server: McpCatalogServer): McpServerConfig {
  return {
    id: server.id,
    name: server.name,
    category: server.category,
    description: server.description,
    transport: server.transport,
    command: server.command,
    args: server.args ?? [],
    url: server.url,
    env: server.env,
    envVarNames: server.envVarNames ?? [],
    headers: server.headers,
    enabled: true,
    required: false,
    clients: server.defaultClients?.length ? server.defaultClients : server.clients,
    scope: server.recommendedScope ?? 'workspace',
    source: 'bundled',
    riskLevel: server.riskLevel,
    auth: server.auth,
    capabilities: server.capabilities,
    sourceUrl: server.sourceUrl,
  }
}

/** The isolated single-server MCP config a connector launch writes. */
export function connectorMcpSettings(server: McpServerConfig): McpSettings {
  return { syncEnabled: true, servers: { [server.id]: server } }
}

export function resolveConnectorLaunchFrom(input: {
  connectorId: string
  /**
   * The connector catalog. A failed load is passed through as-is rather than
   * flattened to an empty list: an installed server still launches without the
   * catalog, but a connector found in NEITHER place must report the load
   * failure instead of "not in the catalog", which would be a different bug.
   */
  catalog: McpCatalogResult
  installedServers?: Record<string, McpServerConfig>
}): ConnectorLaunchResolution {
  const { connectorId, catalog, installedServers } = input
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
        message: `${name} isn’t installed. Add it from the Plugins marketplace to launch a chat.`,
      }
    }
    if (!catalog.ok) {
      return { ok: false, title: 'Connector catalog unavailable', message: catalog.message }
    }
    return {
      ok: false,
      title: 'Connector unavailable',
      message: `The ${connectorId} MCP is not in the connector catalog or MCP settings. Add it from the Plugins marketplace to launch it.`,
    }
  }

  // Non-null by the predicate above: without an installed config, launchability
  // required a catalog entry carrying a skill.
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
