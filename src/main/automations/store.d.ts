import type { AutomationDefinition, AutomationRun } from '../../shared/automations/contracts';
export declare const AUTOMATIONS_STORE_DIRECTORY = ".multi-code/automations";
export declare const AUTOMATION_RUN_HISTORY_LIMIT = 50;
export type AutomationStoreProblemCode = 'already_exists' | 'invalid_id' | 'invalid_json' | 'invalid_payload' | 'missing' | 'read_failed' | 'write_failed';
export type AutomationStoreProblem = {
    code: AutomationStoreProblemCode;
    path: string;
    message: string;
};
export type AutomationStoreReadResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: AutomationStoreProblem;
};
export type AutomationStoreListResult<T> = {
    ok: true;
    values: T[];
} | {
    ok: false;
    errors: AutomationStoreProblem[];
};
export type AutomationStoreWriteResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: AutomationStoreProblem;
};
export type AutomationStoreDeleteResult = {
    ok: true;
} | {
    ok: false;
    error: AutomationStoreProblem;
};
export type AutomationStoreLock = {
    ownerId: string;
    acquiredAt: string;
    expiresAt: string;
};
export type AutomationStoreState = {
    nextRunAtByAutomationId: Record<string, string | null>;
    triggerEventDedupByAutomationId?: Record<string, Record<string, string>>;
    triggerBlockedReasonByAutomationId?: Record<string, string | null>;
    lock: AutomationStoreLock | null;
};
export declare class AutomationsStore {
    private readonly workspaceRoot;
    private readonly options;
    readonly rootPath: string;
    constructor(workspaceRoot: string, options?: {
        runHistoryLimit?: number;
    });
    createDefinition(definition: AutomationDefinition): Promise<AutomationStoreWriteResult<AutomationDefinition>>;
    updateDefinition(definition: AutomationDefinition): Promise<AutomationStoreWriteResult<AutomationDefinition>>;
    deleteDefinition(automationId: string): Promise<AutomationStoreDeleteResult>;
    getDefinition(automationId: string): Promise<AutomationStoreReadResult<AutomationDefinition>>;
    listDefinitions(): Promise<AutomationStoreListResult<AutomationDefinition>>;
    recordRun(run: AutomationRun): Promise<AutomationStoreWriteResult<AutomationRun>>;
    getRun(automationId: string, runId: string): Promise<AutomationStoreReadResult<AutomationRun>>;
    listRuns(automationId: string): Promise<AutomationStoreListResult<AutomationRun>>;
    private listRunsStrict;
    private listReadableRunsForWrite;
    readState(): Promise<AutomationStoreReadResult<AutomationStoreState | null>>;
    writeState(state: AutomationStoreState): Promise<AutomationStoreWriteResult<AutomationStoreState>>;
    private definitionsDirectory;
    private runsRootDirectory;
    private runsDirectory;
    private statePath;
    private definitionPath;
    private runPath;
    private safeId;
    private containedPath;
    private writeDefinition;
    private writeRun;
    private writeJson;
    private readDefinitionFile;
    private readRunFile;
    private readJson;
    private validateDefinition;
    private validateRun;
    private validateState;
    private pruneRunHistory;
    private problem;
    private projectRelativePath;
}
