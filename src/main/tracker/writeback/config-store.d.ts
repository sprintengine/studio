import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { type TrackerWriteBackConfig } from '../../../shared/tracker/writeback';
type FileAdapter = {
    mkdir: typeof mkdir;
    readFile: typeof readFile;
    writeFile: typeof writeFile;
    rename: typeof rename;
};
export type TrackerWriteBackConfigStoreOptions = {
    resolveUserDataDir?: () => string;
    files?: FileAdapter;
};
export declare class TrackerWriteBackConfigStore {
    private readonly resolveUserDataDir;
    private readonly files;
    private byConnection;
    constructor(options?: TrackerWriteBackConfigStoreOptions);
    get(connectionId: string): Promise<TrackerWriteBackConfig>;
    list(): Promise<Record<string, TrackerWriteBackConfig>>;
    set(connectionId: string, config: TrackerWriteBackConfig): Promise<void>;
    remove(connectionId: string): Promise<void>;
    anyActive(): Promise<boolean>;
    private ensureLoaded;
    private read;
    private persist;
    private storePath;
}
export declare function getSharedTrackerWriteBackConfigStore(): TrackerWriteBackConfigStore;
export {};
