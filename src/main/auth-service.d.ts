import type { MulticodeAuthState, SessionSnapshot } from '../shared/electron-api';
import { EntitlementService } from './entitlement-service';
export declare class MulticodeAuthBridge {
    private readonly refreshTokenStore;
    private readonly client;
    private state;
    private pendingLogin;
    private callbackServer;
    private cachedEntitlements;
    readonly entitlements: EntitlementService;
    initialize(): Promise<MulticodeAuthState>;
    getState(): MulticodeAuthState;
    login(organizationId?: string | null): Promise<{
        state: string;
        authorizationUrl: string;
    }>;
    handleCallback(callbackUrl: string): Promise<MulticodeAuthState>;
    logout(): Promise<{
        loggedOut: true;
    }>;
    selectOrganization(organizationId: string): Promise<{
        organizationId: string;
    }>;
    refreshEntitlements(options?: {
        forceRefresh?: boolean;
    }): Promise<MulticodeAuthState>;
    getSession(): Promise<SessionSnapshot>;
    getRelayAccessToken(): Promise<string | null>;
    openUpgrade(reason?: string): Promise<{
        opened: true;
        url: string;
    }>;
    private preflightAuthServer;
    private closeCallbackServer;
    private readSessionFromEntitlements;
    private get cachePath();
    private readCachedEntitlements;
    private writeCachedEntitlements;
    private setState;
}
export declare function parseAuthCallbackFromArgv(auth: MulticodeAuthBridge, argv: string[]): Promise<void>;
