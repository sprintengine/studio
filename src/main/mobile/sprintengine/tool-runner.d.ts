export type SprintEngineToolInvocation = {
    args: string[];
    cwd: string;
};
export type SprintEngineToolExecutionResult = {
    exitCode: number | null;
    stdout: string;
    stderr: string;
};
export type SprintEngineToolExecutor = (invocation: SprintEngineToolInvocation) => Promise<SprintEngineToolExecutionResult>;
export declare function createSprintEngineToolExecutor(sprintEngineToolPath: string): SprintEngineToolExecutor;
export declare function defaultSprintEngineToolPath(): string;
export declare function parseToolJson(stdout: string): {
    ok: boolean;
    data?: unknown;
    message?: string;
    error?: string;
};
export declare function redactToolArgs(args: string[]): string[];
