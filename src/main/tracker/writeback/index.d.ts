import type { TrackerWriteBackNotice } from '../../../shared/tracker/writeback';
import { type TrackerProviderRegistry } from '../provider-registry';
import { TrackerWriteBackConfigStore } from './config-store';
import { TrackerWriteBackEngine } from './engine';
import { TrackerWriteBackLedger } from './ledger';
import { type WriteBackProjectionReader } from './run-state-reader';
export { TrackerWriteBackConfigStore } from './config-store';
export { TrackerWriteBackLedger } from './ledger';
export { TrackerWriteBackEngine } from './engine';
export type { ReconcileSummary } from './engine';
export type TrackerWriteBackRuntime = {
    engine: TrackerWriteBackEngine;
    configStore: TrackerWriteBackConfigStore;
    ledger: TrackerWriteBackLedger;
    notifyRunActivity(statePath: string): void;
    retryConnectionNotices(connectionId: string): Promise<TrackerWriteBackNotice[]>;
};
export type CreateTrackerWriteBackRuntimeOptions = {
    readProjection: WriteBackProjectionReader['readProjection'];
    registry?: TrackerProviderRegistry;
    resolveUserDataDir?: () => string;
    now?: () => Date;
    logDiagnostic?: (event: string, payload: Record<string, unknown>) => void;
};
export declare function createTrackerWriteBackRuntime(options: CreateTrackerWriteBackRuntimeOptions): TrackerWriteBackRuntime;
export declare function workspaceRootFromStatePath(statePath: string): string | null;
