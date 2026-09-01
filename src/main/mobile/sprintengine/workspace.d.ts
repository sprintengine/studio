import { type ValidSprintEngineStatePath } from './state-path';
export declare function resolveStateForSprintEngine(input: {
    sprintEngineId: string;
    statePaths: string[];
    workspaceRoot: string;
    allowedWorkspaceRoots: string[];
}): Promise<ValidSprintEngineStatePath>;
export declare function assertExpectedSnapshotVersion(input: {
    expectedSnapshotVersion?: string;
    statePath: string;
}): Promise<void>;
export declare function validateMobileWorkspacePath(input: {
    workspacePath: string;
    allowedWorkspaceRoots: string[];
    workspaceRootCandidates?: string[];
}): Promise<string>;
