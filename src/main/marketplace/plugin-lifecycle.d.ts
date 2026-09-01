import type { MarketplacePluginInstalledComponent, MarketplacePluginRegistryInstallInput, MarketplacePluginRegistryInstallResult, MarketplacePluginUninstallInput, MarketplacePluginUninstallResult } from '../../shared/electron-api';
import type { SkillHarness } from '../../shared/electron-api';
import { type MarketplacePluginInstallerServices } from '../modules/plugin-bundle-installer';
import { type MarketplaceInstallLog, type MarketplacePluginDownloadFetch } from './plugin-download';
import type { MarketplaceResourceResolver } from './resources';
export declare const MARKETPLACE_PLUGIN_INSTALLS_FILENAME = "marketplace-plugin-installs.json";
export type MarketplacePluginInstallReceipt = {
    id: string;
    displayName: string;
    version: number;
    sourceUrl: string;
    classification: 'verified' | 'community' | 'unsigned';
    installedAt: string;
    components: MarketplacePluginInstalledComponent[];
};
export type MarketplacePluginLifecycleServices = MarketplacePluginInstallerServices & {
    receiptStorePath: string;
    stagingRoot?: string;
    fetcher?: MarketplacePluginDownloadFetch;
    /**
     * Harness dirs a Claude-plugin skill install fans out to when the caller
     * passes no explicit `skillHarnesses` (see resolveInstalledSkillHarnesses).
     * Absent, installs fall back to Claude-only.
     */
    resolveSkillHarnesses?: () => Promise<SkillHarness[]>;
    /** Test seam for packaged resource resolution (bundled claude-plugin skills). */
    packagedResourceResolver?: MarketplaceResourceResolver;
    /**
     * Trust-store writer for module components (id → manifest fingerprint; null
     * revokes), delegating to modules/trust-store.ts so there is still exactly
     * one writer of that file. Grants happen only after a whole bundle installs;
     * uninstalling a module component revokes its entry. The returned `previous`
     * is what the id mapped to before the write, so a failed receipt write can
     * put the trust store back as it was. Absent, installs still succeed and the
     * module simply stays awaiting-trust in Settings → Modules.
     */
    setModuleTrust?: (id: string, manifestFp: string | null) => Promise<{
        ok: boolean;
        message?: string;
        previous?: string | null;
    }>;
    log?: MarketplaceInstallLog;
};
export declare function defaultMarketplacePluginInstallStorePath(userDataDir: string): string;
export declare function createMarketplacePluginLifecycleService(services: MarketplacePluginLifecycleServices): {
    installFromRegistry: (input: MarketplacePluginRegistryInstallInput) => Promise<MarketplacePluginRegistryInstallResult>;
    updateFromRegistry: (input: MarketplacePluginRegistryInstallInput) => Promise<MarketplacePluginRegistryInstallResult>;
    uninstall: (input: MarketplacePluginUninstallInput) => Promise<MarketplacePluginUninstallResult>;
};
export declare function readMarketplacePluginInstallReceipts(receiptStorePath: string): Promise<{
    ok: true;
    receipts: MarketplacePluginInstallReceipt[];
} | {
    ok: false;
    message: string;
}>;
export declare function installOrUpdateMarketplacePlugin(input: MarketplacePluginRegistryInstallInput, services: MarketplacePluginLifecycleServices): Promise<MarketplacePluginRegistryInstallResult>;
export declare function uninstallMarketplacePlugin(input: MarketplacePluginUninstallInput, services: MarketplacePluginLifecycleServices): Promise<MarketplacePluginUninstallResult>;
