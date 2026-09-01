export type MarketplaceResourceResolver = (relativePath: string) => string | null;
export type MarketplaceResourceResolutionOptions = {
    isPackaged?: boolean;
    resourcesPath?: string;
    appPath?: string | null;
    cwd?: string;
    dirname?: string;
    exists?: (path: string) => boolean;
};
export declare function findMarketplaceResourcePath(relativePath: string, options?: MarketplaceResourceResolutionOptions): string | null;
export declare function marketplaceResourceCandidates(relativePath: string, options?: MarketplaceResourceResolutionOptions): string[];
