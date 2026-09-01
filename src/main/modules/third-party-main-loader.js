import { createRequire } from 'node:module';
import { resolveContainedEntry, sanitizeEntryMessage } from './entry-containment';
import { isLoadEligible } from './module-signature';
let launchSnapshot = {
    loaded: new Set(),
    manifestOnly: new Set(),
    errors: new Map(),
};
export function planThirdPartyMainModules(input) {
    const modules = [];
    const ineligible = {};
    for (const installed of input.modules) {
        modules.push(createThirdPartyMainModule(installed));
        if (isLoadEligible(installed.trust.status))
            continue;
        ineligible[installed.manifest.id] = installed.trust.status === 'invalid' ? 'invalid_signature' : 'untrusted';
    }
    return {
        modules,
        ineligible,
        launchErrors: input.rejected.map(rejectionToLoadError),
        diagnostics: { rejected: input.rejected },
    };
}
export function recordThirdPartyMainLaunchReport(moduleIds, report) {
    const thirdPartyIds = new Set(moduleIds);
    launchSnapshot = {
        loaded: new Set(report.loaded.filter((id) => thirdPartyIds.has(id))),
        manifestOnly: new Set(report.manifestOnly.filter((id) => thirdPartyIds.has(id))),
        errors: new Map(report.errors
            .filter((error) => thirdPartyIds.has(error.id))
            .map((error) => [error.id, sanitizeLaunchMessage(error.message)])),
    };
}
export function readThirdPartyMainLaunchSnapshot() {
    return launchSnapshot;
}
function rejectionToLoadError(rejection) {
    return {
        id: rejection.path,
        message: rejection.issues
            .map((issue) => `${issue.path ? `${issue.path}: ` : ''}${issue.message}`)
            .join('; '),
    };
}
function sanitizeLaunchMessage(message) {
    return sanitizeEntryMessage(message, 'Module main entry failed during startup.');
}
function createThirdPartyMainModule(installed) {
    const entryMain = installed.manifest.entry?.main;
    if (!isLoadEligible(installed.trust.status) || !entryMain) {
        return { manifest: installed.manifest };
    }
    return {
        manifest: installed.manifest,
        registerMain: (host) => {
            loadTrustedEntry(installed.moduleRoot, entryMain, host);
        },
    };
}
function loadTrustedEntry(moduleRoot, entryMain, host) {
    const entryPath = resolveContainedEntry(moduleRoot, entryMain, 'entry.main');
    const entryModule = createRequire(`${entryPath}.loader.cjs`)(entryPath);
    const registerMain = resolveRegisterMain(entryModule);
    registerMain(host);
}
function resolveRegisterMain(entryModule) {
    if (typeof entryModule.registerMain === 'function') {
        return entryModule.registerMain;
    }
    if (entryModule.default &&
        typeof entryModule.default === 'object' &&
        typeof entryModule.default.registerMain === 'function') {
        return entryModule.default.registerMain;
    }
    throw new Error('entry.main must export a callable registerMain(host).');
}
