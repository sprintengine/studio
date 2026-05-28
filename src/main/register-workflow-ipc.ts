import type { IpcMain } from 'electron'
import { registerMobileBridgeIpc } from './ipc/mobile-bridge-ipc'
import { registerMultiloopIpc } from './ipc/multiloop-ipc'
import { registerSprintEngineIpc } from './ipc/sprintengine-ipc'
import { registerTerminalIpc } from './ipc/terminal-ipc'
import type { AppServices } from './app-services'
import { initializeMultiloopState } from './multiloop-init'

// Switchboard + Watchtower IPC moved to the switchboard capability module
// (src/main/modules/switchboard-module.ts), registered through the host kernel.
export function registerWorkflowIpc(ipcMain: IpcMain, services: AppServices): void {
  registerMobileBridgeIpc(ipcMain, {
    bridge: services.mobileBridge,
    getWorkspaceRoots: services.getMobileWorkspaceRoots,
    setWorkspaceRoots: services.setMobileWorkspaceRoots,
  })
  registerTerminalIpc(ipcMain, services.terminalRuntime.ipcHandlers)
  registerSprintEngineIpc(ipcMain, {
    openArtifact: services.sprintEngineArtifacts.openArtifact,
    reviewArtifact: services.sprintEngineArtifacts.reviewArtifact,
    readyTask: services.sprintEngineArtifacts.readyTask,
    initializeSprintEngineState: services.sprintEngineArtifacts.initializeSprintEngineState,
    updateTask: services.sprintEngineArtifacts.updateTask,
    createTask: services.sprintEngineArtifacts.createTask,
    commentTask: services.sprintEngineArtifacts.commentTask,
    setRunnerMode: services.sprintEngineArtifacts.setRunnerMode,
    replenishRoster: services.sprintEngineArtifacts.replenishRoster,
    readProjection: services.sprintEngineArtifacts.readProjection,
    readRegistryRoles: services.sprintEngineArtifacts.readRegistryRoles,
    readRegistryRole: services.sprintEngineArtifacts.readRegistryRole,
    readDispatch: services.sprintEngineArtifacts.readDispatch,
  })
  registerMultiloopIpc(ipcMain, {
    initializeMultiloopState,
  })
}
