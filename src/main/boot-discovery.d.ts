import type { SplashProgress } from '../shared/electron-api';
export type BootDiscoveryLegId = 'cli' | 'editors' | 'updates';
export type BootDiscoveryDeps = {
    detectClis?: () => Promise<unknown>;
    detectEditors?: () => Promise<unknown>;
    checkUpdates?: () => Promise<unknown>;
    onProgress?: (update: SplashProgress) => void;
    onLegError?: (leg: BootDiscoveryLegId, error: unknown) => void;
};
export declare function runBootDiscovery(deps?: BootDiscoveryDeps): Promise<void>;
