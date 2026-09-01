import { existsSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { createPluginRegistry, defaultUserPluginRoot, } from './plugin-registry';
import { readTrustedModulesSync } from './modules/trust-store';
// Lazy require so this module can be imported in node-only test bundles
// that never reach the `ensureRegistry()` call. The electron `app` module
// throws on import in plain node.
function loadElectron() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('electron');
}
// Lazy-initialized singleton plugin registry for the main process. The launch
// path needs synchronous access to plugin manifests; this module loads them
// once on first use from the appropriate bundled-resource location.
let registry = null;
let lastReport = null;
let configuredUserRoot = null;
export function resolveBundledPluginRoot() {
    const electron = loadElectron();
    if (electron.app.isPackaged) {
        const packaged = join(process.resourcesPath, 'plugins');
        if (existsSync(packaged))
            return packaged;
    }
    const candidates = [
        join(process.cwd(), 'resources', 'plugins'),
        join(electron.app.getAppPath(), 'resources', 'plugins'),
        join(__dirname, '..', '..', 'resources', 'plugins'),
        join(__dirname, '..', '..', '..', 'resources', 'plugins'),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    return candidates[0];
}
function ensureRegistry() {
    if (registry)
        return registry;
    const userRoot = defaultUserPluginRoot();
    registry = createPluginRegistry(createAppPluginRegistryOptions(loadElectron().app.getPath('userData'), resolveBundledPluginRoot(), userRoot));
    configuredUserRoot = userRoot;
    lastReport = registry.loadSync();
    return registry;
}
export function createAppPluginRegistryOptions(userDataDir, bundledRoot = resolveBundledPluginRoot(), userRoot = defaultUserPluginRoot()) {
    return {
        bundledRoot,
        userRoot,
        providerTrustContext: {
            trustedModules: readTrustedModulesSync(userDataDir),
        },
    };
}
export function getPluginRegistry() {
    return ensureRegistry();
}
/**
 * Re-scan the bundled and user plugin roots so a plugin installed (or removed)
 * while the app is running is reflected without a restart. Used by the
 * `plugins:install-folder` / `plugins:reload` IPC after a drop-in change.
 */
export function reloadPluginRegistry() {
    const reg = ensureRegistry();
    lastReport = reg.loadSync();
    return lastReport;
}
export function getPluginById(id) {
    return ensureRegistry().get(id);
}
export function getPluginManifest(id) {
    return ensureRegistry().get(id)?.manifest;
}
export function listPluginRegistryEntries() {
    return ensureRegistry().list();
}
export function listConversationProviderRegistryEntries() {
    return ensureRegistry().listConversationProviders();
}
export function getConversationProviderById(id) {
    return ensureRegistry().getConversationProvider(id);
}
export function getLastPluginRegistryReport() {
    ensureRegistry();
    return lastReport;
}
export function getPluginRegistryUserRoot() {
    ensureRegistry();
    return configuredUserRoot ?? defaultUserPluginRoot();
}
export function getPluginSprintEngineRegistryRoots() {
    return ensureRegistry().loaded().flatMap((plugin) => {
        const soulsDirectory = plugin.manifest.souls?.directory;
        if (!soulsDirectory)
            return [];
        const root = resolve(plugin.pluginRoot, soulsDirectory);
        if (!isPathInsideOrEqual(plugin.pluginRoot, root))
            return [];
        return [{ id: plugin.manifest.id, root }];
    });
}
// Test-only: lets unit tests substitute a registry built from a fixture root.
export function __setPluginRegistryForTest(custom, report, userRoot) {
    registry = custom;
    lastReport = report;
    configuredUserRoot = userRoot ?? defaultUserPluginRoot();
}
export function __resetPluginRegistryForTest() {
    registry = null;
    lastReport = null;
    configuredUserRoot = null;
}
function isPathInsideOrEqual(parentPath, targetPath) {
    const relativePath = relative(resolve(parentPath), resolve(targetPath));
    return (relativePath === ''
        || (!relativePath.startsWith('..') && !isAbsolute(relativePath) && !relativePath.split(sep).includes('..')));
}
