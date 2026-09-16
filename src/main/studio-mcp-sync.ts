import type { McpConfigService } from './mcp-config-service'
import type { McpServerConfig, McpSyncInput } from '../shared/electron-api'
import { STUDIO_MCP_SERVER_ID, STUDIO_MCP_SERVER_NAME } from '../shared/product-identity'
import { compatStudioEnvEntry } from '../shared/studio-env'

export type StudioMcpSyncResult = { ok: true } | { ok: false; message: string }

/**
 * Write a launch's MCP configuration, with the app's own always-on gateway
 * server pinned into the workspace target.
 *
 * Two passes, not one: the generic writer picks a single target when a user's
 * own servers are user-scoped, and this app-owned entry must never land in a
 * user-global CLI config. The first pass (only when the user has servers to
 * write) carries their settings; the second pins the gateway to the workspace.
 */
export async function syncStudioMcpConfig(
  input: McpSyncInput,
  deps: {
    mcpConfigService: Pick<McpConfigService, 'sync'>
    studioGateway?: () => {
      command: string
      bridgeScriptPath: string
      userDataDir: string
    }
  }
): Promise<StudioMcpSyncResult> {
  let syncInputs = [input]

  const studioGateway = deps.studioGateway?.()
  if (studioGateway) {
    const clients = input.clients ?? []
    const cliId = clients.length === 1 ? clients[0] : undefined
    const studioServer: McpServerConfig = {
      id: STUDIO_MCP_SERVER_ID,
      name: STUDIO_MCP_SERVER_NAME,
      description: 'Always-on local control surface for SprintEngine Studio.',
      transport: 'stdio',
      command: studioGateway.command,
      args: [studioGateway.bridgeScriptPath],
      // Both spellings: this config is written into the workspace's own MCP
      // files and stays there, so the bridge that eventually reads it may be a
      // copy installed either side of the rename.
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        ...compatStudioEnvEntry('SPRINTENGINE_USER_DATA_DIR', studioGateway.userDataDir),
        ...compatStudioEnvEntry('SPRINTENGINE_AGENT_CLI', cliId),
      },
      enabled: true,
      required: true,
      clients,
      scope: 'workspace',
      source: 'bundled',
      riskLevel: 'local-command',
      capabilities: ['studio'],
    }
    syncInputs = [
      ...(input.settings.syncEnabled && Object.keys(input.settings.servers).length > 0 ? [input] : []),
      {
        ...input,
        pruneUnlistedServers: false,
        settings: {
          syncEnabled: true,
          servers: { [studioServer.id]: studioServer },
        },
      },
    ]
  }

  for (const syncInput of syncInputs) {
    const result = deps.mcpConfigService.sync(syncInput)
    if (!result.ok) return { ok: false, message: result.message }
  }
  return { ok: true }
}
