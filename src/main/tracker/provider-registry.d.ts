import type { TrackerProvider, TrackerProviderId } from '../../shared/tracker/types';
export declare class TrackerProviderRegistry {
    private readonly providers;
    register(provider: TrackerProvider): void;
    get(provider: TrackerProviderId): TrackerProvider | undefined;
    has(provider: TrackerProviderId): boolean;
}
export declare function getSharedTrackerProviderRegistry(): TrackerProviderRegistry;
export declare function registerTrackerProvider(provider: TrackerProvider): void;
