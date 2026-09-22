import { app } from 'electron'
import type { IpcMain } from 'electron'
import { registerAgentConfigImportIpc } from './ipc/agent-config-import-ipc'
import { registerAppearanceIpc } from './ipc/appearance-ipc'
import { registerBackgroundModeIpc } from './ipc/background-mode-ipc'
import { registerTelemetryIpc } from './ipc/telemetry-ipc'
import { registerAuthIpc } from './ipc/auth-ipc'
import { registerAutomationIpc } from './ipc/automation-ipc'
import { registerAppMenuIpc } from './app-menu'
import { registerBacklogIpc } from './ipc/backlog-ipc'
import { registerBuiltinSkillsIpc } from './ipc/builtin-skills-ipc'
import { registerStudioPluginIpc } from './ipc/studio-plugin-ipc'
import { registerCliRuntimeIpc } from './ipc/cli-runtime-ipc'
import { registerCliModelDiscoveryIpc } from './ipc/cli-model-discovery-ipc'
import { registerTextGenerationIpc } from './ipc/text-generation-ipc'
import { registerClipboardIpc } from './ipc/clipboard-ipc'
import { createConversationIpcHandlers, registerConversationIpc } from './ipc/conversation-ipc'
import { registerCredentialIpc } from './ipc/credential-ipc'
import { registerConversationPeekIpc } from './ipc/conversation-peek-ipc'
import { registerDiagnosticsIpc } from './ipc/diagnostics-ipc'
import { registerFilesystemMutationIpc } from './ipc/filesystem-mutation-ipc'
import { registerFilesystemReadIpc } from './ipc/filesystem-read-ipc'
import { registerFilesystemWatchSearchIpc } from './ipc/filesystem-watch-search-ipc'
import { registerFleetIpc } from './ipc/fleet-ipc'
import { createFolderOpenIpcDependencies, registerFolderOpenIpc } from './ipc/folder-open-ipc'
import { registerGitHubTokenIpc } from './ipc/github-token-ipc'
import { registerGitHubReposIpc } from './ipc/github-repos-ipc'
import { registerGitIpc } from './ipc/git-ipc'
import { registerDesignSystemIpc } from './ipc/design-system-ipc'
import { registerMcpIpc } from './ipc/mcp-ipc'
import { registerMemoryActivityIpc } from './ipc/memory-activity-ipc'
import { registerMemoryIpc } from './ipc/memory-ipc'
import { registerMenuDialogIpc } from './ipc/menu-dialog-ipc'
import { registerMarketplacePluginIpc } from './ipc/marketplace-plugin-ipc'
import { registerMarketplaceRegistryIpc } from './ipc/marketplace-registry-ipc'
import { registerHostedModelFeedIpc } from './ipc/hosted-feed-ipc'
import { registerHostedCardFeedIpc } from './ipc/card-feed-ipc'
import { registerCardsIpc } from './ipc/cards-ipc'
import { registerCliVersionIpc } from './ipc/cli-version-ipc'
import { registerModuleEnablementIpc, type ModuleEnablementLiveApplier } from './ipc/module-enablement-ipc'
import { registerModuleRegistryIpc } from './ipc/module-registry-ipc'
import { registerPluginIpc } from './ipc/plugins-ipc'
import { registerPullRequestIpc } from './ipc/pull-request-ipc'
import { registerSkillsIpc } from './ipc/skills-ipc'
import { registerTerminalIpc } from './ipc/terminal-ipc'
import { registerWorkspaceSkillsIpc } from './ipc/workspace-skills-ipc'
import { registerLaunchSettingsIpc } from './ipc/launch-settings-ipc'
import { registerThirdPartyModuleIpc } from './ipc/third-party-module-ipc'
import { registerUpdateIpc } from './ipc/update-ipc'
import { registerVersionControlIpc } from './ipc/version-control-ipc'
import { registerVoiceIpc } from './ipc/voice-ipc'
import { registerWindowIpc } from './ipc/window-ipc'
import { registerBrowserIpc } from './ipc/browser-ipc'
import { registerCanvasIpc } from './ipc/canvas-ipc'
import { registerWorkspaceSyncIpc } from './ipc/workspace-sync-ipc'
import {
  confirmWorkspaceWindowClose,
  createDiagnosticsWindow,
  createMainWindow,
  isAuxWindow,
  openAuxWindow,
} from './window-factory'
import { registerWorkspaceBackupIpc } from './ipc/workspace-backup-ipc'
import type { AppServices } from './app-services'
import { createFilesystemMutationHandlers } from './filesystem-mutation-handlers'
import { createFilesystemReadHandlers } from './filesystem-read'
import { createFilesystemWatchSearchHandlers } from './filesystem-watch-search-handlers'
import { openDiagnosticsLogsFolder, writeDiagnosticLog } from './diagnostics-service'

export type CoreIpcOptions = {
  includeDevModules?: boolean
  applyModuleEnablementLive?: ModuleEnablementLiveApplier
}

export function registerCoreIpc(
  ipcMain: IpcMain,
  services: AppServices,
  diagnosticsEnabled: boolean,
  options: CoreIpcOptions = {},
): void {
  registerWindowIpc(ipcMain, {
    createWorkspaceWindow: ({ windowId, bounds, isMaximized }) => {
      createMainWindow({ diagnosticsEnabled, windowId, bounds, isMaximized })
    },
    confirmWindowClose: confirmWorkspaceWindowClose,
    openAuxWindow,
    isAuxWindow,
  })
  registerBrowserIpc(ipcMain, services.browserManager)
  registerCanvasIpc(ipcMain, services.canvasService, services.canvasSubscribers)
  registerWorkspaceSyncIpc(ipcMain, services.workspaceSyncService, {
    registry: services.workspaceRegistry,
  })
  registerAutomationIpc(ipcMain, services.automationService)
  registerFleetIpc(ipcMain, services.automationService)
  registerAppMenuIpc(ipcMain)
  registerWorkspaceBackupIpc(ipcMain, services.workspaceBackupService)
  registerClipboardIpc(ipcMain)
  registerCliRuntimeIpc(ipcMain)
  registerCliModelDiscoveryIpc(ipcMain)
  registerTextGenerationIpc(ipcMain)
  // Voice dictation is a dev-only capability (the `voice-dictation` module). Its
  // main IPC is not yet a capability module, so gate it on the build channel
  // here so `voice:transcribe` is genuinely absent in a packaged build, not just
  // orphaned behind a hidden renderer surface.
  if (options.includeDevModules ?? true) registerVoiceIpc(ipcMain)
  registerAuthIpc(ipcMain, services.sprintengineAuth)
  registerBuiltinSkillsIpc(ipcMain, services.builtinSkillManager)
  registerStudioPluginIpc(ipcMain, services.studioPluginService)
  registerMcpIpc(ipcMain, services.mcpConfigService)
  registerAgentConfigImportIpc(ipcMain, services.agentConfigImportService)
  registerSkillsIpc(ipcMain, services.skillsService)
  registerWorkspaceSkillsIpc(ipcMain, {
    workspaceSkills: services.workspaceSkillsService,
    agentCapabilities: services.agentCapabilityService,
    agentSkillInstaller: services.agentSkillInstaller,
  })
  registerFilesystemWatchSearchIpc(ipcMain, createFilesystemWatchSearchHandlers())
  const filesystemReadHandlers = createFilesystemReadHandlers()
  registerFilesystemReadIpc(ipcMain, filesystemReadHandlers)
  // The file-manager target of the open-in-editor control is the same reveal the
  // rest of the app already uses, so it is handed the very same handler.
  registerFolderOpenIpc(ipcMain, createFolderOpenIpcDependencies(filesystemReadHandlers.showItemInFolder))
  // Memory/knowledge-graph backend is foundational: agent context injection
  // (TerminalView) and the Knowledge Graph settings tab
  // depend on it, so it is always registered. The memory-graph capability
  // module gates only the visualization panel (renderer side).
  registerMemoryIpc(ipcMain)
  registerMemoryActivityIpc(ipcMain)
  registerDiagnosticsIpc(ipcMain, {
    writeDiagnosticLog,
    openDiagnosticsLogsFolder,
    openDiagnosticsWindow: () => {
      createDiagnosticsWindow()
    },
    listConversationRoots: () => services.conversationRuntime.listLiveConversationRoots(),
  })
  registerUpdateIpc(ipcMain, { updateService: services.updateService })
  registerLaunchSettingsIpc(ipcMain, { launchSettings: services.agentLaunchSettings })
  registerFilesystemMutationIpc(ipcMain, createFilesystemMutationHandlers())
  registerBacklogIpc(ipcMain)
  registerGitIpc(
    ipcMain,
    {
      enabled: diagnosticsEnabled,
      logMainPerfEvent: services.logMainPerfEvent,
      withIpcDiagnostics: services.withIpcDiagnostics,
    },
    // The changelist store's home. Resolved here rather than inside the git
    // modules so those stay free of `electron.app` and remain testable against
    // a temp directory.
    {
      userDataDir: app.getPath('userData'),
      onChangelistsChanged: services.broadcastGitChangelistsChanged,
    },
  )
  registerVersionControlIpc(ipcMain)
  registerGitHubTokenIpc(ipcMain, services.githubTokenStore)
  registerGitHubReposIpc(ipcMain, services.githubTokenStore)
  registerMenuDialogIpc(ipcMain)
  registerModuleEnablementIpc(ipcMain, { applyLive: options.applyModuleEnablementLive })
  registerModuleRegistryIpc(ipcMain, services.moduleRegistryMirror)
  registerAppearanceIpc(ipcMain)
  registerBackgroundModeIpc(ipcMain, services.backgroundModeStore)
  registerTelemetryIpc(ipcMain, services.telemetryConsentStore)
  registerMarketplaceRegistryIpc(ipcMain)
  registerHostedModelFeedIpc(ipcMain)
  registerHostedCardFeedIpc(ipcMain)
  // Go, on a card on the Extensions home. Registered after the skills and MCP
  // services it composes, because it is those services said in one press.
  registerCardsIpc(ipcMain, {
    skillsService: services.skillsService,
    mcpConfigService: services.mcpConfigService,
    githubTokenStore: services.githubTokenStore,
    // For a card's `install.module`: the same marketplace lifecycle the
    // storefront installs through, which needs this for a bundle that also
    // carries an automation.
    getAutomationsAppFrontDoor: services.getAutomationsAppFrontDoor,
  })
  registerCliVersionIpc(ipcMain)
  registerMarketplacePluginIpc(ipcMain, services)
  registerPluginIpc(ipcMain)
  registerConversationIpc(ipcMain, createConversationIpcHandlers(services.conversationRuntime))
  registerCredentialIpc(ipcMain)
  registerDesignSystemIpc(ipcMain)
  registerThirdPartyModuleIpc(ipcMain)

  // The terminal runtime (agent-runtime) is always on, so its IPC registers
  // with the core surfaces.
  registerTerminalIpc(ipcMain, {
    ...services.terminalRuntime.ipcHandlers,
    // One idle-suspend setting governs both agent runtimes: PTY terminals and
    // headless conversation child processes share the threshold.
    setIdleSuspendThresholdMs: (value: unknown): void => {
      services.terminalRuntime.ipcHandlers.setIdleSuspendThresholdMs(value)
      services.conversationRuntime.setIdleThresholdMs(value)
    },
  })

  // The conversation peek reads a terminal session, so it registers alongside
  // the runtime that owns one rather than with the core surfaces.
  registerConversationPeekIpc(ipcMain, services.conversationPeek)

  // Same reason: the pull request marks are read off a terminal session's
  // observed checkout, so their one refresh channel registers beside the
  // runtime that owns the session.
  registerPullRequestIpc(ipcMain, {
    refreshPullRequestsForSession: (sessionId) => services.pullRequestRecord.refreshForSession(sessionId),
    // Keyed by conversation, for the rows with nothing running in them.
    listForWorkspaces: (workspaceIds) => {
      const out: Record<string, ReturnType<typeof services.pullRequestRecord.forWorkspace>> = {}
      for (const id of workspaceIds) {
        const list = services.pullRequestRecord.forWorkspace(id)
        // Only conversations that have something. An empty array per id would
        // make every answer the size of the question.
        if (list.length > 0) out[id] = list
      }
      return out
    },
  })
}
