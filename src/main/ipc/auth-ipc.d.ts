import type { IpcMain } from 'electron';
import type { EntitlementSnapshot, FeatureValue, MulticodeAuthState, PremiumAccessDecision, PremiumAccessRequest, SessionSnapshot } from '../../shared/electron-api';
type AuthBridge = {
    initialize(): Promise<MulticodeAuthState>;
    login(organizationId?: string | null): Promise<{
        state: string;
        authorizationUrl: string;
    }>;
    logout(): Promise<{
        loggedOut: true;
    }>;
    refreshEntitlements(options?: {
        forceRefresh?: boolean;
    }): Promise<MulticodeAuthState>;
    selectOrganization(organizationId: string): Promise<{
        organizationId: string;
    }>;
    openUpgrade(reason?: string): Promise<{
        opened: true;
        url: string;
    }>;
    getSession(): Promise<SessionSnapshot>;
};
type EntitlementGate = {
    checkAccess(input: PremiumAccessRequest): Promise<PremiumAccessDecision>;
    getSnapshot(options?: {
        forceRefresh?: boolean;
    }): Promise<EntitlementSnapshot>;
    requireFeature(input: PremiumAccessRequest | string): Promise<FeatureValue>;
};
export declare function registerAuthIpc(ipcMain: IpcMain, auth: AuthBridge, entitlements: EntitlementGate): void;
export {};
