export declare const RUNNER_LOG_MAX_BYTES: number;
export declare const RUNNER_LOG_FILENAME = "runner-log.jsonl";
export type SprintEngineRunnerLogTarget = {
    /** The run's run.yaml path (absolute, or workspace-relative with folderPath). */
    statePath: string;
    folderPath?: string | null;
};
export declare function createSprintEngineRunnerLog(resolveTarget: (workspaceId: string) => SprintEngineRunnerLogTarget | null, nowIso?: () => string): {
    write(scope: string, event: string, payload: Record<string, unknown>): void;
};
