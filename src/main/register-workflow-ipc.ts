import type { IpcMain } from 'electron'
import { registerMobileBridgeIpc } from './ipc/mobile-bridge-ipc'
import { registerTerminalIpc } from './ipc/terminal-ipc'
import type { AppServices } from './app-services'

// Switchboard + Watchtower, Multiloop, and Sprint Engine IPC moved to their
// capability modules (src/main/modules/), registered through the host kernel.
// What remains here is the always-on workflow surface (mobile relay, terminal
// runtime) not yet migrated.
export function registerWorkflowIpc(ipcMain: IpcMain, services: AppServices): void {
  registerMobileBridgeIpc(ipcMain, {
    bridge: services.mobileBridge,
    getWorkspaceRoots: services.getMobileWorkspaceRoots,
    setWorkspaceRoots: services.setMobileWorkspaceRoots,
  })
  registerTerminalIpc(ipcMain, services.terminalRuntime.ipcHandlers)
}
