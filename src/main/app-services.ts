import { app, shell } from 'electron'
import { createBuiltinSkillManager } from './builtin-skills'
import { installMulticodeCliTools } from './cli-install'
import { MulticodeAuthBridge } from './auth-service'
import { createMainDiagnostics } from './main-diagnostics'
import { createMcpConfigService } from './mcp-config-service'
import { createSkillPackService } from './skill-pack-service'
import { createSprintEngineArtifactHandlers } from './sprintengine-artifacts'
import { createSprintEngineMcpHubService } from './sprintengine-mcp-hub'
import { syncManagedSprintEngineMcpConfig } from './sprintengine-managed-mcp-sync'
import { createTerminalRuntime } from './terminal-runtime'
import { MulticodeUpdateService } from './update-service'
import { GitHubTokenStore } from './github-token-store'
import { createWorkspaceBackupService } from './workspace-backup'
import { recordSwitchboardSessionExit } from './switchboard-files'
import { writeDiagnosticLog } from './diagnostics-service'

export function createAppServices(diagnosticsEnabled: boolean) {
  const { logMainPerfEvent, withIpcDiagnostics } = createMainDiagnostics({
    enabled: diagnosticsEnabled,
  })
  const cliInstallResult = installMulticodeCliTools()
  if (!cliInstallResult.ok) {
    void writeDiagnosticLog({
      level: 'warning',
      source: 'workspace',
      title: 'Multicode CLI install failed',
      message: `Unable to install all Multicode CLI tools into ${cliInstallResult.binDir}.`,
      details: cliInstallResult.errors.join('; '),
    })
  }

  const multicodeAuth = new MulticodeAuthBridge()
  const mcpConfigService = createMcpConfigService()
  const sprintEngineMcpHub = createSprintEngineMcpHubService({ logMainPerfEvent })
  const skillPackService = createSkillPackService()

  function getAuthenticatedMulticodeUserId(): string | null {
    const state = multicodeAuth.getState()
    if (!state.authenticated) return null
    return state.user?.id?.trim() || state.entitlements?.userId?.trim() || null
  }

  function requireAuthenticatedMulticodeUser(message: string): void {
    if (!getAuthenticatedMulticodeUserId()) {
      throw new Error(message)
    }
  }

  const terminalRuntime = createTerminalRuntime({
    diagnosticsEnabled,
    requireAuthenticatedUser: requireAuthenticatedMulticodeUser,
    logMainPerfEvent,
    onAgentSessionExit: (input) => input.workspaceRoot ? recordSwitchboardSessionExit(input) : undefined,
    syncMcpConfig: (input) => syncManagedSprintEngineMcpConfig(input, { mcpConfigService, sprintEngineMcpHub }),
    releaseManagedSprintEngineRun: (runId) => sprintEngineMcpHub.unregisterRun(runId),
  })
  const updateService = new MulticodeUpdateService({ writeDiagnosticLog })
  const builtinSkillManager = createBuiltinSkillManager()
  const githubTokenStore = new GitHubTokenStore()

  // The mobile relay bridge (construction + IPC + shutdown) and the Switchboard
  // session spawner/stopper/inventory wiring moved to their capability modules
  // (src/main/modules/), registered through the host kernel. multicodeAuth and
  // terminalRuntime are seeded into the kernel so those modules can build on
  // them via the service bridge.

  const workspaceBackupService = createWorkspaceBackupService({
    resolveUserDataDir: () => app.getPath('userData'),
  })
  const sprintEngineArtifacts = createSprintEngineArtifactHandlers({
    getAuthenticatedUserId: getAuthenticatedMulticodeUserId,
    openExternal: (url) => shell.openExternal(url),
  })

  return {
    builtinSkillManager,
    githubTokenStore,
    logMainPerfEvent,
    mcpConfigService,
    multicodeAuth,
    skillPackService,
    sprintEngineArtifacts,
    sprintEngineMcpHub,
    terminalRuntime,
    updateService,
    withIpcDiagnostics,
    workspaceBackupService,
  }
}

export type AppServices = ReturnType<typeof createAppServices>
