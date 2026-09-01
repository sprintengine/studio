import type { SwitchboardReadResult, SwitchboardRunnerResult, WatchtowerRunListResult } from '../../../shared/switchboard';
import type { MobileControlCommandType, MobileControlSnapshot, MobileControlSprintEngineSnapshot as MobileSprintEngineSnapshot, MobileControlTaskSnapshot as MobileSprintEngineTaskSnapshot, MobileControlArtifactSnapshot as MobileSprintEngineArtifactSnapshot, MobileControlWorkspaceSnapshot as MobileWorkspaceSnapshot, MobileControlTaskCommentSummary as MobileSprintEngineCommentSummary, MobileControlRecordedArtifactSummary as MobileSprintEngineRecordedArtifactSummary, MobileSnapshotCollection } from '../../../shared/mobile-control/protocol';
import { type RoleCatalogReader } from './role-catalog';
export type { MobileControlSnapshot, MobileSprintEngineSnapshot, MobileSprintEngineTaskSnapshot, MobileSprintEngineArtifactSnapshot, MobileWorkspaceSnapshot, MobileSprintEngineCommentSummary, MobileSprintEngineRecordedArtifactSummary, };
export declare const defaultMobileSnapshotCommands: readonly MobileControlCommandType[];
export type MobileSprintEngineSnapshotRequest = {
    desktopSessionId: string;
    statePaths: string[];
    workspaceRoots?: string[];
    commands?: MobileControlCommandType[];
    generatedAt?: string;
    include?: MobileSnapshotCollection[];
};
type MobileSprintEngineSnapshotListener = (snapshot: MobileControlSnapshot) => void;
export declare function sanitizeMobileSnapshotForRelay(snapshot: MobileControlSnapshot): MobileControlSnapshot;
type MobileSprintEngineSnapshotServiceOptions = {
    publishThrottleMs?: number;
    supportedCommands?: readonly MobileControlCommandType[];
    stateReaders?: Partial<DesktopWorkspaceStateReaders>;
};
type DesktopWorkspaceStateReaders = {
    readSwitchboardTasks(input: {
        workspaceRoot: string;
    }): Promise<SwitchboardReadResult>;
    getSwitchboardRunnerState(input: string): Promise<SwitchboardRunnerResult>;
    listWatchtowerRuns(workspaceRoot: string): Promise<WatchtowerRunListResult>;
    readRoleCatalog: RoleCatalogReader;
};
export declare class MobileSprintEngineSnapshotService {
    private readonly listeners;
    private readonly publishThrottleMs;
    private lastPublishedAt;
    private pendingRequest;
    private publishTimer;
    private readonly stateReaders;
    private readonly supportedCommands;
    constructor(options?: MobileSprintEngineSnapshotServiceOptions);
    subscribe(listener: MobileSprintEngineSnapshotListener): () => void;
    readSnapshot(request: MobileSprintEngineSnapshotRequest): Promise<MobileControlSnapshot>;
    publishSnapshot(request: MobileSprintEngineSnapshotRequest): Promise<MobileControlSnapshot | null>;
    flushPendingSnapshot(): Promise<MobileControlSnapshot | null>;
    shutdown(): void;
    private emit;
    private clearPublishTimer;
    private readDesktopWorkspaceSnapshots;
}
export declare function readSprintEngineSnapshot(statePathInput: string): Promise<MobileSprintEngineSnapshot>;
