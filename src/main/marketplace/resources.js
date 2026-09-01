import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
export function findMarketplaceResourcePath(relativePath, options = {}) {
    const exists = options.exists ?? existsSync;
    return marketplaceResourceCandidates(relativePath, options).find((candidate) => exists(candidate)) ?? null;
}
export function marketplaceResourceCandidates(relativePath, options = {}) {
    const safeRelativePath = normalizeMarketplaceRelativePath(relativePath);
    if (!safeRelativePath)
        return [];
    const electron = loadElectron();
    const app = electron?.app;
    const isPackaged = options.isPackaged ?? app?.isPackaged ?? false;
    const resourcesPath = options.resourcesPath ?? process.resourcesPath;
    const appPath = Object.prototype.hasOwnProperty.call(options, 'appPath')
        ? options.appPath ?? null
        : app?.getAppPath?.() ?? null;
    const cwd = options.cwd ?? process.cwd();
    const dirname = options.dirname ?? __dirname;
    if (isPackaged) {
        return [
            ...(resourcesPath ? [join(resourcesPath, 'marketplace', safeRelativePath)] : []),
            ...(appPath ? [join(appPath, 'resources', 'marketplace', safeRelativePath)] : []),
        ];
    }
    return [
        join(cwd, 'resources', 'marketplace', safeRelativePath),
        ...(appPath ? [join(appPath, 'resources', 'marketplace', safeRelativePath)] : []),
        join(dirname, '..', '..', 'resources', 'marketplace', safeRelativePath),
        join(dirname, '..', '..', '..', 'resources', 'marketplace', safeRelativePath),
    ];
}
function normalizeMarketplaceRelativePath(relativePath) {
    if (isAbsolute(relativePath))
        return null;
    const normalized = normalize(relativePath).replace(/\\/g, '/');
    if (!normalized || normalized === '.' || normalized === '..')
        return null;
    if (normalized.startsWith('../') || normalized.includes('/../'))
        return null;
    return normalized;
}
function loadElectron() {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('electron');
    }
    catch {
        return null;
    }
}
