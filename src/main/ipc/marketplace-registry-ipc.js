import { app } from 'electron';
import { MarketplaceRegistryClient, configuredMarketplaceRegistryUrl, defaultMarketplaceRegistryCachePath, isMarketplaceRegistryOverrideConfigured, } from '../marketplace/registry-client';
export function createMarketplaceRegistryIpcHandlers(reader = createDefaultMarketplaceRegistryClient()) {
    return {
        read(input) {
            return reader.read(input);
        },
    };
}
export function registerMarketplaceRegistryIpc(ipcMain, overrides = {}) {
    const handlers = {
        read: overrides.read ?? createMarketplaceRegistryIpcHandlers().read,
    };
    ipcMain.handle('marketplace:registry:read', async (_event, input) => {
        const readInput = validateReadInput(input);
        if (!readInput.ok)
            return readInput.result;
        try {
            return await handlers.read(readInput.input);
        }
        catch (error) {
            return {
                ok: false,
                state: 'fetch-error',
                registryUrl: configuredMarketplaceRegistryUrl(),
                stale: false,
                message: formatError(error),
            };
        }
    });
}
// Also the registry reader the update-state detection uses
// (marketplace-plugin-ipc), so both surfaces share one cache and one
// bundled-first/override policy.
export function createDefaultMarketplaceRegistryClient() {
    return new MarketplaceRegistryClient({
        registryUrl: configuredMarketplaceRegistryUrl(),
        cachePath: defaultMarketplaceRegistryCachePath(app.getPath('userData')),
        // No override -> the committed snapshot-generated seed is the registry;
        // the env override keeps the full remote fetch/ETag/cache path.
        preferBundledSeed: !isMarketplaceRegistryOverrideConfigured(),
    });
}
function validateReadInput(input) {
    if (input === undefined)
        return { ok: true };
    if (!isObject(input))
        return invalidReadInputResult();
    if ('forceRefresh' in input && typeof input.forceRefresh !== 'boolean')
        return invalidReadInputResult();
    return { ok: true, input: { ...(typeof input.forceRefresh === 'boolean' ? { forceRefresh: input.forceRefresh } : {}) } };
}
function invalidReadInputResult() {
    return {
        ok: false,
        result: {
            ok: false,
            state: 'fetch-error',
            registryUrl: configuredMarketplaceRegistryUrl(),
            stale: false,
            message: 'Invalid marketplace registry read input.',
        },
    };
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
