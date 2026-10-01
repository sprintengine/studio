import type { IpcMain } from 'electron'
import type { SprintEngineAuthState } from '../../shared/electron-api'

// Identity and session.
type AuthBridge = {
  initialize(): Promise<SprintEngineAuthState>
  login(organizationId?: string | null): Promise<{ state: string; authorizationUrl: string }>
  logout(): Promise<{ loggedOut: true }>
  refreshAccount(): Promise<SprintEngineAuthState>
}

export function registerAuthIpc(ipcMain: IpcMain, auth: AuthBridge): void {
  ipcMain.handle('auth:get-state', () => auth.initialize())

  ipcMain.handle('auth:login', (_, organizationId?: string | null) => auth.login(organizationId))

  ipcMain.handle('auth:logout', () => auth.logout())

  ipcMain.handle('auth:refresh-account', () => auth.refreshAccount())
}
