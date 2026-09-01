import type { IpcMain } from 'electron';
import type { SwitchboardAddCommentInput, SwitchboardCancelTaskInput, SwitchboardClaimTaskInput, SwitchboardClaimTaskResult, SwitchboardCreateTaskInput, SwitchboardExecutionLogsInput, SwitchboardExecutionLogsResult, SwitchboardExecutionStatusInput, SwitchboardExecutionStatusResult, SwitchboardInitApiResult, SwitchboardImportResult, SwitchboardMoveTaskInput, SwitchboardMutationResult, SwitchboardPromoteInboxTaskInput, SwitchboardPublishTaskInput, SwitchboardReadResult, SwitchboardRecoverLockInput, SwitchboardRecoverLockResult, SwitchboardRequeueTaskInput, SwitchboardRunnerResult, SwitchboardRunnerStartInput, SwitchboardRunnerWorkspaceInput, SwitchboardStopExecutionInput, SwitchboardStopExecutionResult, SwitchboardUpdateTaskInput, WatchtowerRunListResult, WatchtowerRunResult, WatchtowerStartReviewInput, WatchtowerStartTriageInput } from '../../shared/switchboard';
type SwitchboardIpcDependencies = {
    initialize(input: {
        workspaceRoot: string;
    }): Promise<SwitchboardInitApiResult>;
    readAll(input: {
        workspaceRoot: string;
    }): Promise<SwitchboardReadResult>;
    createTask(input: SwitchboardCreateTaskInput): Promise<SwitchboardMutationResult>;
    updateTask(input: SwitchboardUpdateTaskInput): Promise<SwitchboardMutationResult>;
    moveTask(input: SwitchboardMoveTaskInput): Promise<SwitchboardMutationResult>;
    promoteInboxTask(input: SwitchboardPromoteInboxTaskInput): Promise<SwitchboardMutationResult>;
    cancelTask(input: SwitchboardCancelTaskInput): Promise<SwitchboardMutationResult>;
    addComment(input: SwitchboardAddCommentInput): Promise<SwitchboardMutationResult>;
    claimTask(input: SwitchboardClaimTaskInput): Promise<SwitchboardClaimTaskResult>;
    publishTask(input: SwitchboardPublishTaskInput): Promise<SwitchboardMutationResult>;
    recoverLock(input: SwitchboardRecoverLockInput): Promise<SwitchboardRecoverLockResult>;
    requeueTask(input: SwitchboardRequeueTaskInput): Promise<SwitchboardMutationResult>;
    startRunner(input: SwitchboardRunnerStartInput): Promise<SwitchboardRunnerResult>;
    pauseRunner(workspaceRoot: string): Promise<SwitchboardRunnerResult>;
    resumeRunner(input: SwitchboardRunnerWorkspaceInput): Promise<SwitchboardRunnerResult>;
    stopRunner(workspaceRoot: string): Promise<SwitchboardRunnerResult>;
    tickRunner(input: SwitchboardRunnerWorkspaceInput): Promise<SwitchboardRunnerResult>;
    getRunnerState(input?: string | SwitchboardRunnerWorkspaceInput): Promise<SwitchboardRunnerResult>;
    stopExecution(input: SwitchboardStopExecutionInput): Promise<SwitchboardStopExecutionResult>;
    getExecutionStatus(input: SwitchboardExecutionStatusInput): Promise<SwitchboardExecutionStatusResult>;
    getExecutionLogs(input: SwitchboardExecutionLogsInput): Promise<SwitchboardExecutionLogsResult>;
    startWatchtowerReview(input: WatchtowerStartReviewInput): Promise<WatchtowerRunResult>;
    startWatchtowerTriage(input: WatchtowerStartTriageInput): Promise<WatchtowerRunResult>;
    getWatchtowerRun(input: {
        workspaceRoot: string;
        runId: string;
    }): Promise<WatchtowerRunResult>;
    listWatchtowerRuns(workspaceRoot: string): Promise<WatchtowerRunListResult>;
    importGitHubIssues(workspaceRoot: string): Promise<SwitchboardImportResult>;
    importJiraIssues(workspaceRoot: string): Promise<SwitchboardImportResult>;
};
export declare function registerSwitchboardIpc(ipcMain: IpcMain, deps: SwitchboardIpcDependencies): void;
export {};
