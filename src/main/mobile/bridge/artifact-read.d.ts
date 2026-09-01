import type { MobileControlCommand, MobileSprintEngineCommandResult } from '../sprintengine/command';
import { MobileSprintEngineSnapshotService } from '../sprintengine/snapshot';
export declare function dispatchArtifactRead(input: {
    command: MobileControlCommand;
    snapshotService: MobileSprintEngineSnapshotService;
    desktopSessionId: string;
    statePathsProvider: () => Promise<string[]>;
}): Promise<MobileSprintEngineCommandResult>;
