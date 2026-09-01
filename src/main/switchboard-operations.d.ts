import type { SwitchboardAddCommentInput, SwitchboardCancelTaskInput, SwitchboardClaimTaskInput, SwitchboardClaimTaskResult, SwitchboardCreateTaskInput, SwitchboardExecutionLogsInput, SwitchboardExecutionLogsResult, SwitchboardExecutionStatusInput, SwitchboardExecutionStatusResult, SwitchboardImportItem, SwitchboardImportItemResult, SwitchboardInitApiResult, SwitchboardMoveTaskInput, SwitchboardMutationResult, SwitchboardPromoteInboxTaskInput, SwitchboardPublishTaskInput, SwitchboardReadResult, SwitchboardRecoverLockInput, SwitchboardRecoverLockResult, SwitchboardRequeueTaskInput, SwitchboardUpdateTaskInput, WatchtowerRunListResult, WatchtowerRunResult, WatchtowerStartReviewInput, WatchtowerStartTriageInput } from '../shared/switchboard';
export declare function initializeSwitchboard(input: {
    workspaceRoot: string;
}): Promise<SwitchboardInitApiResult>;
export declare function readAllSwitchboardTasks(input: {
    workspaceRoot: string;
}): Promise<SwitchboardReadResult>;
export declare function createSwitchboardTask(input: SwitchboardCreateTaskInput): Promise<SwitchboardMutationResult>;
export declare function importSwitchboardItem(workspaceRoot: string, item: SwitchboardImportItem): Promise<SwitchboardImportItemResult>;
export declare function updateSwitchboardTask(input: SwitchboardUpdateTaskInput): Promise<SwitchboardMutationResult>;
export declare function moveSwitchboardTask(input: SwitchboardMoveTaskInput): Promise<SwitchboardMutationResult>;
export declare function promoteSwitchboardInboxTask(input: SwitchboardPromoteInboxTaskInput): Promise<SwitchboardMutationResult>;
export declare function cancelSwitchboardTask(input: SwitchboardCancelTaskInput): Promise<SwitchboardMutationResult>;
export declare function addSwitchboardComment(input: SwitchboardAddCommentInput): Promise<SwitchboardMutationResult>;
export declare function claimSwitchboardTask(input: SwitchboardClaimTaskInput): Promise<SwitchboardClaimTaskResult>;
export declare function publishSwitchboardTask(input: SwitchboardPublishTaskInput): Promise<SwitchboardMutationResult>;
export declare function recoverSwitchboardLock(input: SwitchboardRecoverLockInput): Promise<SwitchboardRecoverLockResult>;
export declare function requeueSwitchboardTask(input: SwitchboardRequeueTaskInput): Promise<SwitchboardMutationResult>;
export declare function getSwitchboardExecutionStatus(input: SwitchboardExecutionStatusInput): Promise<SwitchboardExecutionStatusResult>;
export declare function getSwitchboardExecutionLogs(input: SwitchboardExecutionLogsInput): Promise<SwitchboardExecutionLogsResult>;
export declare function startWatchtowerReview(input: WatchtowerStartReviewInput): Promise<WatchtowerRunResult>;
export declare function startWatchtowerTriage(input: WatchtowerStartTriageInput): Promise<WatchtowerRunResult>;
export declare function getWatchtowerRun(input: {
    workspaceRoot: string;
    runId: string;
}): Promise<WatchtowerRunResult>;
export declare function listWatchtowerRuns(workspaceRoot: string): Promise<WatchtowerRunListResult>;
