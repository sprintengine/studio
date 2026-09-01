import { spawn } from 'child_process';
export type SprintEngineMcpHubInfo = {
    url: string;
    adminToken: string;
    pid?: number;
};
export type SprintEngineMcpHubStatus = {
    state: 'stopped' | 'starting' | 'ready' | 'failed';
    url?: string;
    port?: number;
    pid?: number;
    activeRunCount: number;
    lastError?: string;
};
export type SprintEngineMcpRunRegistrationInput = {
    workspaceRoot: string;
    statePath: string;
    allowedRoots: string[];
    registryRoots: string[];
    userRoot?: string;
    actorId: string;
    workspaceId?: string;
    agentId?: string;
    role?: string;
    repo?: string;
    taskId?: string;
    knowledgeRoot?: string;
};
export type SprintEngineMcpRunRegistration = {
    runId: string;
    runToken: string;
    reused?: boolean;
};
export type SprintEngineMcpToolCallInput = {
    runId: string;
    toolName: string;
    arguments?: Record<string, unknown>;
};
export type SprintEngineMcpHubService = {
    ensureStarted(): Promise<SprintEngineMcpHubInfo>;
    ensureRunRegistered(input: SprintEngineMcpRunRegistrationInput): Promise<SprintEngineMcpRunRegistration>;
    callRunTool(input: SprintEngineMcpToolCallInput): Promise<unknown>;
    unregisterRun(runId: string): Promise<void>;
    stop(): Promise<void>;
    status(): SprintEngineMcpHubStatus;
};
export type SprintEngineMcpHubOptions = {
    runtimeRoot?: () => string | null;
    pythonCommand?: (runtimeRoot: string) => string;
    logMainPerfEvent?: (scope: string, event: string, payload: Record<string, unknown>) => void;
    spawnProcess?: typeof spawn;
};
export declare function createSprintEngineMcpHubService(options?: SprintEngineMcpHubOptions): SprintEngineMcpHubService;
export type SprintEngineMcpSpawnObserver = {
    onSpawnFailure(message: string): void;
};
export type GatedSprintEngineMcpHubService = SprintEngineMcpHubService & {
    /**
     * Called by the Sprint Engine capability module when it registers its
     * sidecar; transfers spawn ownership to the module. Until claimed, spawn
     * paths fail explicitly — so a disabled Sprint Engine module means the hub
     * process never starts, and callers see why instead of a silent fallback.
     */
    claimOwnership(observer: SprintEngineMcpSpawnObserver): void;
    /** Live module toggle: disabling immediately stops Python and closes the spawn gate. */
    setModuleEnabled(enabled: boolean): Promise<void>;
};
export declare function createGatedSprintEngineMcpHub(hub: SprintEngineMcpHubService): GatedSprintEngineMcpHubService;
