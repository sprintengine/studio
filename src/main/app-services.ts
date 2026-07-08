import { app, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { createAgentConfigImportService } from './agent-config-import'
import { createAgentStateService } from './agent-state-service'
import { createAutomationService } from './automation/automation-service'
import { createAutomationTools } from './automation/automation-tools'
import { createRendererAutomationDelegate } from './automation/renderer-delegate'
import { AutomationsStore } from './automations/store'
import type { AutomationsAppFrontDoor } from './ipc/automations-ipc'
import {
  addOrUpdateBacklogLink,
  createBacklogEpic,
  createBacklogItem,
  listBacklogItems,
  readBacklogItem,
  updateBacklogEpic,
  updateBacklogStatus,
  updateBacklogTriage,
  updateBacklogType,
} from './backlog-service'
import { createBuiltinSkillManager } from './builtin-skills'
import { installMulticodeCliTools } from './cli-install'
import { MulticodeAuthBridge } from './auth-service'
import { createMainDiagnostics } from './main-diagnostics'
import { discoverMobileSprintEngineStatePaths } from './mobile-sprintengine-discovery'
import { createMcpConfigService } from './mcp-config-service'
import { createSkillPackService } from './skill-pack-service'
import { createSprintEngineArtifactHandlers } from './sprintengine-artifacts'
import { createGatedSprintEngineMcpHub, createSprintEngineMcpHubService } from './sprintengine-mcp-hub'
import { syncManagedSprintEngineMcpConfig } from './sprintengine-managed-mcp-sync'
import { excludeMcpConfigFromWorktree } from './git'
import { cliResumeCapabilities, createTerminalRuntime } from './terminal-runtime'
import { ConversationRuntime } from './conversation-runtime'
import { getSharedCredentialStore } from './secret-store'
import { createTerminalSnapshotSidecarStore } from './terminal-snapshot-sidecar'
import { MulticodeUpdateService } from './update-service'
import { GitHubTokenStore } from './github-token-store'
import { createWorkspaceBackupService } from './workspace-backup'
import { createWorkspaceSyncRoutingSnapshotStore } from './workspace-sync-routing-snapshot'
import { createWorkspaceSyncService } from './workspace-sync-service'
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

  // Declared before terminalRuntime so the runtime can ensure-install skills
  // (Debug Mode) at spawn. Reads loaded CLI plugins to compute native targets.
  const builtinSkillManager = createBuiltinSkillManager({
    listPlugins: () => getPluginRegistry().loaded(),
  })

  // Authoritative agent state: owns the reporter socket + per-workspace install.
  // Created before terminalRuntime so the runtime can install the reporter at
  // launch; `onFrame` resolves to terminalRuntime (declared just below) at
  // frame time, well after construction.
  const agentStateService = createAgentStateService({
    resolveUserDataDir: () => app.getPath('userData'),
    resolveReporterScriptPath: getBundledAgentStateReporterPath,
    resolveOpencodeReporterScriptPath: getBundledOpencodeAgentStateReporterPath,
    onFrame: (frame) => terminalRuntime.ingestAgentStateFrame(frame),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  // Conversation-agent runtime (chat sessions, incl. headless Claude child
  // processes). Owned here — not inside the IPC factory — so app shutdown can
  // dispose its child processes and diagnostics can inventory them.
  const conversationRuntime = new ConversationRuntime({ secretStore: getSharedCredentialStore() })
  conversationRuntime.startIdleSweep()

  const terminalRuntime = createTerminalRuntime({
    diagnosticsEnabled,
    requireAuthenticatedUser: requireAuthenticatedMulticodeUser,
    logMainPerfEvent,
    // Durable freeze-the-view: suspended agent terminals persist their painted
    // screen to disk and reopen painted-and-paused after an app restart.
    snapshotSidecars: createTerminalSnapshotSidecarStore({
      resolveUserDataDir: () => app.getPath('userData'),
      logDiagnostic: (diagnostic) => {
        void writeDiagnosticLog({ ...diagnostic, source: 'terminal' })
      },
    }),
    // Reaper decision trail (actions + rate-limited skips) into the daily
    // diagnostics JSONL — the in-memory reap ring buffer dies with the process.
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'terminal' })
    },
    syncMcpConfig: (input) => syncManagedSprintEngineMcpConfig(input, { mcpConfigService, sprintEngineMcpHub }),
    callManagedSprintEngineTool: (input) => sprintEngineMcpHub.callRunTool(input),
    // Debug Mode: make the `debug` skill present in the session CLI's native
    // skill dir before launch. Check-first so already-installed workspaces skip
    // the rewrite; install only fills missing or stale native targets.
    ensureBuiltinSkillInstalled: async (workspaceRoot, skillId) => {
      const status = await builtinSkillManager.getStatus(workspaceRoot, skillId)
      if (status.ok && (status.status === 'missing' || status.status === 'update-available')) {
        await builtinSkillManager.install(workspaceRoot, skillId)
      }
    },
    // Connector launch: keep the generated managed MCP config out of the
    // connector chat's worktree git (`.mcp.json` / `.codex/config.toml`).
    excludeWorktreeMcpConfig: (worktreePath) => excludeMcpConfigFromWorktree(worktreePath),
    releaseManagedSprintEngineRun: async (input) => {
      await sprintEngineMcpHub.unregisterRun(input.runId)
      if (input.cleanupMcpConfig) {
        mcpConfigService.removeManagedSprintEngine({
          workspaceRoot: input.workspaceRoot,
          clients: input.clients,
        })
      }
    },
    prepareAgentStateHook: (workspaceRoot, cli) => agentStateService.installForWorkspace(workspaceRoot, cli),
  })
  const updateService = new MulticodeUpdateService({ writeDiagnosticLog })
  const agentConfigImportService = createAgentConfigImportService({
    mcpConfigService,
    builtinSkillManager,
  })
  const githubTokenStore = new GitHubTokenStore()

  // The mobile relay bridge (construction + IPC + shutdown) and the Switchboard
  // session spawner/stopper/inventory/exit-recording wiring moved to their
  // capability modules (src/main/modules/), registered through the host kernel.
  // The terminal runtime now exposes only generic agent-session seams
  // (spawn/kill/inventory + a session-exit listener); modules layer their own
  // system-specific behavior on top. multicodeAuth and terminalRuntime are
  // seeded into the kernel so those modules can build on them via the service
  // bridge.

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
    resolveResumeCapabilities: cliResumeCapabilities,
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
  // The Automations module (and its app front door) registers on the module
  // kernel AFTER app services are constructed; index.ts injects the resolver
  // once the kernel is up. Until then the automation tools report the module
  // as unavailable rather than buffering.
  let resolveAutomationsAppFrontDoor: () => AutomationsAppFrontDoor | null = () => null
  const automationService = createAutomationService({
    resolveUserDataDir: () => app.getPath('userData'),
    appVersion: app.getVersion(),
    // Dev runs serve the script straight from the repo; packaged builds ship
    // it via the electron-builder extraResources entry (resources/automation).
    resolveBridgeScriptPath: () =>
      app.isPackaged
        ? join(process.resourcesPath, 'automation', 'mcp-stdio-bridge.mjs')
        : join(app.getAppPath(), 'resources', 'automation', 'mcp-stdio-bridge.mjs'),
    tools: createAutomationTools({
      getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
      listTerminalSessions: () => terminalRuntime.ipcHandlers.listTerminals(),
      delegateToRenderer: (request) => automationDelegate.request(request),
      listBacklogItems: (workspaceRoot) => listBacklogItems(workspaceRoot),
      readBacklogItem: (workspaceRoot, relativePath) => readBacklogItem(workspaceRoot, relativePath),
      // Same filesystem store the Automations IPC front door reads; roots are
      // snapshot-resolved, so only open workspaces are reachable.
      listAutomationDefinitions: (workspaceRoot) => new AutomationsStore(workspaceRoot).listDefinitions(),
      listAutomationRuns: (workspaceRoot, automationId) => new AutomationsStore(workspaceRoot).listRuns(automationId),
      backlogWrite: {
        createItem: createBacklogItem,
        createEpic: createBacklogEpic,
        updateStatus: updateBacklogStatus,
        updateType: updateBacklogType,
        updateTriage: updateBacklogTriage,
        updateEpic: updateBacklogEpic,
        addOrUpdateLink: addOrUpdateBacklogLink,
      },
      getAutomationsFrontDoor: () => resolveAutomationsAppFrontDoor(),
      listSprintRunStatePaths: (workspaceRoot) => discoverMobileSprintEngineStatePaths([workspaceRoot]),
      readSprintEngineProjection: (statePath) => sprintEngineArtifacts.readProjection({ statePath }),
    }),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  return {
    agentConfigImportService,
    agentStateService,
    automationDelegate,
    automationService,
    setAutomationsAppFrontDoorResolver(resolver: () => AutomationsAppFrontDoor | null): void {
      resolveAutomationsAppFrontDoor = resolver
    },
    builtinSkillManager,
    conversationRuntime,
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

// Resolves a bundled hook reporter script across packaged and dev layouts.
// Mirrors memory-activity's resolver: extraResources ships resources/hooks/*.mjs
// to <resourcesPath>/hooks in packaged builds.
function getBundledHookReporterPath(filename: string): string | null {
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, 'hooks', filename)
    return existsSync(packaged) ? packaged : null
  }
  const candidates = [
    join(process.cwd(), 'resources', 'hooks', filename),
    join(app.getAppPath(), 'resources', 'hooks', filename),
    join(__dirname, '..', '..', 'resources', 'hooks', filename),
    join(__dirname, '..', '..', '..', 'resources', 'hooks', filename),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

// Claude Code + Codex share one stdin-filter reporter; OpenCode uses a separate
// in-process plugin template (rewritten to .js on install).
function getBundledAgentStateReporterPath(): string | null {
  return getBundledHookReporterPath('multicode-agent-state.mjs')
}

function getBundledOpencodeAgentStateReporterPath(): string | null {
  return getBundledHookReporterPath('opencode-agent-state.mjs')
}
