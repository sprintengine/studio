import { app } from 'electron';
import { readTrustedMarketplacePublisherFingerprintsSync } from '../marketplace/trusted-publishers';
import { readModuleOverridesSync } from '../module-host/enablement-store';
import { manifestFingerprint } from '../modules/module-signature';
import { readThirdPartyMainLaunchSnapshot } from '../modules/third-party-main-loader';
import { rendererEntryView } from '../modules/third-party-renderer-entries';
import { defaultUserModuleRoot, discoverUserModules, installModuleFolder, } from '../modules/user-module-registry';
import { readTrustedModulesSync, setModuleTrust } from '../modules/trust-store';
// Kernel-level IPC for the third-party module registry (Tier 2 trust
// foundation). Pure filesystem + crypto verification — it installs, validates,
// trust-classifies, and records trust. Startup execution is owned by the
// trusted third-party main loader; this IPC only reports launch readiness.
export function registerThirdPartyModuleIpc(ipcMain) {
    const trustContext = () => ({
        trustedModules: readTrustedModulesSync(app.getPath('userData')),
        trustedKeyFingerprints: readTrustedMarketplacePublisherFingerprintsSync(),
    });
    ipcMain.handle('modules:third-party:list', async () => {
        const { modules, rejected } = await discoverUserModules(defaultUserModuleRoot(), trustContext());
        const launchSnapshot = readThirdPartyMainLaunchSnapshot();
        const enablementOverrides = readModuleOverridesSync(app.getPath('userData'));
        return {
            modules: modules.map((module) => toThirdPartyModuleView(module, launchSnapshot, enablementOverrides)),
            rejected,
        };
    });
    ipcMain.handle('modules:third-party:install-folder', async (_event, srcDir) => {
        if (typeof srcDir !== 'string' || srcDir.trim().length === 0) {
            return { ok: false, message: 'No folder selected.' };
        }
        const result = await installModuleFolder(srcDir, defaultUserModuleRoot(), trustContext());
        if (!result.ok)
            return { ok: false, message: result.message, issues: result.rejected.issues };
        return { ok: true, id: result.id, trust: result.trust.status };
    });
    ipcMain.handle('modules:third-party:set-trust', async (_event, payload) => {
        if (!payload ||
            typeof payload !== 'object' ||
            typeof payload.id !== 'string' ||
            typeof payload.trusted !== 'boolean') {
            return { ok: false, message: 'Invalid trust request.' };
        }
        const { id, trusted } = payload;
        const userData = app.getPath('userData');
        if (!trusted) {
            const { result } = await setModuleTrust(userData, id, null);
            return { ok: result.ok, message: result.message };
        }
        // Bind trust to the *currently installed* manifest's fingerprint. Re-discover
        // so we trust exactly what's on disk now (not a stale renderer value).
        const { modules } = await discoverUserModules(defaultUserModuleRoot(), trustContext());
        const target = modules.find((module) => module.manifest.id === id);
        if (!target)
            return { ok: false, message: `Module "${id}" is not installed.` };
        if (target.trust.status === 'invalid') {
            return { ok: false, message: `Module "${id}" has an invalid signature and cannot be trusted.` };
        }
        const { result } = await setModuleTrust(userData, id, manifestFingerprint(target.manifest));
        return { ok: result.ok, message: result.message };
    });
}
export function toThirdPartyModuleView(module, launchSnapshot = readThirdPartyMainLaunchSnapshot(), enablementOverrides = {}) {
    return {
        manifest: module.manifest,
        trust: module.trust.status,
        fingerprint: module.trust.fingerprint,
        launch: launchViewFor(module, launchSnapshot, enablementOverrides),
    };
}
function launchViewFor(module, launchSnapshot, enablementOverrides) {
    return { ...mainEntryLaunchView(module, launchSnapshot, enablementOverrides), rendererEntry: rendererEntryView(module) };
}
function mainEntryLaunchView(module, launchSnapshot, enablementOverrides) {
    const id = module.manifest.id;
    const hasMainEntry = Boolean(module.manifest.entry?.main);
    if (module.trust.status === 'invalid') {
        return {
            status: 'blocked_invalid',
            hasMainEntry,
            expectedToLoad: false,
            message: 'Invalid signature blocks startup execution.',
        };
    }
    if (module.trust.status === 'signed') {
        return {
            status: 'blocked_signed',
            hasMainEntry,
            expectedToLoad: false,
            message: 'Signed module is waiting for trust before startup execution.',
        };
    }
    if (module.trust.status === 'unsigned') {
        return {
            status: 'blocked_unsigned',
            hasMainEntry,
            expectedToLoad: false,
            message: 'Unsigned module is waiting for trust before startup execution.',
        };
    }
    if (!hasMainEntry) {
        return {
            status: 'trusted_manifest_only',
            hasMainEntry,
            expectedToLoad: false,
            message: 'Trusted manifest-only module; no main entry will run.',
        };
    }
    const launchError = launchSnapshot.errors.get(id);
    if (launchError) {
        return {
            status: 'launch_error',
            hasMainEntry,
            expectedToLoad: false,
            message: launchError,
        };
    }
    const expectedToLoad = enablementOverrides[id] ?? module.manifest.defaultEnabled;
    return {
        status: 'trusted_executable',
        hasMainEntry,
        expectedToLoad,
        message: expectedToLoad
            ? 'Trusted main entry is eligible for startup execution.'
            : module.manifest.defaultEnabled
                ? 'Trusted main entry is disabled by user setting until enabled.'
                : 'Trusted main entry is disabled by default until enabled.',
    };
}
