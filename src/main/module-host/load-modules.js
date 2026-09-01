import { MODULE_NOTIFICATIONS_RECENT_CHANNEL, sanitizeNotificationText, } from '../../shared/modules/notifications';
import { resolveModuleEnablement } from '../../shared/modules/resolve';
import { createMainKernel } from './main-host';
// Resolve enablement, then register each enabled module through the kernel in
// dependency-safe order. A module whose `registerMain` throws is recorded as an
// error and skipped — one bad module must not abort the rest of startup.
//
// `provideServices` runs first (on a synthetic host) so the host's existing
// services — terminal runtime, token stores — are available for modules to
// requireService before any module registers.
export function loadMainModules(options) {
    const { ipcMain, modules, overrides = {}, provideServices, ineligible, launchErrors = [] } = options;
    const byId = new Map(modules.map((module) => [module.manifest.id, module]));
    const resolution = resolveModuleEnablement(modules.map((module) => module.manifest), overrides, { ineligible });
    const kernel = createMainKernel(ipcMain, {
        deliverNotification: options.deliverNotification,
        deliverModuleEvent: options.deliverModuleEvent,
        now: options.now,
        resolveModuleManifest: (moduleId) => byId.get(moduleId)?.manifest,
    });
    const hostScope = kernel.hostFor('@host');
    hostScope.registerIpc(MODULE_NOTIFICATIONS_RECENT_CHANNEL, () => kernel.recentNotifications());
    provideServices?.(hostScope);
    const loaded = [];
    const manifestOnly = [];
    const errors = launchErrors.concat(resolution.errors.map((error) => ({
        id: error.id,
        message: error.message,
    })));
    const activeMainModules = new Set();
    const activeManifestOnlyModules = new Set();
    for (const id of resolution.order) {
        const module = byId.get(id);
        if (!module)
            continue;
        if (!module.registerMain) {
            manifestOnly.push(id);
            activeManifestOnlyModules.add(id);
            continue;
        }
        try {
            module.registerMain(kernel.hostFor(id));
            loaded.push(id);
            activeMainModules.add(id);
        }
        catch (err) {
            errors.push({ id, message: err instanceof Error ? err.message : String(err) });
        }
    }
    // Blocked or failed third-party modules graduate from log lines to
    // user-visible status: every load error attributable to an installed
    // third-party module becomes an error notification under that module's
    // identity. Manifest-rejection launch errors are keyed by file path, not
    // module id, so they stay out (no identity to stamp, and the path would
    // leak the install location). Bundled-module failures remain log-only.
    for (const loadError of errors) {
        if (byId.get(loadError.id)?.manifest.source !== 'third-party')
            continue;
        kernel.emitNotification(loadError.id, {
            severity: 'error',
            title: `Module "${loadError.id}" failed to load`,
            body: sanitizeNotificationText(loadError.message, 'Module startup failed.'),
        });
    }
    return {
        report: { loaded, manifestOnly, disabled: resolution.disabled, errors, sidecars: kernel.sidecars() },
        kernel,
        async applyEnablement(nextOverrides, liveOptions) {
            const liveModuleIds = new Set(liveOptions.liveModuleIds);
            const liveErrors = [];
            const nextResolution = resolveModuleEnablement(modules.map((module) => module.manifest), nextOverrides, { ineligible });
            const nextEnabled = new Set(nextResolution.order);
            for (const error of nextResolution.errors) {
                if (liveModuleIds.has(error.id))
                    liveErrors.push({ id: error.id, message: error.message });
            }
            const currentLiveOrder = modules.map((module) => module.manifest.id).filter((id) => liveModuleIds.has(id));
            for (const id of [...currentLiveOrder].reverse()) {
                if (!activeMainModules.has(id) || nextEnabled.has(id))
                    continue;
                await kernel.unregisterModule(id);
                activeMainModules.delete(id);
            }
            for (const id of [...activeManifestOnlyModules]) {
                if (!liveModuleIds.has(id) || nextEnabled.has(id))
                    continue;
                activeManifestOnlyModules.delete(id);
            }
            for (const id of nextResolution.order) {
                if (!liveModuleIds.has(id) || activeMainModules.has(id) || activeManifestOnlyModules.has(id))
                    continue;
                const module = byId.get(id);
                if (!module)
                    continue;
                if (!module.registerMain) {
                    activeManifestOnlyModules.add(id);
                    continue;
                }
                try {
                    module.registerMain(kernel.hostFor(id));
                    activeMainModules.add(id);
                    if (kernel.isStarted())
                        await kernel.runStartupForModule(id);
                }
                catch (err) {
                    await kernel.unregisterModule(id);
                    activeMainModules.delete(id);
                    liveErrors.push({ id, message: err instanceof Error ? err.message : String(err) });
                }
            }
            return {
                loaded: [...activeMainModules].filter((id) => liveModuleIds.has(id)).sort(),
                disabled: [...liveModuleIds].filter((id) => !nextEnabled.has(id)).sort(),
                errors: liveErrors,
            };
        },
    };
}
