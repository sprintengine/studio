import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import type { TrackerProviderId } from '../../../shared/tracker/types';
import type { TrackerWriteBackNotice, TrackerWriteBackPostKind } from '../../../shared/tracker/writeback';
type FileAdapter = {
    mkdir: typeof mkdir;
    readFile: typeof readFile;
    writeFile: typeof writeFile;
    rename: typeof rename;
};
export type TrackerWriteBackLedgerOptions = {
    resolveUserDataDir?: () => string;
    files?: FileAdapter;
    now?: () => Date;
    runStateExists?: (statePath: string) => Promise<boolean>;
};
export type LedgerPostMeta = {
    key: string;
    statePath: string;
    connectionId: string;
    externalId: string;
    provider: TrackerProviderId;
    postKind: TrackerWriteBackPostKind;
    relativePath: string;
    at: string;
    message?: string;
};
export declare class TrackerWriteBackLedger {
    private readonly resolveUserDataDir;
    private readonly files;
    private readonly now;
    private readonly runStateExists;
    private entries;
    private writeTail;
    constructor(options?: TrackerWriteBackLedgerOptions);
    hasPosted(key: string): Promise<boolean>;
    markPosted(meta: LedgerPostMeta): Promise<void>;
    recordFailure(meta: LedgerPostMeta): Promise<void>;
    dropConnection(connectionId: string): Promise<void>;
    failedStatePaths(connectionId: string): Promise<string[]>;
    listNotices(): Promise<TrackerWriteBackNotice[]>;
    private mutate;
    private ensureLoaded;
    private read;
    private evictStale;
    private isEvictable;
    private persist;
    private storePath;
}
export declare function getSharedTrackerWriteBackLedger(): TrackerWriteBackLedger;
export {};
