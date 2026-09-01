import type { MarketplaceRegistryReadInput, MarketplaceRegistryReadResult, MarketplaceUpdateStatesResult } from '../../shared/electron-api';
import type { ModuleTrustContext } from '../modules/module-signature';
export type MarketplaceUpdateStatesServices = {
    registryReader: {
        read(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult>;
    };
    receiptStorePath: string;
    moduleRoot: () => string;
    trustContext: () => ModuleTrustContext;
};
export declare function readMarketplaceUpdateStates(services: MarketplaceUpdateStatesServices, input?: MarketplaceRegistryReadInput): Promise<MarketplaceUpdateStatesResult>;
