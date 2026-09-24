import {
  removeManagedStudioGatewayFromClaudeWorkspace,
  RETIRED_SPRINTENGINE_MCP_SERVER_ID,
  type McpConfigService,
} from './mcp-config-service'
import type { McpServerConfig, McpSyncInput } from '../shared/electron-api'
import type { TerminalPathStyle } from '../shared/electron-api'
import { STUDIO_MCP_SERVER_ID, STUDIO_MCP_SERVER_NAME } from '../shared/product-identity'
import { AGENT_IDENTITY_ENV_KEYS, studioEnvEntry } from '../shared/studio-env'
import { toWslPath } from '../shared/host-paths'
import { wslInteropEnv } from './wsl-interop'

export type StudioMcpSyncResult = { ok: true } | { ok: false; message: string }

/**
 * Write a launch's MCP configuration, with the app's own gateway server pinned
 * into the workspace target. The gateway is optional to the CLI: losing it
 * reduces Studio integration but must not prevent the agent itself launching.
 *
 * Two passes, not one: the generic writer picks a single target when a user's
 * own servers are user-scoped, and this app-owned entry must never land in a
 * user-global CLI config. The first pass (only when the user has servers to
 * write) carries their settings; the second pins the gateway to the workspace
 * and forgets the retired Sprint Engine server.
 *
 * `studioGatewayDeliveredAtLaunch` says the launch hands the CLI the app's own
 * plugin directory, whose `.mcp.json` already carries the gateway for that one
 * session. Then nothing of the app's is pinned into the workspace: the person's
 * own synced servers are still written (that is their configuration, not ours),
 * and a gateway entry an earlier launch pinned is taken back out.
 */
export async function syncStudioMcpConfig(
  input: McpSyncInput & { executionPathStyle?: TerminalPathStyle; studioGatewayDeliveredAtLaunch?: boolean },
  deps: {
    mcpConfigService: Pick<McpConfigService, 'sync'>
    studioGateway?: () => {
      command: string
      bridgeScriptPath: string
      userDataDir: string
    }
  },
): Promise<StudioMcpSyncResult> {
  const { studioGatewayDeliveredAtLaunch, ...syncInput } = input
  if (studioGatewayDeliveredAtLaunch) {
    if (syncInput.settings.syncEnabled && Object.keys(syncInput.settings.servers).length > 0) {
      const result = await deps.mcpConfigService.sync(syncInput)
      if (!result.ok) return { ok: false, message: result.message }
    }
    // Best-effort by construction (it never throws): a stale entry that could
    // not be removed costs a duplicate server, never the launch.
    await removeManagedStudioGatewayFromClaudeWorkspace(syncInput.workspaceRoot)
    return { ok: true }
  }

  let syncInputs = [syncInput]

  const studioGateway = deps.studioGateway?.()
  if (studioGateway) {
    const clients = syncInput.clients ?? []
    const cliId = clients.length === 1 ? clients[0] : undefined
    const throughWsl = syncInput.executionPathStyle === 'wsl'
    const bridgeEnv = {
      ELECTRON_RUN_AS_NODE: '1',
      ...studioEnvEntry('SPRINTENGINE_USER_DATA_DIR', studioGateway.userDataDir),
      ...studioEnvEntry('SPRINTENGINE_AGENT_CLI', cliId),
    }
    const studioServer: McpServerConfig = {
      id: STUDIO_MCP_SERVER_ID,
      name: STUDIO_MCP_SERVER_NAME,
      description: 'Always-on local control surface for SprintEngine Studio.',
      transport: 'stdio',
      // Through WSL the CLI is a Linux process starting a Windows program: the
      // executable crosses as `/mnt/<drive>/…`, while the bridge script and the
      // user-data directory stay Windows paths, because the Windows-hosted
      // runtime is what opens them.
      command: throughWsl ? toWslPath(studioGateway.command) : studioGateway.command,
      args: [studioGateway.bridgeScriptPath],
      // A WSL CLI starts the Windows binary through interop, which forwards
      // only what `WSLENV` names; without it the bridge would open the app. The
      // agent identity the launch shared into WSL is named too, so the bridge
      // can still attribute the connection to its agent.
      env: throughWsl ? wslInteropEnv(bridgeEnv, AGENT_IDENTITY_ENV_KEYS) : bridgeEnv,
      enabled: true,
      required: false,
      clients,
      scope: 'workspace',
      source: 'bundled',
      riskLevel: 'local-command',
      capabilities: ['studio'],
    }
    syncInputs = [
      ...(syncInput.settings.syncEnabled && Object.keys(syncInput.settings.servers).length > 0 ? [syncInput] : []),
      {
        ...syncInput,
        pruneUnlistedServers: false,
        // The deleted Sprint Engine's per-run server: forgotten on every pass
        // that pins the gateway, so a workspace that once ran a sprint stops
        // listing a server nothing answers.
        forgetServerIds: [...(syncInput.forgetServerIds ?? []), RETIRED_SPRINTENGINE_MCP_SERVER_ID],
        settings: {
          syncEnabled: true,
          servers: { [studioServer.id]: studioServer },
        },
      },
    ]
  }

  for (const pass of syncInputs) {
    const result = await deps.mcpConfigService.sync(pass)
    if (!result.ok) return { ok: false, message: result.message }
  }
  return { ok: true }
}
