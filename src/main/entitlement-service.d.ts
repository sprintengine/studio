import type { EntitlementSnapshot, FeatureValue, PremiumAccessDecision, PremiumAccessRequest } from '../shared/electron-api';
export type CachedEntitlementSnapshot = {
    snapshot: EntitlementSnapshot;
    lastRefreshAt: string;
};
export type EntitlementReading = {
    authenticated: boolean;
    snapshot: EntitlementSnapshot | null;
    cache: CachedEntitlementSnapshot | null;
    lastRefreshAt: string | null;
};
export interface EntitlementProvider {
    read(): EntitlementReading;
    refresh(): Promise<void>;
}
export type EntitlementCacheStatus = 'fresh' | 'offline_grace' | 'expired';
export declare const ENTITLEMENT_GRACE_MS: number;
export declare const ENTITLEMENT_MAX_CACHE_AGE_MS: number;
export type EntitlementServiceOptions = {
    product: EntitlementSnapshot['product'];
    graceMs?: number;
    maxCacheAgeMs?: number;
};
export declare class EntitlementService {
    private readonly provider;
    private readonly product;
    private readonly graceMs;
    private readonly maxCacheAgeMs;
    constructor(provider: EntitlementProvider, options: EntitlementServiceOptions);
    hasFeature(featureKey: string): Promise<boolean>;
    refreshFeature(featureKey: string): Promise<PremiumAccessDecision>;
    checkAccess(request: PremiumAccessRequest): Promise<PremiumAccessDecision>;
    requireFeature(input: PremiumAccessRequest | string): Promise<FeatureValue>;
    getSnapshot(options?: {
        forceRefresh?: boolean;
    }): Promise<EntitlementSnapshot>;
}
export declare function isEntitlementSnapshotFresh(snapshot: EntitlementSnapshot): boolean;
export declare function entitlementGraceExpiresAt(cache: CachedEntitlementSnapshot, graceMs?: number): string | null;
export declare function isEntitlementCacheTooStale(cache: CachedEntitlementSnapshot, maxCacheAgeMs?: number): boolean;
export declare function entitlementCacheStatus(cache: CachedEntitlementSnapshot, graceMs?: number, maxCacheAgeMs?: number): EntitlementCacheStatus;
export declare function offlineGraceMessage(graceExpiresAt: string | null | undefined): string;
export declare function isEntitlementSnapshot(input: unknown, product: EntitlementSnapshot['product']): input is EntitlementSnapshot;
