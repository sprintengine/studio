import type { McpConfigService } from './mcp-config-service'
import type { SprintEngineMcpHubService } from './sprintengine-mcp-hub'
import type { McpSyncInput } from '../shared/electron-api'

export type ManagedSprintEngineMcpSyncResult =
  | { ok: true; managedSprintEngineRunId?: string; runTokenEnv?: Record<string, string> }
  | { ok: false; message: string }

export const MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR = 'MULTICODE_SPRINTENGINE_MCP_RUN_TOKEN'

export async function syncManagedSprintEngineMcpConfig(
  input: McpSyncInput,
  deps: {
    mcpConfigService: Pick<McpConfigService, 'sync'>
    sprintEngineMcpHub: Pick<SprintEngineMcpHubService, 'ensureStarted' | 'ensureRunRegistered' | 'unregisterRun'>
  }
): Promise<ManagedSprintEngineMcpSyncResult> {
  let syncInput = input
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
    })
    registeredRunId = run.runId
    registeredRunWasCreated = !run.reused
    runToken = run.runToken
    syncInput = {
      ...input,
      managedSprintEngine: {
        ...input.managedSprintEngine,
        http: {
          url: hub.url,
          authTokenEnvVar: MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR,
        },
      },
    }
  }

  let result: ReturnType<McpConfigService['sync']>
  try {
    result = deps.mcpConfigService.sync(syncInput)
  } catch (error) {
    if (registeredRunId && registeredRunWasCreated) await deps.sprintEngineMcpHub.unregisterRun(registeredRunId)
    throw error
  }
  if (!result.ok) {
    if (registeredRunId && registeredRunWasCreated) await deps.sprintEngineMcpHub.unregisterRun(registeredRunId)
    return { ok: false, message: result.message }
  }
  return {
    ok: true,
    managedSprintEngineRunId: registeredRunId,
    runTokenEnv: runToken ? { [MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR]: runToken } : undefined,
  }
}
