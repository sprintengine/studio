import type { IpcMain } from 'electron'
import { registerAgentConfigImportIpc } from './ipc/agent-config-import-ipc'
import { registerAppearanceIpc } from './ipc/appearance-ipc'
import { registerBackgroundModeIpc } from './ipc/background-mode-ipc'
import { registerAuthIpc } from './ipc/auth-ipc'
import { registerAutomationIpc } from './ipc/automation-ipc'
import { registerAppMenuIpc } from './app-menu'
import { registerBacklogIpc } from './ipc/backlog-ipc'
import { registerBuiltinSkillsIpc } from './ipc/builtin-skills-ipc'
import { registerStudioPluginIpc } from './ipc/studio-plugin-ipc'
import { registerCliRuntimeIpc } from './ipc/cli-runtime-ipc'
import { registerTextGenerationIpc } from './ipc/text-generation-ipc'
import { registerClipboardIpc } from './ipc/clipboard-ipc'
import { createConversationIpcHandlers, registerConversationIpc } from './ipc/conversation-ipc'
import { registerCredentialIpc } from './ipc/credential-ipc'
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
import { registerSkillsIpc } from './ipc/skills-ipc'
import { registerWorkspaceSkillsIpc } from './ipc/workspace-skills-ipc'
import { registerSoulsIpc } from './ipc/souls-ipc'
import { registerSprintEngineRoleRegistryIpc } from './ipc/sprintengine-role-registry-ipc'
import { registerThirdPartyModuleIpc } from './ipc/third-party-module-ipc'
import { registerUpdateIpc } from './ipc/update-ipc'
import { registerVersionControlIpc } from './ipc/version-control-ipc'
import { registerVoiceIpc } from './ipc/voice-ipc'
import { registerWindowIpc } from './ipc/window-ipc'
import { registerBrowserIpc } from './ipc/browser-ipc'
import { registerWorkspaceSyncIpc } from './ipc/workspace-sync-ipc'
import { confirmWorkspaceWindowClose, createDiagnosticsWindow, createMainWindow, openAuxWindow } from './window-factory'
import { registerWorkspaceBackupIpc } from './ipc/workspace-backup-ipc'
import type { AppServices } from './app-services'
import { createFilesystemMutationHandlers } from './filesystem-mutation-handlers'
import { createFilesystemReadHandlers } from './filesystem-read'
import { createFilesystemWatchSearchHandlers } from './filesystem-watch-search-handlers'
import { openDiagnosticsLogsFolder, writeDiagnosticLog } from './diagnostics-service'
import { readSpecialistSoul } from './souls-service'

export type CoreIpcOptions = {
  includeDevModules?: boolean
  applyModuleEnablementLive?: ModuleEnablementLiveApplier
}

export function registerCoreIpc(
  ipcMain: IpcMain,
  services: AppServices,
  diagnosticsEnabled: boolean,
  options: CoreIpcOptions = {}
): void {
  registerWindowIpc(ipcMain, {
    createWorkspaceWindow: ({ windowId, bounds, isMaximized }) => {
      createMainWindow({ diagnosticsEnabled, windowId, bounds, isMaximized })
    },
    confirmWindowClose: confirmWorkspaceWindowClose,
    openAuxWindow,
  })
  registerBrowserIpc(ipcMain, services.browserManager)
  registerWorkspaceSyncIpc(ipcMain, services.workspaceSyncService, {
    registry: services.workspaceRegistry,
  })
  registerAutomationIpc(ipcMain, services.automationService)
  registerFleetIpc(ipcMain, services.automationService)
  registerAppMenuIpc(ipcMain)
  registerWorkspaceBackupIpc(ipcMain, services.workspaceBackupService)
  registerClipboardIpc(ipcMain)
  registerCliRuntimeIpc(ipcMain)
  registerTextGenerationIpc(ipcMain)
  // Voice dictation is a dev-only capability (the `voice-dictation` module). Its
  // main IPC is not yet a capability module, so gate it on the build channel
  // here so `voice:transcribe` is genuinely absent in a packaged build, not just
  // orphaned behind a hidden renderer surface.
  if (options.includeDevModules ?? true) registerVoiceIpc(ipcMain)
  registerAuthIpc(ipcMain, services.multicodeAuth, services.entitlements)
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
  // (TerminalView, Sprint Engine auto-run) and the Knowledge Graph settings tab
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
  registerSoulsIpc(ipcMain, {
    readSpecialistSoul,
  })
  registerFilesystemMutationIpc(ipcMain, createFilesystemMutationHandlers())
  registerBacklogIpc(ipcMain)
  registerGitIpc(ipcMain, {
    enabled: diagnosticsEnabled,
    logMainPerfEvent: services.logMainPerfEvent,
    withIpcDiagnostics: services.withIpcDiagnostics,
  })
  registerVersionControlIpc(ipcMain)
  registerGitHubTokenIpc(ipcMain, services.githubTokenStore)
  registerGitHubReposIpc(ipcMain, services.githubTokenStore)
  registerMenuDialogIpc(ipcMain)
  registerModuleEnablementIpc(ipcMain, { applyLive: options.applyModuleEnablementLive })
  registerModuleRegistryIpc(ipcMain, services.moduleRegistryMirror)
  registerAppearanceIpc(ipcMain)
  registerBackgroundModeIpc(ipcMain, services.backgroundModeStore)
  registerMarketplaceRegistryIpc(ipcMain)
  registerHostedModelFeedIpc(ipcMain)
  registerHostedCardFeedIpc(ipcMain)
  // Go, on a card on the Extensions home. Registered after the skills and MCP
  // services it composes, because it is those services said in one press.
  registerCardsIpc(ipcMain, {
    skillsService: services.skillsService,
    mcpConfigService: services.mcpConfigService,
    githubTokenStore: services.githubTokenStore,
  })
  registerCliVersionIpc(ipcMain)
  registerMarketplacePluginIpc(ipcMain, services)
  registerPluginIpc(ipcMain)
  registerConversationIpc(ipcMain, createConversationIpcHandlers(services.conversationRuntime))
  registerCredentialIpc(ipcMain)
  registerSprintEngineRoleRegistryIpc(ipcMain)
  registerDesignSystemIpc(ipcMain)
  registerThirdPartyModuleIpc(ipcMain)
}
