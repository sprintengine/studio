import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MARKETPLACE_CANONICAL_SOURCE, parseMarketplaceIndex, validateMarketplaceIndex, } from '../../shared/marketplace';
import { findMarketplaceResourcePath } from './resources';
export const DEFAULT_MARKETPLACE_REGISTRY_URL = `https://raw.githubusercontent.com/${MARKETPLACE_CANONICAL_SOURCE.owner}/${MARKETPLACE_CANONICAL_SOURCE.repo}/${MARKETPLACE_CANONICAL_SOURCE.ref}/marketplace.json`;
export const MARKETPLACE_REGISTRY_CACHE_FILENAME = 'marketplace-registry-cache.json';
export const MARKETPLACE_REGISTRY_SEED_FILENAME = 'marketplace.json';
export const DEFAULT_MARKETPLACE_REGISTRY_TIMEOUT_MS = 15_000;
// MULTICODE_MARKETPLACE_REGISTRY_URL points the registry read at an alternate
// index endpoint (e.g. the HotStack catalogue GET /v1/registry). GitHub-raw
// stays the shipped default; the override changes only where the index is
// fetched from — schema validation, ETag/304 handling, cache invalidation, and
// the packaged-seed fallback apply to the configured URL exactly as they do to
// the default one.
export function configuredMarketplaceRegistryUrl(env = process.env) {
    const override = env.MULTICODE_MARKETPLACE_REGISTRY_URL?.trim();
    if (override)
        return override;
    return DEFAULT_MARKETPLACE_REGISTRY_URL;
}
/**
 * With no override configured the registry is served bundled-first: the
 * packaged marketplace.json is generated from the HotStack catalogue snapshot
 * (scripts/generate-connector-catalogue.mjs) and committed, so the normal
 * case needs no network and must not render as a degraded/offline notice.
 */
export function isMarketplaceRegistryOverrideConfigured(env = process.env) {
    return Boolean(env.MULTICODE_MARKETPLACE_REGISTRY_URL?.trim());
}
export function defaultMarketplaceRegistryCachePath(userDataDir) {
    return join(userDataDir, MARKETPLACE_REGISTRY_CACHE_FILENAME);
}
export class MarketplaceRegistryClient {
    registryUrl;
    cachePath;
    fetcher;
    timeoutMs;
    now;
    packagedSeedPath;
    usePackagedSeedFallback;
    preferBundledSeed;
    seedCache;
    constructor(options) {
        this.registryUrl = options.registryUrl ?? DEFAULT_MARKETPLACE_REGISTRY_URL;
        this.cachePath = options.cachePath;
        this.fetcher = options.fetcher ?? defaultFetch;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_MARKETPLACE_REGISTRY_TIMEOUT_MS;
        this.now = options.now ?? (() => new Date());
        this.packagedSeedPath = options.packagedSeedPath;
        this.usePackagedSeedFallback = options.usePackagedSeedFallback ?? true;
        this.preferBundledSeed = options.preferBundledSeed ?? false;
    }
    async read(input = {}) {
        if (this.preferBundledSeed) {
            const bundled = await this.readBundledSeed();
            if (bundled)
                return bundled;
            // A packaged build always carries the seed; if it is unreadable,
            // degrade to the remote flow rather than failing outright.
        }
        const registryUrl = this.registryUrl.trim();
        const parsedUrl = parseHttpsUrl(registryUrl);
        if (!parsedUrl.ok) {
            return {
                ok: false,
                state: 'fetch-error',
                registryUrl,
                stale: false,
                message: parsedUrl.message,
            };
        }
        const cache = await this.readCache(registryUrl);
        let response;
        try {
            response = await this.fetchWithTimeout(parsedUrl.url, cache, input.forceRefresh === true);
        }
        catch (error) {
            return this.staleSeedOrFailure('offline', registryUrl, cache, `Marketplace registry is offline. ${formatError(error)}`);
        }
        if (response.status === 304) {
            if (!cache) {
                return {
                    ok: false,
                    state: 'fetch-error',
                    registryUrl,
                    stale: false,
                    statusCode: response.status,
                    message: 'Marketplace registry returned 304 Not Modified, but no usable cache exists.',
                };
            }
            return registrySuccess(registryUrl, cache.marketplace, {
                source: 'cache',
                stale: false,
                fetchedAt: cache.fetchedAt,
                etag: cache.etag,
                notModified: true,
            });
        }
        if (!response.ok) {
            const message = `Marketplace registry fetch failed with HTTP ${response.status}.`;
            if (response.status === 404 || isTransientStatus(response.status)) {
                return this.staleSeedOrFailure('fetch-error', registryUrl, cache, message, response.status);
            }
            return {
                ok: false,
                state: 'fetch-error',
                registryUrl,
                stale: false,
                statusCode: response.status,
                message,
            };
        }
        let source;
        try {
            source = await response.text();
        }
        catch (error) {
            return this.staleSeedOrFailure('offline', registryUrl, cache, `Marketplace registry response could not be read. ${formatError(error)}`);
        }
        const parsed = parseMarketplaceIndex(source);
        if (!parsed.ok) {
            return {
                ok: false,
                state: 'invalid-schema',
                registryUrl,
                stale: false,
                issues: parsed.issues,
                message: 'Marketplace registry returned invalid marketplace.json.',
            };
        }
        const etag = response.headers.get('etag') ?? undefined;
        const fetchedAt = this.now().toISOString();
        await this.writeCache({
            schemaVersion: 1,
            registryUrl,
            ...(etag ? { etag } : {}),
            fetchedAt,
            marketplace: parsed.marketplace,
        });
        return registrySuccess(registryUrl, parsed.marketplace, {
            source: 'network',
            stale: false,
            fetchedAt,
            etag,
        });
    }
    async fetchWithTimeout(url, cache, forceRefresh) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        const headers = { accept: 'application/json' };
        if (!forceRefresh && cache?.etag)
            headers['if-none-match'] = cache.etag;
        return this.fetcher(url.toString(), {
            method: 'GET',
            headers,
            signal: controller.signal,
        }).finally(() => clearTimeout(timeout));
    }
    async readCache(registryUrl) {
        try {
            const payload = JSON.parse(await readFile(this.cachePath, 'utf8'));
            if (payload.schemaVersion !== 1)
                return null;
            if (payload.registryUrl !== registryUrl)
                return null;
            if (typeof payload.fetchedAt !== 'string')
                return null;
            const result = validateMarketplaceIndex(payload.marketplace);
            if (!result.ok)
                return null;
            return {
                schemaVersion: 1,
                registryUrl,
                ...(typeof payload.etag === 'string' && payload.etag.length > 0 ? { etag: payload.etag } : {}),
                fetchedAt: payload.fetchedAt,
                marketplace: result.marketplace,
            };
        }
        catch {
            return null;
        }
    }
    async writeCache(cache) {
        await mkdir(dirname(this.cachePath), { recursive: true });
        await writeFile(this.cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
    }
    async staleSeedOrFailure(failureState, registryUrl, cache, message, statusCode) {
        if (cache) {
            return {
                ok: true,
                state: 'offline',
                registryUrl,
                source: 'cache',
                stale: true,
                fetchedAt: cache.fetchedAt,
                ...(cache.etag ? { etag: cache.etag } : {}),
                marketplace: cache.marketplace,
                message,
            };
        }
        const seed = await this.readPackagedSeed(registryUrl, message);
        if (seed)
            return seed;
        return {
            ok: false,
            state: failureState,
            registryUrl,
            stale: false,
            ...(statusCode ? { statusCode } : {}),
            message,
        };
    }
    /**
     * Read + validate the packaged seed, cached by file mtime: the seed is
     * immutable in packaged builds (and rarely regenerated in dev), while the
     * bundled-first default makes this a per-panel-open path — re-reading and
     * re-validating 258 icon-laden entries every call is pure waste. The mtime
     * doubles as the honest "data as of" timestamp for bundled reads.
     */
    async loadPackagedSeed() {
        const seedPath = this.resolvePackagedSeedPath();
        if (!seedPath)
            return null;
        let mtimeMs;
        try {
            mtimeMs = (await stat(seedPath)).mtimeMs;
        }
        catch {
            return null;
        }
        if (this.seedCache && this.seedCache.path === seedPath && this.seedCache.mtimeMs === mtimeMs) {
            return this.seedCache.result;
        }
        let result;
        try {
            const source = await readFile(seedPath, 'utf8');
            const parsed = parseMarketplaceIndex(source);
            result = parsed.ok
                ? { ok: true, marketplace: parsed.marketplace, dataAt: new Date(mtimeMs).toISOString() }
                : { ok: false, issues: parsed.issues };
        }
        catch {
            result = null;
        }
        this.seedCache = { path: seedPath, mtimeMs, result };
        return result;
    }
    /**
     * The bundled-default read: the packaged seed IS the registry, served as a
     * healthy result — never as an offline/degraded notice. `fetchedAt` is the
     * seed file's mtime, not now(): the data is as old as the build, and a
     * user-initiated refresh must not report frozen data as freshly fetched.
     * Returns null when the seed is missing or unparseable so read() can fall
     * through to the remote flow.
     */
    async readBundledSeed() {
        const seed = await this.loadPackagedSeed();
        if (!seed || !seed.ok)
            return null;
        return {
            ok: true,
            state: seed.marketplace.plugins.length > 0 ? 'ok' : 'empty',
            registryUrl: this.registryUrl.trim(),
            source: 'bundled',
            stale: false,
            fetchedAt: seed.dataAt,
            marketplace: seed.marketplace,
        };
    }
    async readPackagedSeed(registryUrl, failureMessage) {
        const seed = await this.loadPackagedSeed();
        if (!seed)
            return null;
        if (!seed.ok) {
            return {
                ok: false,
                state: 'invalid-schema',
                registryUrl,
                stale: false,
                issues: seed.issues,
                message: 'Packaged marketplace registry seed is invalid.',
            };
        }
        return {
            ok: true,
            state: 'offline',
            registryUrl,
            source: 'seed',
            stale: false,
            fetchedAt: this.now().toISOString(),
            marketplace: seed.marketplace,
            message: `${failureMessage} Showing packaged marketplace registry seed.`,
        };
    }
    resolvePackagedSeedPath() {
        if (!this.usePackagedSeedFallback)
            return null;
        if (this.packagedSeedPath !== undefined)
            return this.packagedSeedPath;
        return findMarketplaceResourcePath(MARKETPLACE_REGISTRY_SEED_FILENAME);
    }
}
function registrySuccess(registryUrl, marketplace, meta) {
    return {
        ok: true,
        state: marketplace.plugins.length > 0 ? 'ok' : 'empty',
        registryUrl,
        source: meta.source,
        stale: false,
        fetchedAt: meta.fetchedAt,
        ...(meta.etag ? { etag: meta.etag } : {}),
        ...(meta.notModified ? { notModified: true } : {}),
        marketplace,
    };
}
function parseHttpsUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:') {
            return { ok: false, message: 'Marketplace registry URL must use HTTPS.' };
        }
        return { ok: true, url };
    }
    catch {
        return { ok: false, message: 'Marketplace registry URL is invalid.' };
    }
}
function isTransientStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}
async function defaultFetch(url, init) {
    if (typeof globalThis.fetch !== 'function') {
        throw new Error('fetch is not available in this runtime.');
    }
    return globalThis.fetch(url, init);
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
