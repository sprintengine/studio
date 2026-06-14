import type { IpcMain } from 'electron'
import { registerAuthIpc } from './ipc/auth-ipc'
import { registerAutomationIpc } from './ipc/automation-ipc'
import { registerAppMenuIpc } from './app-menu'
import { registerBacklogIpc } from './ipc/backlog-ipc'
import { registerBuiltinSkillsIpc } from './ipc/builtin-skills-ipc'
import { registerClipboardIpc } from './ipc/clipboard-ipc'
import { registerConversationIpc } from './ipc/conversation-ipc'
import { registerDiagnosticsIpc } from './ipc/diagnostics-ipc'
import { registerFilesystemMutationIpc } from './ipc/filesystem-mutation-ipc'
import { registerFilesystemReadIpc } from './ipc/filesystem-read-ipc'
import { registerFilesystemWatchSearchIpc } from './ipc/filesystem-watch-search-ipc'
import { registerGitHubTokenIpc } from './ipc/github-token-ipc'
import { registerGitIpc } from './ipc/git-ipc'
import { registerLayoutTemplateRegistryIpc } from './ipc/layout-template-registry-ipc'
import { registerMcpIpc } from './ipc/mcp-ipc'
import { registerMemoryActivityIpc } from './ipc/memory-activity-ipc'
import { registerMemoryIpc } from './ipc/memory-ipc'
import { registerMenuDialogIpc } from './ipc/menu-dialog-ipc'
import { registerModuleEnablementIpc } from './ipc/module-enablement-ipc'
import { registerPluginIpc } from './ipc/plugins-ipc'
import { registerSkillPackIpc } from './ipc/skill-pack-ipc'
import { registerSoulsIpc } from './ipc/souls-ipc'
import { registerSprintEngineRoleRegistryIpc } from './ipc/sprintengine-role-registry-ipc'
import { registerThirdPartyModuleIpc } from './ipc/third-party-module-ipc'
import { registerUpdateIpc } from './ipc/update-ipc'
import { registerVoiceIpc } from './ipc/voice-ipc'
import { registerWindowIpc } from './ipc/window-ipc'
import { registerWorkspaceSyncIpc } from './ipc/workspace-sync-ipc'
import { confirmWorkspaceWindowClose, createDiagnosticsWindow, createMainWindow, openAuxWindow } from './window-factory'
import { registerWorkspaceBackupIpc } from './ipc/workspace-backup-ipc'
import type { AppServices } from './app-services'
import { createFilesystemMutationHandlers } from './filesystem-mutation-handlers'
import { createFilesystemReadHandlers } from './filesystem-read'
import { createFilesystemWatchSearchHandlers } from './filesystem-watch-search-handlers'
import { openDiagnosticsLogsFolder, writeDiagnosticLog } from './diagnostics-service'
import { readMultiloopPrompt, readSpecialistSoul } from './souls-service'

export function registerCoreIpc(ipcMain: IpcMain, services: AppServices, diagnosticsEnabled: boolean): void {
  registerWindowIpc(ipcMain, {
    createWorkspaceWindow: ({ windowId, bounds, isMaximized }) => {
      createMainWindow({ diagnosticsEnabled, windowId, bounds, isMaximized })
    },
    confirmWindowClose: confirmWorkspaceWindowClose,
    openAuxWindow,
  })
  registerWorkspaceSyncIpc(ipcMain, services.workspaceSyncService)
  registerAutomationIpc(ipcMain, services.automationService, services.automationDelegate)
  registerAppMenuIpc(ipcMain)
  registerWorkspaceBackupIpc(ipcMain, services.workspaceBackupService)
  registerClipboardIpc(ipcMain)
  registerVoiceIpc(ipcMain)
  registerAuthIpc(ipcMain, services.multicodeAuth)
  registerBuiltinSkillsIpc(ipcMain, services.builtinSkillManager)
  registerMcpIpc(ipcMain, services.mcpConfigService)
  registerSkillPackIpc(ipcMain, services.skillPackService)
  registerFilesystemWatchSearchIpc(ipcMain, createFilesystemWatchSearchHandlers())
  registerFilesystemReadIpc(ipcMain, createFilesystemReadHandlers())
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
  })
  registerUpdateIpc(ipcMain, { updateService: services.updateService })
  registerSoulsIpc(ipcMain, {
    readSpecialistSoul,
    readMultiloopPrompt,
  })
  registerFilesystemMutationIpc(ipcMain, createFilesystemMutationHandlers())
  registerBacklogIpc(ipcMain)
  registerGitIpc(ipcMain, {
    enabled: diagnosticsEnabled,
    logMainPerfEvent: services.logMainPerfEvent,
    withIpcDiagnostics: services.withIpcDiagnostics,
  })
  registerGitHubTokenIpc(ipcMain, services.githubTokenStore)
  registerMenuDialogIpc(ipcMain)
  registerModuleEnablementIpc(ipcMain)
  registerPluginIpc(ipcMain)
  registerConversationIpc(ipcMain)
  registerSprintEngineRoleRegistryIpc(ipcMain)
  registerLayoutTemplateRegistryIpc(ipcMain)
  registerThirdPartyModuleIpc(ipcMain)
}
