import type { IpcMain } from 'electron';
import type { SprintEngineArtifactCommandResult, SprintEngineMcpReadResult, SprintEngineProjectionReadResult, SprintEngineRegistryRoleReadInput, SprintEngineRegistryRolesReadInput, SprintEngineRosterRuntimeInput, SprintEngineRosterEnableInput, SprintEngineRunnerSetInput, SprintEngineStateInitializeInput, SprintEngineTaskCommentInput, SprintEngineTaskCreateInput, SprintEngineTaskResolveInput, SprintEngineTaskStatusSetInput, SprintEngineTaskUpdateInput, SprintEngineTaskWorktreeInput, SprintEngineTaskWorktreeResult } from '../../shared/electron-api';
import type { SprintEngineTokenUsageReport } from '../../shared/sprintengine-token-usage';
import type { SprintRunSummary } from '../../shared/sprintengine/runSummary';
export type SprintEngineArtifactOpenPayload = {
    statePath: string;
    artifactPath: string;
};
export type SprintEngineArtifactReviewPayload = {
    statePath: string;
    artifactId: string;
    feedback?: string;
};
export type SprintEngineVcsPayload = {
    statePath: string;
};
export type SprintEngineVcsMergePayload = {
    statePath: string;
    /**
     * The declared project whose pull request to merge (MC-1612). Omitted merges the
     * run's own project, which is the only one a single-project run has.
     */
    repo?: string;
};
export type SprintEngineRunsListPayload = {
    roots: string[];
};
export type SprintEngineProjectionReadPayload = {
    statePath: string;
    knownToken?: string;
};
export type SprintEngineArtifactReviewAction = 'approve' | 'request-changes';
export type SprintEngineArtifactReviewMode = 'user' | 'auto-run';
type SprintEngineIpcDependencies = {
    openArtifact(payload: SprintEngineArtifactOpenPayload): Promise<SprintEngineArtifactCommandResult>;
    reviewArtifact(payload: SprintEngineArtifactReviewPayload, action: SprintEngineArtifactReviewAction, mode: SprintEngineArtifactReviewMode): Promise<SprintEngineArtifactCommandResult>;
    initializeSprintEngineState(payload: SprintEngineStateInitializeInput): Promise<SprintEngineArtifactCommandResult>;
    updateTask(payload: SprintEngineTaskUpdateInput): Promise<SprintEngineArtifactCommandResult>;
    createTask(payload: SprintEngineTaskCreateInput): Promise<SprintEngineArtifactCommandResult>;
    commentTask(payload: SprintEngineTaskCommentInput): Promise<SprintEngineArtifactCommandResult>;
    resolveTaskInput(payload: SprintEngineTaskResolveInput): Promise<SprintEngineArtifactCommandResult>;
    setTaskStatus(payload: SprintEngineTaskStatusSetInput): Promise<SprintEngineArtifactCommandResult>;
    setRunnerMode(payload: SprintEngineRunnerSetInput): Promise<SprintEngineArtifactCommandResult>;
    cancelRun(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>;
    createPullRequest(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>;
    mergePullRequest(payload: SprintEngineVcsMergePayload): Promise<SprintEngineArtifactCommandResult>;
    refreshPullRequestStatus(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>;
    ensureTaskWorktree(payload: SprintEngineTaskWorktreeInput): Promise<SprintEngineTaskWorktreeResult>;
    setRoleRuntime(payload: SprintEngineRosterRuntimeInput): Promise<SprintEngineArtifactCommandResult>;
    enableRole(payload: SprintEngineRosterEnableInput): Promise<SprintEngineArtifactCommandResult>;
    readProjection(payload: SprintEngineProjectionReadPayload): Promise<SprintEngineProjectionReadResult>;
    readRegistryRoles(payload: SprintEngineRegistryRolesReadInput): Promise<SprintEngineMcpReadResult>;
    readRegistryRole(payload: SprintEngineRegistryRoleReadInput): Promise<SprintEngineMcpReadResult>;
    summarizeFeedback(payload: SprintEngineProjectionReadPayload): Promise<SprintEngineMcpReadResult>;
    readTokenUsage(payload: SprintEngineVcsPayload): Promise<SprintEngineTokenUsageReport>;
    listRuns(payload: SprintEngineRunsListPayload): Promise<SprintRunSummary[]>;
};
export declare function registerSprintEngineIpc(ipcMain: IpcMain, deps: SprintEngineIpcDependencies): void;
export {};
