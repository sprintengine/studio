import type { McpConfigService } from './mcp-config-service'
import type { SprintEngineMcpHubService } from './sprintengine-mcp-hub'
import type { McpSyncInput } from '../shared/electron-api'

export type ManagedSprintEngineMcpSyncResult =
  | { ok: true; managedSprintEngineSessionId?: string }
  | { ok: false; message: string }

export async function syncManagedSprintEngineMcpConfig(
  input: McpSyncInput,
  deps: {
    mcpConfigService: Pick<McpConfigService, 'sync'>
    sprintEngineMcpHub: Pick<SprintEngineMcpHubService, 'ensureStarted' | 'registerSession' | 'unregisterSession'>
  }
): Promise<ManagedSprintEngineMcpSyncResult> {
  let syncInput = input
  let registeredSessionId: string | undefined
  if (input.managedSprintEngine) {
    const hub = await deps.sprintEngineMcpHub.ensureStarted()
    const session = await deps.sprintEngineMcpHub.registerSession({
      workspaceRoot: input.managedSprintEngine.workspaceRoot || input.workspaceRoot,
      statePath: input.managedSprintEngine.statePath,
      allowedRoots: input.managedSprintEngine.allowedRoots || [input.managedSprintEngine.workspaceRoot || input.workspaceRoot],
      registryRoots: input.managedSprintEngine.registryRoots || [],
      userRoot: input.managedSprintEngine.userRoot,
      actorId: input.managedSprintEngine.actorId || 'multicode-app',
      workspaceId: input.managedSprintEngine.workspaceId,
      agentId: input.managedSprintEngine.agentId || 'agent',
      role: input.managedSprintEngine.role || 'agent',
      cli: input.managedSprintEngine.cli || input.clients?.[0] || 'codex',
    })
    registeredSessionId = session.sessionId
    syncInput = {
      ...input,
      managedSprintEngine: {
        ...input.managedSprintEngine,
        http: {
          url: hub.url,
          authTokenEnvVar: hub.authTokenEnvVar,
          headers: session.headers,
        },
      },
    }
  }

  let result: ReturnType<McpConfigService['sync']>
  try {
    result = deps.mcpConfigService.sync(syncInput)
  } catch (error) {
    if (registeredSessionId) await deps.sprintEngineMcpHub.unregisterSession(registeredSessionId)
    throw error
  }
  if (!result.ok) {
    if (registeredSessionId) await deps.sprintEngineMcpHub.unregisterSession(registeredSessionId)
    return { ok: false, message: result.message }
  }
  return { ok: true, managedSprintEngineSessionId: registeredSessionId }
}
