export type ValidSprintEngineStatePath = {
    statePath: string;
    teamDirectory: string;
    workspaceRoot: string;
};
export declare function validateSprintEngineStatePath(input: string): ValidSprintEngineStatePath;
