import { app, shell } from 'electron'
import { createAutomationService } from './automation/automation-service'
import { createAutomationTools } from './automation/automation-tools'
import { createRendererAutomationDelegate } from './automation/renderer-delegate'
import { createBuiltinSkillManager } from './builtin-skills'
import { installMulticodeCliTools } from './cli-install'
import { MulticodeAuthBridge } from './auth-service'
import { createMainDiagnostics } from './main-diagnostics'
import { createMcpConfigService } from './mcp-config-service'
import { createSkillPackService } from './skill-pack-service'
import { createSprintEngineArtifactHandlers } from './sprintengine-artifacts'
import { createGatedSprintEngineMcpHub, createSprintEngineMcpHubService } from './sprintengine-mcp-hub'
import { syncManagedSprintEngineMcpConfig } from './sprintengine-managed-mcp-sync'
import { createTerminalRuntime } from './terminal-runtime'
import { MulticodeUpdateService } from './update-service'
import { GitHubTokenStore } from './github-token-store'
import { createWorkspaceBackupService } from './workspace-backup'
import { createWorkspaceSyncRoutingSnapshotStore } from './workspace-sync-routing-snapshot'
import { createWorkspaceSyncService } from './workspace-sync-service'
import { recordSwitchboardSessionExit } from './switchboard-files'
import { writeDiagnosticLog } from './diagnostics-service'
import { getPluginRegistry } from './plugin-registry-instance'

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
  // Spawn ownership of the hub belongs to the sprint-engine capability module
  // (it claims the gate when it registers its sidecar); a disabled module
  // means the hub process cannot start, by explicit error rather than silence.
  const sprintEngineMcpHub = createGatedSprintEngineMcpHub(createSprintEngineMcpHubService({ logMainPerfEvent }))
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
    callManagedSprintEngineTool: (input) => sprintEngineMcpHub.callRunTool(input),
    releaseManagedSprintEngineRun: async (input) => {
      await sprintEngineMcpHub.unregisterRun(input.runId)
      if (input.cleanupMcpConfig) {
        mcpConfigService.removeManagedSprintEngine({
          workspaceRoot: input.workspaceRoot,
          clients: input.clients,
        })
      }
    },
  })
  const updateService = new MulticodeUpdateService({ writeDiagnosticLog })
  const builtinSkillManager = createBuiltinSkillManager({
    listPlugins: () => getPluginRegistry().loaded(),
  })
  const githubTokenStore = new GitHubTokenStore()

  // The mobile relay bridge (construction + IPC + shutdown) and the Switchboard
  // session spawner/stopper/inventory wiring moved to their capability modules
  // (src/main/modules/), registered through the host kernel. multicodeAuth and
  // terminalRuntime are seeded into the kernel so those modules can build on
  // them via the service bridge.

  const workspaceBackupService = createWorkspaceBackupService({
    resolveUserDataDir: () => app.getPath('userData'),
  })
  const logWorkspaceSyncDiagnostic = (diagnostic: {
    level: 'warning'
    title: string
    message: string
    details?: string
  }) => {
    void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
  }
  const workspaceSyncRoutingSnapshotStore = createWorkspaceSyncRoutingSnapshotStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: logWorkspaceSyncDiagnostic,
  })
  const workspaceSyncService = createWorkspaceSyncService({
    initialRoutingSnapshot: workspaceSyncRoutingSnapshotStore.read() ?? undefined,
    persistRoutingSnapshot: (snapshot) => workspaceSyncRoutingSnapshotStore.write(snapshot),
    logDiagnostic: logWorkspaceSyncDiagnostic,
  })
  const sprintEngineArtifacts = createSprintEngineArtifactHandlers({
    getAuthenticatedUserId: getAuthenticatedMulticodeUserId,
    openExternal: (url) => shell.openExternal(url),
  })

  // App-automation MCP surface: reads come from the workspace-sync snapshot
  // and terminal runtime; mutations are delegated to the primary renderer so
  // they run the same store actions as the UI. Off by default; the persisted
  // setting gates startServer in automationService.initialize().
  const automationDelegate = createRendererAutomationDelegate()
  const automationService = createAutomationService({
    resolveUserDataDir: () => app.getPath('userData'),
    appVersion: app.getVersion(),
    tools: createAutomationTools({
      getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
      listTerminalSessions: () => terminalRuntime.ipcHandlers.listTerminals(),
      delegateToRenderer: (request) => automationDelegate.request(request),
    }),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  return {
    automationDelegate,
    automationService,
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
    workspaceSyncService,
    workspaceSyncRoutingSnapshotStore,
  }
}

export type AppServices = ReturnType<typeof createAppServices>
