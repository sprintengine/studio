import type { IpcMain } from 'electron'
import type { SprintEngineAuthState } from '../../shared/electron-api'

// Identity and session.
type AuthBridge = {
  initialize(): Promise<SprintEngineAuthState>
  login(organizationId?: string | null): Promise<{ state: string; authorizationUrl: string }>
  logout(): Promise<{ loggedOut: true }>
  refreshEntitlements(options?: { forceRefresh?: boolean }): Promise<SprintEngineAuthState>
  openUpgrade(reason?: string): Promise<{ opened: true; url: string }>
}

export function registerAuthIpc(ipcMain: IpcMain, auth: AuthBridge): void {
  ipcMain.handle('auth:get-state', () => auth.initialize())

  ipcMain.handle('auth:login', (_, organizationId?: string | null) => auth.login(organizationId))

  ipcMain.handle('auth:logout', () => auth.logout())

  ipcMain.handle('auth:refresh-entitlements', () => auth.refreshEntitlements({ forceRefresh: true }))

  ipcMain.handle('auth:open-upgrade', (_, reason?: string) => auth.openUpgrade(reason))
}
