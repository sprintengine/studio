import { app } from 'electron';
import { writeDiagnosticLog } from '../diagnostics-service';
import { createMarketplacePluginLifecycleService, defaultMarketplacePluginInstallStorePath } from '../marketplace/plugin-lifecycle';
import { readMarketplaceUpdateStates } from '../marketplace/update-detection';
import { defaultUserModuleRoot } from '../modules/user-module-registry';
import { createDefaultMarketplaceRegistryClient } from './marketplace-registry-ipc';
import { defaultMarketplacePluginStagingRoot } from '../marketplace/plugin-download';
import { createMarketplacePluginVerifier } from '../marketplace/plugin-verify';
import { resolveInstalledSkillHarnesses } from '../marketplace/skill-harness-targets';
import { readTrustedMarketplacePublisherFingerprintsSync } from '../marketplace/trusted-publishers';
import { createMarketplacePluginInstaller } from '../modules/plugin-bundle-installer';
import { readTrustedModulesSync, setModuleTrust } from '../modules/trust-store';
export function registerMarketplacePluginIpc(ipcMain, services) {
    const trustContext = () => ({
        trustedModules: readTrustedModulesSync(app.getPath('userData')),
        trustedKeyFingerprints: readTrustedMarketplacePublisherFingerprintsSync(),
    });
    // Verify/install failures used to be invisible (result objects only, no
    // logging anywhere) — every pipeline event now lands in the diagnostics
    // log and the main-process console.
    const marketplaceLog = (event, detail) => {
        const details = detail === undefined ? undefined : JSON.stringify(detail);
        console.log(`[marketplace] ${event}${details ? ` ${details}` : ''}`);
        void writeDiagnosticLog({
            level: event.includes('fail') || event.includes('mismatch') ? 'error' : 'info',
            source: 'marketplace',
            title: 'Marketplace plugin pipeline',
            message: event,
            ...(details ? { details } : {}),
        }).catch(() => undefined);
    };
    // An automation component installs through the Automations module's own front
    // door — the app's single write path for definitions. The module registers
    // after app services are built and can be switched off, so it is resolved at
    // call time and its absence is an explicit failure, never a silent skip.
    const installAutomationDefinition = async (input) => {
        const frontDoor = services.getAutomationsAppFrontDoor();
        if (!frontDoor) {
            return { ok: false, code: 'automations_unavailable', message: 'The Automations module is not running.' };
        }
        const result = await frontDoor.installCatalogueDefinition(input);
        if (!result.ok)
            return result;
        return { ok: true, value: { definition: result.value.definition, alreadyAdded: result.value.alreadyAdded } };
    };
    const installPlugin = createMarketplacePluginInstaller({
        mcpConfigService: services.mcpConfigService,
        trustContext,
        installAutomationDefinition,
    });
    const verifier = createMarketplacePluginVerifier({
        trustContext,
        stagingRoot: defaultMarketplacePluginStagingRoot(app.getPath('userData')),
        log: marketplaceLog,
    });
    const lifecycle = createMarketplacePluginLifecycleService({
        mcpConfigService: services.mcpConfigService,
        trustContext,
        installAutomationDefinition,
        receiptStorePath: defaultMarketplacePluginInstallStorePath(app.getPath('userData')),
        stagingRoot: defaultMarketplacePluginStagingRoot(app.getPath('userData')),
        resolveSkillHarnesses: () => resolveInstalledSkillHarnesses(),
        // The trust decision the install prompt already took, written through the
        // one trust-store writer the Settings toggle uses — so a trusted install
        // does not land behind a second, identical toggle in Settings → Modules.
        setModuleTrust: async (id, manifestFp) => {
            const { result, previous } = await setModuleTrust(app.getPath('userData'), id, manifestFp);
            return { ...result, previous };
        },
        log: marketplaceLog,
    });
    ipcMain.handle('marketplace:plugins:install-folder', async (_event, input) => {
        try {
            return await installPlugin(input);
        }
        catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
    });
    ipcMain.handle('marketplace:plugins:verify', async (_event, entry) => {
        try {
            return await verifier.verify(entry);
        }
        catch (error) {
            return {
                classification: 'invalid',
                permissions: [],
                sourceUrl: typeof entry?.source === 'string' ? entry.source : '',
                issues: [{ path: 'source', message: error instanceof Error ? error.message : String(error) }],
                message: error instanceof Error ? error.message : String(error),
            };
        }
    });
    ipcMain.handle('marketplace:plugins:install-entry', async (_event, input) => {
        try {
            return await lifecycle.installFromRegistry(input);
        }
        catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
    });
    ipcMain.handle('marketplace:plugins:update-entry', async (_event, input) => {
        try {
            return await lifecycle.updateFromRegistry(input);
        }
        catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
    });
    // Per-installed-entry update detection (MC-1873). Constructed lazily so the
    // registry client (and its cache read) only exists once the surface asks.
    let updateStatesRegistryReader;
    ipcMain.handle('marketplace:plugins:update-states', async (_event, input) => {
        try {
            updateStatesRegistryReader ??= createDefaultMarketplaceRegistryClient();
            return await readMarketplaceUpdateStates({
                registryReader: updateStatesRegistryReader,
                receiptStorePath: defaultMarketplacePluginInstallStorePath(app.getPath('userData')),
                moduleRoot: defaultUserModuleRoot,
                trustContext,
            }, input ?? {});
        }
        catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
    });
    ipcMain.handle('marketplace:plugins:uninstall', async (_event, input) => {
        try {
            return await lifecycle.uninstall(input);
        }
        catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
    });
}
