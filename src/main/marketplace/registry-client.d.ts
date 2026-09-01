import type { MarketplaceRegistryReadInput, MarketplaceRegistryReadResult } from '../../shared/electron-api';
export declare const DEFAULT_MARKETPLACE_REGISTRY_URL: string;
export declare const MARKETPLACE_REGISTRY_CACHE_FILENAME = "marketplace-registry-cache.json";
export declare const MARKETPLACE_REGISTRY_SEED_FILENAME = "marketplace.json";
export declare const DEFAULT_MARKETPLACE_REGISTRY_TIMEOUT_MS = 15000;
export declare function configuredMarketplaceRegistryUrl(env?: NodeJS.ProcessEnv): string;
/**
 * With no override configured the registry is served bundled-first: the
 * packaged marketplace.json is generated from the HotStack catalogue snapshot
 * (scripts/generate-connector-catalogue.mjs) and committed, so the normal
 * case needs no network and must not render as a degraded/offline notice.
 */
export declare function isMarketplaceRegistryOverrideConfigured(env?: NodeJS.ProcessEnv): boolean;
export type MarketplaceRegistryFetch = (url: string, init: RequestInit) => Promise<Response>;
export type MarketplaceRegistryClientOptions = {
    registryUrl?: string;
    cachePath: string;
    fetcher?: MarketplaceRegistryFetch;
    timeoutMs?: number;
    now?: () => Date;
    packagedSeedPath?: string | null;
    usePackagedSeedFallback?: boolean;
    /**
     * Serve the packaged seed directly (source 'bundled', state 'ok') instead
     * of fetching — the default when no MULTICODE_MARKETPLACE_REGISTRY_URL
     * override is configured. Falls through to the remote path only if the
     * packaged seed is missing or unreadable.
     */
    preferBundledSeed?: boolean;
};
export declare function defaultMarketplaceRegistryCachePath(userDataDir: string): string;
export declare class MarketplaceRegistryClient {
    private readonly registryUrl;
    private readonly cachePath;
    private readonly fetcher;
    private readonly timeoutMs;
    private readonly now;
    private readonly packagedSeedPath;
    private readonly usePackagedSeedFallback;
    private readonly preferBundledSeed;
    private seedCache;
    constructor(options: MarketplaceRegistryClientOptions);
    read(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult>;
    private fetchWithTimeout;
    private readCache;
    private writeCache;
    private staleSeedOrFailure;
    /**
     * Read + validate the packaged seed, cached by file mtime: the seed is
     * immutable in packaged builds (and rarely regenerated in dev), while the
     * bundled-first default makes this a per-panel-open path — re-reading and
     * re-validating 258 icon-laden entries every call is pure waste. The mtime
     * doubles as the honest "data as of" timestamp for bundled reads.
     */
    private loadPackagedSeed;
    /**
     * The bundled-default read: the packaged seed IS the registry, served as a
     * healthy result — never as an offline/degraded notice. `fetchedAt` is the
     * seed file's mtime, not now(): the data is as old as the build, and a
     * user-initiated refresh must not report frozen data as freshly fetched.
     * Returns null when the seed is missing or unparseable so read() can fall
     * through to the remote flow.
     */
    private readBundledSeed;
    private readPackagedSeed;
    private resolvePackagedSeedPath;
}
