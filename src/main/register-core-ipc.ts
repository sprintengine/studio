import type { IpcMain } from 'electron'
import { registerAuthIpc } from './ipc/auth-ipc'
import { registerBuiltinSkillsIpc } from './ipc/builtin-skills-ipc'
import { registerDiagnosticsIpc } from './ipc/diagnostics-ipc'
import { registerFilesystemMutationIpc } from './ipc/filesystem-mutation-ipc'
import { registerFilesystemReadIpc } from './ipc/filesystem-read-ipc'
import { registerFilesystemWatchSearchIpc } from './ipc/filesystem-watch-search-ipc'
import { registerGitHubTokenIpc } from './ipc/github-token-ipc'
import { registerGitIpc } from './ipc/git-ipc'
import { registerMcpIpc } from './ipc/mcp-ipc'
import { registerMenuDialogIpc } from './ipc/menu-dialog-ipc'
import { registerModuleEnablementIpc } from './ipc/module-enablement-ipc'
import { registerSkillPackIpc } from './ipc/skill-pack-ipc'
import { registerSoulsIpc } from './ipc/souls-ipc'
import { registerUpdateIpc } from './ipc/update-ipc'
import { registerWindowIpc } from './ipc/window-ipc'
import { registerWorkspaceBackupIpc } from './ipc/workspace-backup-ipc'
import type { AppServices } from './app-services'
import { createFilesystemMutationHandlers } from './filesystem-mutation-handlers'
import { createFilesystemReadHandlers } from './filesystem-read'
import { createFilesystemWatchSearchHandlers } from './filesystem-watch-search-handlers'
import { openDiagnosticsLogsFolder, writeDiagnosticLog } from './diagnostics-service'
import { readMultiloopPrompt, readSpecialistSoul } from './souls-service'

export function registerCoreIpc(ipcMain: IpcMain, services: AppServices, diagnosticsEnabled: boolean): void {
  registerWindowIpc(ipcMain)
  registerWorkspaceBackupIpc(ipcMain, services.workspaceBackupService)
  registerAuthIpc(ipcMain, services.multicodeAuth)
  registerBuiltinSkillsIpc(ipcMain, services.builtinSkillManager)
  registerMcpIpc(ipcMain, services.mcpConfigService)
  registerSkillPackIpc(ipcMain, services.skillPackService)
  registerFilesystemWatchSearchIpc(ipcMain, createFilesystemWatchSearchHandlers())
  registerFilesystemReadIpc(ipcMain, createFilesystemReadHandlers())
  registerDiagnosticsIpc(ipcMain, {
    writeDiagnosticLog,
    openDiagnosticsLogsFolder,
  })
  registerUpdateIpc(ipcMain, { updateService: services.updateService })
  registerSoulsIpc(ipcMain, {
    readSpecialistSoul,
    readMultiloopPrompt,
  })
  registerFilesystemMutationIpc(ipcMain, createFilesystemMutationHandlers())
  registerGitIpc(ipcMain, {
    enabled: diagnosticsEnabled,
    logMainPerfEvent: services.logMainPerfEvent,
    withIpcDiagnostics: services.withIpcDiagnostics,
  })
  registerGitHubTokenIpc(ipcMain, services.githubTokenStore)
  registerMenuDialogIpc(ipcMain)
  registerModuleEnablementIpc(ipcMain)
}
