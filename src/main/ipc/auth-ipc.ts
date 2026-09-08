import type { IpcMain } from 'electron'
import type {
  MulticodeAuthState,
  PremiumAccessDecision,
  PremiumAccessRequest,
} from '../../shared/electron-api'

// Identity and session — the provider-shaped half of the auth surface.
type AuthBridge = {
  initialize(): Promise<MulticodeAuthState>
  login(organizationId?: string | null): Promise<{ state: string; authorizationUrl: string }>
  logout(): Promise<{ loggedOut: true }>
  refreshEntitlements(options?: { forceRefresh?: boolean }): Promise<MulticodeAuthState>
  openUpgrade(reason?: string): Promise<{ opened: true; url: string }>
}

// The entitlement seam (`src/main/entitlement-service.ts`). Every feature-key
// question the renderer asks is answered here, by a service that names no
// provider — which is why the premium-access handler takes it rather than the
// bridge.
type EntitlementGate = {
  checkAccess(input: PremiumAccessRequest): Promise<PremiumAccessDecision>
}

export function registerAuthIpc(ipcMain: IpcMain, auth: AuthBridge, entitlements: EntitlementGate): void {
  ipcMain.handle('auth:get-state', () => auth.initialize())

  ipcMain.handle('auth:login', (_, organizationId?: string | null) => auth.login(organizationId))

  ipcMain.handle('auth:logout', () => auth.logout())

  ipcMain.handle('auth:refresh-entitlements', () => auth.refreshEntitlements({ forceRefresh: true }))

  ipcMain.handle('auth:open-upgrade', (_, reason?: string) => auth.openUpgrade(reason))

  ipcMain.handle('auth:check-premium-access', (_, input: PremiumAccessRequest) => entitlements.checkAccess(input))
}
