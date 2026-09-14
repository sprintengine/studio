import type { McpConfigService } from './mcp-config-service'
import type { SprintEngineMcpHubService } from './sprintengine-mcp-hub'
import type { McpServerConfig, McpSyncInput } from '../shared/electron-api'
import { STUDIO_MCP_SERVER_ID, STUDIO_MCP_SERVER_NAME } from '../shared/product-identity'
import { compatStudioEnvEntry } from '../shared/studio-env'

export type ManagedSprintEngineMcpSyncResult =
  | { ok: true; managedSprintEngineRunId?: string; runTokenEnv?: Record<string, string> }
  | { ok: false; message: string }

export const MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR = 'SPRINTENGINE_MCP_RUN_TOKEN'
export const MANAGED_SPRINTENGINE_MCP_RUN_ID_ENV_VAR = 'SPRINTENGINE_MCP_RUN_ID'
export const MANAGED_STUDIO_MCP_SERVER_ID = STUDIO_MCP_SERVER_ID

export async function syncManagedSprintEngineMcpConfig(
  input: McpSyncInput,
  deps: {
    mcpConfigService: Pick<McpConfigService, 'sync'>
    sprintEngineMcpHub: Pick<SprintEngineMcpHubService, 'ensureStarted' | 'ensureRunRegistered' | 'unregisterRun'>
    studioGateway?: () => {
      command: string
      bridgeScriptPath: string
      userDataDir: string
    }
  }
): Promise<ManagedSprintEngineMcpSyncResult> {
  let syncInputs = [input]
  let registeredRunId: string | undefined
  let registeredRunWasCreated = false
  let runToken: string | undefined
  if (input.managedSprintEngine) {
    const hub = await deps.sprintEngineMcpHub.ensureStarted()
    const run = await deps.sprintEngineMcpHub.ensureRunRegistered({
      workspaceRoot: input.managedSprintEngine.workspaceRoot || input.workspaceRoot,
      statePath: input.managedSprintEngine.statePath,
      allowedRoots: input.managedSprintEngine.allowedRoots || [input.managedSprintEngine.workspaceRoot || input.workspaceRoot],
      registryRoots: input.managedSprintEngine.registryRoots || [],
      userRoot: input.managedSprintEngine.userRoot,
      actorId: input.managedSprintEngine.actorId || 'multicode-app',
      workspaceId: input.managedSprintEngine.workspaceId,
      agentId: input.managedSprintEngine.agentId,
      role: input.managedSprintEngine.role,
      repo: input.managedSprintEngine.repo,
      taskId: input.managedSprintEngine.taskId,
      knowledgeRoot: input.managedSprintEngine.knowledgeRoot ?? '',
    })
    registeredRunId = run.runId
    registeredRunWasCreated = !run.reused
    runToken = run.runToken
    syncInputs = [{
      ...input,
      managedSprintEngine: {
        ...input.managedSprintEngine,
        http: {
          url: hub.url,
          authTokenEnvVar: MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR,
        },
      },
    }]
  }

  const studioGateway = deps.studioGateway?.()
  if (studioGateway) {
    const clients = input.clients ?? []
    const cliId = clients.length === 1 ? clients[0] : undefined
    const studioServer: McpServerConfig = {
      id: MANAGED_STUDIO_MCP_SERVER_ID,
      name: STUDIO_MCP_SERVER_NAME,
      description: 'Always-on local control surface for SprintEngine Studio and active Sprint Engine runs.',
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
      capabilities: ['studio', 'sprintengine'],
    }
    // A disabled compatibility entry makes every format writer remove the old
    // direct Python server id while leaving unrelated user MCPs untouched.
    const legacyDirectServer: McpServerConfig = {
      ...studioServer,
      id: 'multicode-sprintengine',
      name: 'Legacy direct Sprint Engine MCP',
      enabled: false,
      required: false,
    }
    // Keep the required Studio entry on the workspace target even when a user
    // has configured user-scoped custom MCPs. The generic writer historically
    // chooses one target when scopes are mixed; two passes preserve that
    // existing custom-server behavior while guaranteeing this app-owned entry
    // never lands in a user-global CLI config.
    syncInputs = [
      ...(input.settings.syncEnabled && Object.keys(input.settings.servers).length > 0
        ? [{ ...input, managedSprintEngine: undefined }]
        : []),
      {
        ...input,
        managedSprintEngine: undefined,
        pruneUnlistedServers: false,
        settings: {
          syncEnabled: true,
          servers: {
            [legacyDirectServer.id]: legacyDirectServer,
            [studioServer.id]: studioServer,
          },
        },
      },
    ]
  }

  try {
    for (const syncInput of syncInputs) {
      const result = deps.mcpConfigService.sync(syncInput)
      if (!result.ok) {
        if (registeredRunId && registeredRunWasCreated) await deps.sprintEngineMcpHub.unregisterRun(registeredRunId)
        return { ok: false, message: result.message }
      }
    }
  } catch (error) {
    if (registeredRunId && registeredRunWasCreated) await deps.sprintEngineMcpHub.unregisterRun(registeredRunId)
    throw error
  }
  return {
    ok: true,
    managedSprintEngineRunId: registeredRunId,
    runTokenEnv: registeredRunId && studioGateway
      ? { [MANAGED_SPRINTENGINE_MCP_RUN_ID_ENV_VAR]: registeredRunId }
      : runToken
        ? { [MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR]: runToken }
        : undefined,
  }
}
