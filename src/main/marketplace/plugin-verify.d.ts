import type { MarketplacePluginEntry } from '../../shared/marketplace';
import type { MarketplacePluginVerifyResult } from '../../shared/electron-api';
import type { ModuleTrustContext } from '../modules/module-signature';
import { type MarketplaceInstallLog, type MarketplacePluginDownloadFetch } from './plugin-download';
import type { MarketplaceResourceResolver } from './resources';
export type MarketplacePluginVerifierServices = {
    trustContext: () => ModuleTrustContext;
    stagingRoot?: string;
    fetcher?: MarketplacePluginDownloadFetch;
    /** Test seam for packaged resource resolution (bundled claude-plugin skills). */
    packagedResourceResolver?: MarketplaceResourceResolver;
    log?: MarketplaceInstallLog;
};
export declare function createMarketplacePluginVerifier(services: MarketplacePluginVerifierServices): {
    verify: (entry: MarketplacePluginEntry) => Promise<MarketplacePluginVerifyResult>;
};
export declare function verifyMarketplacePlugin(entry: MarketplacePluginEntry, services: MarketplacePluginVerifierServices): Promise<MarketplacePluginVerifyResult>;
