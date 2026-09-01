import { type ProviderSecretStoreOptions, type ProviderSecretValueResult } from '../secret-store';
import type { RedactedTrackerConnection, TrackerAddConnectionInput, TrackerCapabilities, TrackerConnection, TrackerConnectionDraft, TrackerConnectionProbe, TrackerProviderId } from '../../shared/tracker/types';
type FileAdapter = Pick<NonNullable<ProviderSecretStoreOptions['files']>, 'mkdir' | 'readFile' | 'writeFile' | 'unlink'>;
export type TrackerConnectionStoreOptions = {
    resolveUserDataDir?: () => string;
    files?: FileAdapter;
    safeStorage?: ProviderSecretStoreOptions['safeStorage'];
    env?: NodeJS.ProcessEnv;
    generateConnectionId?: () => string;
    resolveCapabilities?: (provider: TrackerProviderId) => TrackerCapabilities | undefined;
};
export declare class TrackerConnectionStore {
    private readonly resolveUserDataDir;
    private readonly files;
    private readonly generateId;
    private readonly resolveCapabilities;
    private readonly secretStore;
    private connections;
    private readonly draftConnections;
    private readonly draftSecrets;
    private readonly probeCache;
    constructor(options?: TrackerConnectionStoreOptions);
    list(): Promise<RedactedTrackerConnection[]>;
    getConnection(id: string): Promise<TrackerConnection | undefined>;
    add(input: TrackerAddConnectionInput): Promise<RedactedTrackerConnection>;
    remove(id: string): Promise<void>;
    resolveSecret(id: string): Promise<ProviderSecretValueResult>;
    recordProbe(id: string, probe: TrackerConnectionProbe): void;
    withDraftConnection<T>(draft: TrackerConnectionDraft, fn: (connectionId: string) => Promise<T>): Promise<T>;
    private redact;
    private resolveStatus;
    private resolveTrackerAuthOwner;
    private ensureLoaded;
    private readPersisted;
    private persist;
    private storePath;
}
export {};
