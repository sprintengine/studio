import type { MobileControlCommand, MobileSprintEngineCommandResult } from '../sprintengine/command';
import { MobileSprintEngineSnapshotService } from '../sprintengine/snapshot';
export declare function dispatchSnapshotRequest(input: {
    command: MobileControlCommand;
    snapshotService: MobileSprintEngineSnapshotService;
    desktopSessionId: string;
    statePathsProvider: () => Promise<string[]>;
    workspaceRootsProvider?: () => Promise<string[]>;
}): Promise<MobileSprintEngineCommandResult>;
