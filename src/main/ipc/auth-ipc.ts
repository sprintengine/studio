import type { IpcMain } from 'electron'
import type {
  EntitlementSnapshot,
  FeatureValue,
  MulticodeAuthState,
  PremiumAccessDecision,
  PremiumAccessRequest,
  SessionSnapshot,
  UsageRequest,
  UsageResult,
} from '../../shared/electron-api'

type AuthBridge = {
  initialize(): Promise<MulticodeAuthState>
  login(organizationId?: string | null): Promise<{ state: string; authorizationUrl: string }>
  logout(): Promise<{ loggedOut: true }>
  refreshEntitlements(options?: { forceRefresh?: boolean }): Promise<MulticodeAuthState>
  selectOrganization(organizationId: string): Promise<{ organizationId: string }>
  openUpgrade(reason?: string): Promise<{ opened: true; url: string }>
  checkPremiumAccess(input: PremiumAccessRequest): Promise<PremiumAccessDecision>
  getSession(): Promise<SessionSnapshot>
  getEntitlements(options?: { forceRefresh?: boolean }): Promise<EntitlementSnapshot>
  requireEntitlement(input: PremiumAccessRequest | string): Promise<FeatureValue>
  checkUsage(input: UsageRequest): Promise<UsageResult>
  consumeUsage(input: UsageRequest): Promise<UsageResult>
  releaseUsage(input: UsageRequest): Promise<UsageResult>
}

export function registerAuthIpc(ipcMain: IpcMain, auth: AuthBridge): void {
  ipcMain.handle('auth:get-state', () => auth.initialize())

  ipcMain.handle('auth:login', (_, organizationId?: string | null) => auth.login(organizationId))

  ipcMain.handle('auth:logout', () => auth.logout())

  ipcMain.handle('auth:refresh-entitlements', () => auth.refreshEntitlements({ forceRefresh: true }))

  ipcMain.handle('auth:select-organization', (_, organizationId: string) => auth.selectOrganization(organizationId))

  ipcMain.handle('auth:open-upgrade', (_, reason?: string) => auth.openUpgrade(reason))

  ipcMain.handle('auth:check-premium-access', (_, input: PremiumAccessRequest) => auth.checkPremiumAccess(input))

  ipcMain.handle('auth:get-session', () => auth.getSession())

  ipcMain.handle('auth:get-entitlements', (_, options?: { forceRefresh?: boolean }) => auth.getEntitlements(options))

  ipcMain.handle('auth:require-entitlement', (_, input: PremiumAccessRequest | string) => auth.requireEntitlement(input))

  ipcMain.handle('auth:check-usage', (_, input: UsageRequest) => auth.checkUsage(input))

  ipcMain.handle('auth:consume-usage', (_, input: UsageRequest) => auth.consumeUsage(input))

  ipcMain.handle('auth:release-usage', (_, input: UsageRequest) => auth.releaseUsage(input))
}
