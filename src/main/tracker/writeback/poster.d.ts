import type { TrackerProviderRegistry } from '../provider-registry';
import type { TrackerWriteBackPoster, WriteBackCapabilityResolver } from './engine';
export declare function createTrackerWriteBackPoster(registry: TrackerProviderRegistry): TrackerWriteBackPoster;
export declare function createWriteBackCapabilityResolver(registry: TrackerProviderRegistry): WriteBackCapabilityResolver;
