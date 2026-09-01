import type { IpcMain } from 'electron';
import type { TrackerWriteBackRuntime } from '../tracker/writeback';
import { type TrackerWriteBackConfig, type TrackerWriteBackNotice } from '../../shared/tracker/writeback';
import { toTrackerError, type TrackerAddConnectionInput, type TrackerAddConnectionResult, type TrackerFetchIssueInput, type TrackerFetchIssueResult, type TrackerListConnectionsResult, type TrackerMaterializeInput, type TrackerMaterializeResult, type TrackerRemoveConnectionInput, type TrackerRemoveConnectionResult, type TrackerSearchInput, type TrackerSearchResult, type TrackerTestConnectionInput, type TrackerTestConnectionResult, type TrackerTransition } from '../../shared/tracker/types';
export type TrackerIpcService = {
    listConnections(): Promise<TrackerListConnectionsResult>;
    addConnection(input: TrackerAddConnectionInput): Promise<TrackerAddConnectionResult>;
    removeConnection(input: TrackerRemoveConnectionInput): Promise<TrackerRemoveConnectionResult>;
    testConnection(input: TrackerTestConnectionInput): Promise<TrackerTestConnectionResult>;
    search(input: TrackerSearchInput): Promise<TrackerSearchResult>;
    fetchIssue(input: TrackerFetchIssueInput): Promise<TrackerFetchIssueResult>;
    listTransitions(input: {
        connectionId: string;
        externalId: string;
    }): Promise<{
        ok: true;
        transitions: TrackerTransition[];
    } | {
        ok: false;
        error: ReturnType<typeof toTrackerError>;
    }>;
};
export type TrackerWriteBackIpcDeps = {
    getConfig(connectionId: string): Promise<TrackerWriteBackConfig>;
    setConfig(connectionId: string, config: TrackerWriteBackConfig): Promise<void>;
    resolveSampleIssue(workspaceRoot: string, connectionId: string): Promise<{
        externalId: string;
        nativeKey: string;
    } | null>;
};
export type TrackerWriteBackNoticeDeps = {
    listNotices(): Promise<TrackerWriteBackNotice[]>;
    retryConnection(connectionId: string): Promise<TrackerWriteBackNotice[]>;
};
export declare function createTrackerWriteBackNoticeDeps(runtime: TrackerWriteBackRuntime): TrackerWriteBackNoticeDeps;
export type TrackerMaterializeHandler = (input: TrackerMaterializeInput) => Promise<TrackerMaterializeResult>;
export declare function registerTrackerIpc(ipcMain: IpcMain, service?: TrackerIpcService, materialize?: TrackerMaterializeHandler, writeBack?: TrackerWriteBackIpcDeps, writeBackNotices?: TrackerWriteBackNoticeDeps): void;
