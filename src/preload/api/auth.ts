import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ElectronApi,
  EntitlementSnapshot,
  FeatureValue,
  MulticodeAuthState,
  PremiumAccessDecision,
  PremiumAccessRequest,
  SessionSnapshot,
} from '../../shared/electron-api'

export const authApi = {
  authGetState: (): Promise<MulticodeAuthState> => ipcRenderer.invoke('auth:get-state'),
  authLogin: (organizationId?: string | null): Promise<{ state: string; authorizationUrl: string }> =>
    ipcRenderer.invoke('auth:login', organizationId),
  authLogout: (): Promise<{ loggedOut: true }> => ipcRenderer.invoke('auth:logout'),
  authRefreshEntitlements: (): Promise<MulticodeAuthState> => ipcRenderer.invoke('auth:refresh-entitlements'),
  authSelectOrganization: (organizationId: string): Promise<{ organizationId: string }> =>
    ipcRenderer.invoke('auth:select-organization', organizationId),
  authOpenUpgrade: (reason?: string): Promise<{ opened: true; url: string }> =>
    ipcRenderer.invoke('auth:open-upgrade', reason),
  authCheckPremiumAccess: (input: PremiumAccessRequest): Promise<PremiumAccessDecision> =>
    ipcRenderer.invoke('auth:check-premium-access', input),
  authGetSession: (): Promise<SessionSnapshot> => ipcRenderer.invoke('auth:get-session'),
  authGetEntitlements: (options?: { forceRefresh?: boolean }): Promise<EntitlementSnapshot> =>
    ipcRenderer.invoke('auth:get-entitlements', options),
  authRequireEntitlement: (input: string | PremiumAccessRequest): Promise<FeatureValue> =>
    ipcRenderer.invoke('auth:require-entitlement', input),
  onAuthStateChanged: (cb: (state: MulticodeAuthState) => void): (() => void) => {
    const ch = 'auth:state-changed'
    const handler = (_: IpcRendererEvent, state: MulticodeAuthState) => cb(state)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  onAuthCallbackError: (cb: (message: string) => void): (() => void) => {
    const ch = 'auth:callback-error'
    const handler = (_: IpcRendererEvent, message: string) => cb(message)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'authGetState'
  | 'authLogin'
  | 'authLogout'
  | 'authRefreshEntitlements'
  | 'authSelectOrganization'
  | 'authOpenUpgrade'
  | 'authCheckPremiumAccess'
  | 'authGetSession'
  | 'authGetEntitlements'
  | 'authRequireEntitlement'
  | 'onAuthStateChanged'
  | 'onAuthCallbackError'
>
